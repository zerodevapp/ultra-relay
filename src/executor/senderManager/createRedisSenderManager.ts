import type { Metrics } from "@alto/utils"
import Redis from "ioredis"
import type { Account } from "viem"
import { getAvailableWallets } from "."
import { getRedisKeys } from "../../cli/config/redisKeys"
import type { AltoConfig } from "../../createConfig"
import type { SenderManager } from "../senderManager"

const delay = async (delay: number) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
}

// Atomically pops a wallet and stamps its checked-out marker, so a held
// wallet is never visible in neither structure (which the restore scan on
// another pod would misread as a leak).
export const CHECKOUT_WALLET_LUA = `
local address = redis.call('RPOP', KEYS[1])
if address then
    redis.call('ZADD', KEYS[2], ARGV[1], address)
end
return address
`

// Ownership-conditional release: the marker is the ownership token (checkout
// always stamps it), so a release only pushes if this holder's marker still
// exists. Retrying after a client-side timeout whose eval actually reached
// the server is then a no-op (ZREM == 0) instead of double-queueing a wallet
// another pod has since checked out.
export const RELEASE_WALLET_LUA = `
if redis.call('ZREM', KEYS[2], ARGV[1]) == 1 then
    if redis.call('LPOS', KEYS[1], ARGV[1]) == false then
        redis.call('LPUSH', KEYS[1], ARGV[1])
    end
    return 1
end
return 0
`

// Leak restore: re-validates inside the script (atomically vs concurrent
// checkouts/restores) that the wallet is not queued and has no fresh marker
// before pushing. ARGV[2] is the stale cutoff timestamp.
export const RESTORE_WALLET_LUA = `
if redis.call('LPOS', KEYS[1], ARGV[1]) ~= false then
    return 0
end
local score = redis.call('ZSCORE', KEYS[2], ARGV[1])
if score and tonumber(score) >= tonumber(ARGV[2]) then
    return 0
end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('LPUSH', KEYS[1], ARGV[1])
return 1
`

// Held wallets re-stamp their marker every refresh tick (covers arbitrarily
// long holds, e.g. quarantine), so a marker older than the staleness window
// means its holder is gone — crashed pod, or a release that never went
// through. A wallet must additionally be observed continuously missing for
// the grace period before restore, so holders whose re-stamps were blocked
// (e.g. a Redis OOM window) or old-code pods during a rolling deploy get
// time to reassert ownership before anyone re-queues their wallet.
const CHECKED_OUT_REFRESH_MS = 60 * 1000
const CHECKED_OUT_STALE_MS = 30 * 60 * 1000
const RESTORE_GRACE_MS = 10 * 60 * 1000

export const createRedisSenderManager = async ({
    config,
    metrics,
    redisEndpoint
}: {
    config: AltoConfig
    metrics: Metrics
    redisEndpoint: string
}): Promise<SenderManager> => {
    const wallets = getAvailableWallets(config)
    metrics.walletsTotal.set(wallets.length)
    metrics.walletsAvailable.set(wallets.length)
    const logger = config.getLogger(
        { module: "redis-sender-manager" },
        {
            level: config.executorLogLevel || config.logLevel
        }
    )

    const redis = new Redis(redisEndpoint)
    const { senderManagerQueue, senderManagerCheckedOut } = getRedisKeys(config)
    const configured = new Set<string>(wallets.map((w) => w.address))

    const checkoutWallet = async () =>
        (await redis.eval(
            CHECKOUT_WALLET_LUA,
            2,
            senderManagerQueue,
            senderManagerCheckedOut,
            Date.now()
        )) as string | null

    const releaseWallet = async (address: string) =>
        (await redis.eval(
            RELEASE_WALLET_LUA,
            2,
            senderManagerQueue,
            senderManagerCheckedOut,
            address
        )) as number

    const restoreWallet = async (address: string) =>
        (await redis.eval(
            RESTORE_WALLET_LUA,
            2,
            senderManagerQueue,
            senderManagerCheckedOut,
            address,
            Date.now() - CHECKED_OUT_STALE_MS
        )) as number

    const updateAvailableMetric = async () => {
        try {
            metrics.walletsAvailable.set(await redis.llen(senderManagerQueue))
        } catch (err) {
            logger.warn({ err }, "failed to update walletsAvailable metric")
        }
    }

    const readPoolState = async () => {
        const [queued, markers] = await Promise.all([
            redis.lrange(senderManagerQueue, 0, -1),
            redis.zrange(senderManagerCheckedOut, 0, -1, "WITHSCORES")
        ])
        const markerScores = new Map<string, number>()
        for (let i = 0; i < markers.length; i += 2) {
            markerScores.set(markers[i], Number(markers[i + 1]))
        }
        return { queued, markerScores }
    }

    // Boot: prune leftovers of wallets that are no longer configured, and
    // seed the pool on genuine first boot (both structures empty). Restores
    // of leaked wallets are deliberately NOT done at boot — they run in the
    // maintenance loop behind the grace period. Never fail boot over Redis:
    // the maintenance loop heals whatever this missed.
    try {
        const { queued, markerScores } = await readPoolState()
        for (const address of queued) {
            if (!configured.has(address)) {
                await redis.lrem(senderManagerQueue, 0, address)
                logger.warn(
                    { executor: address },
                    "pruned unconfigured wallet from sender manager queue"
                )
            }
        }
        for (const address of markerScores.keys()) {
            if (!configured.has(address)) {
                await redis.zrem(senderManagerCheckedOut, address)
            }
        }
        const anyConfiguredPresent =
            queued.some((address) => configured.has(address)) ||
            [...markerScores.keys()].some((address) => configured.has(address))
        if (!anyConfiguredPresent) {
            for (const wallet of wallets) {
                await restoreWallet(wallet.address)
            }
            logger.info("seeded sender manager queue")
        }
    } catch (err) {
        logger.error(
            { err },
            "sender manager boot reconciliation failed, maintenance loop will retry"
        )
    }

    // Wallets held by this instance, and held wallets whose release failed
    // and is awaiting retry by the maintenance loop.
    const activeWallets = new Set<Account>()
    const pendingRelease = new Set<Account>()
    // First time each configured wallet was observed missing from both the
    // queue and fresh markers; restore happens only after the grace period.
    const missingSince = new Map<string, number>()

    const maintain = async () => {
        // Retry releases that failed (a Redis outage can outlast
        // markWalletProcessed's retries).
        for (const wallet of [...pendingRelease]) {
            try {
                const released = await releaseWallet(wallet.address)
                pendingRelease.delete(wallet)
                activeWallets.delete(wallet)
                await updateAvailableMetric()
                if (released === 1) {
                    logger.info(
                        { executor: wallet.address },
                        "returned wallet to sender manager queue after earlier failure"
                    )
                } else {
                    logger.warn(
                        { executor: wallet.address },
                        "wallet was no longer owned at release retry"
                    )
                }
            } catch (err) {
                logger.error(
                    { err, executor: wallet.address },
                    "failed to return wallet to sender manager queue"
                )
            }
        }

        // Re-stamp markers for held wallets so other pods' restore scans
        // never mistake a live hold for a leak. Skip pending releases: their
        // marker may already belong to a new holder.
        const now = Date.now()
        for (const wallet of [...activeWallets]) {
            if (pendingRelease.has(wallet)) {
                continue
            }
            try {
                await redis.zadd(senderManagerCheckedOut, now, wallet.address)
            } catch (err) {
                logger.error(
                    { err, executor: wallet.address },
                    "failed to refresh wallet checkout marker"
                )
            }
        }

        // Only trust marker staleness while Redis writes work: during a
        // write outage (e.g. OOM) holders cannot re-stamp their markers, so
        // stale markers say nothing about liveness. The probe shares the
        // writes' fate; on failure the missing-clock resets, giving holders
        // a full grace period after recovery to reassert ownership.
        try {
            await redis.set(
                `${senderManagerQueue}:write-probe`,
                Date.now(),
                "PX",
                CHECKED_OUT_REFRESH_MS * 2
            )
        } catch (err) {
            missingSince.clear()
            logger.warn(
                { err },
                "redis writes unhealthy, skipping wallet restore scan"
            )
            return
        }

        // Restore wallets that have been continuously missing from both the
        // queue and fresh markers for the grace period — leaked by a crashed
        // pod or a release that never completed.
        try {
            const { queued, markerScores } = await readPoolState()
            const staleCutoff = Date.now() - CHECKED_OUT_STALE_MS
            const queuedSet = new Set(queued)
            for (const wallet of wallets) {
                const address = wallet.address
                const markerScore = markerScores.get(address)
                const missing =
                    !queuedSet.has(address) &&
                    (markerScore === undefined || markerScore < staleCutoff) &&
                    !activeWallets.has(wallet)
                if (!missing) {
                    missingSince.delete(address)
                    continue
                }
                const firstSeen = missingSince.get(address) ?? Date.now()
                missingSince.set(address, firstSeen)
                if (Date.now() - firstSeen < RESTORE_GRACE_MS) {
                    continue
                }
                if ((await restoreWallet(address)) === 1) {
                    logger.warn(
                        { executor: address },
                        "restored missing wallet to sender manager queue"
                    )
                    await updateAvailableMetric()
                }
                missingSince.delete(address)
            }
        } catch (err) {
            logger.error({ err }, "wallet restore scan failed")
        }
    }
    setInterval(() => {
        maintain().catch((err) =>
            logger.error({ err }, "wallet maintenance loop failed")
        )
    }, CHECKED_OUT_REFRESH_MS).unref()

    logger.info(
        `Created redis sender manager with queueName: ${senderManagerQueue}`
    )
    return {
        getAllWallets: () => [...wallets],
        getWallet: async () => {
            logger.trace("waiting for wallet ")

            let walletAddress: string | null = null

            while (!walletAddress) {
                walletAddress = await checkoutWallet()
                if (!walletAddress) {
                    await delay(100)
                }
            }

            const wallet = wallets.find((w) => w.address === walletAddress)

            // should never happen
            if (!wallet) {
                throw new Error("wallet not found")
            }

            activeWallets.add(wallet)

            logger.trace(
                { executor: wallet.address },
                "got wallet from sender manager"
            )

            await updateAvailableMetric()

            return wallet
        },
        markWalletProcessed: async (wallet: Account) => {
            if (!activeWallets.has(wallet)) {
                logger.warn(
                    { executor: wallet.address },
                    "Attempted to mark a wallet as processed that wasn't active"
                )
                return
            }

            // Return the wallet to Redis BEFORE dropping local bookkeeping
            // and never throw — if the push fails the wallet must stay
            // tracked so the maintenance loop, shutdown sweep and the
            // restore scan can recover it instead of leaking it from the
            // pool.
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const released = await releaseWallet(wallet.address)
                    activeWallets.delete(wallet)
                    pendingRelease.delete(wallet)
                    await updateAvailableMetric()
                    if (released === 0) {
                        logger.warn(
                            { executor: wallet.address },
                            "wallet was no longer owned at release"
                        )
                    }
                    return
                } catch (err) {
                    logger.error(
                        { err, executor: wallet.address, attempt },
                        "failed to return wallet to sender manager queue"
                    )
                    await delay(1000)
                }
            }
            pendingRelease.add(wallet)
        },
        getActiveWallets: () => {
            return [...activeWallets]
        }
    }
}
