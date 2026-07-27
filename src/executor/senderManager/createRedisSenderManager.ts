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
// wallet is never visible in neither structure (which reconciliation on
// another pod would misread as a leak).
const CHECKOUT_WALLET_LUA = `
local address = redis.call('RPOP', KEYS[1])
if address then
    redis.call('ZADD', KEYS[2], ARGV[1], address)
end
return address
`

// Returns a wallet to the queue only if it isn't already queued (so
// concurrent releases and startup reconciliation can never duplicate an
// address) and clears its checked-out marker, atomically.
const RELEASE_WALLET_LUA = `
if redis.call('LPOS', KEYS[1], ARGV[1]) == false then
    redis.call('LPUSH', KEYS[1], ARGV[1])
end
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`

// Held wallets re-stamp their marker every refresh tick (covers arbitrarily
// long holds, e.g. quarantine), so a marker older than the staleness window
// means its holder is gone — crashed pod, or a release that never went
// through — and reconciliation may restore the wallet.
const CHECKED_OUT_REFRESH_MS = 60 * 1000
const CHECKED_OUT_STALE_MS = 30 * 60 * 1000

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

    const checkoutWallet = async () =>
        (await redis.eval(
            CHECKOUT_WALLET_LUA,
            2,
            senderManagerQueue,
            senderManagerCheckedOut,
            Date.now()
        )) as string | null

    const releaseWallet = (address: string) =>
        redis.eval(
            RELEASE_WALLET_LUA,
            2,
            senderManagerQueue,
            senderManagerCheckedOut,
            address
        )

    const updateAvailableMetric = async () => {
        try {
            metrics.walletsAvailable.set(await redis.llen(senderManagerQueue))
        } catch (err) {
            logger.warn({ err }, "failed to update walletsAvailable metric")
        }
    }

    // Reconcile Redis with the configured wallet list: seed on first boot,
    // restore wallets that are neither queued nor freshly checked out (a
    // crashed pod or a failed release otherwise drops them from rotation
    // forever, as the queue never re-seeds itself), and prune markers of
    // wallets that are no longer configured.
    const [queued, markers] = await Promise.all([
        redis.lrange(senderManagerQueue, 0, -1),
        redis.zrange(senderManagerCheckedOut, 0, -1, "WITHSCORES")
    ])
    const configured = new Set<string>(wallets.map((w) => w.address))
    const staleCutoff = Date.now() - CHECKED_OUT_STALE_MS
    const held = new Set<string>()
    for (let i = 0; i < markers.length; i += 2) {
        const address = markers[i]
        if (!configured.has(address)) {
            await redis.zrem(senderManagerCheckedOut, address)
            continue
        }
        if (Number(markers[i + 1]) >= staleCutoff) {
            held.add(address)
        }
    }
    const present = new Set([...queued, ...held])
    for (const wallet of wallets) {
        if (!present.has(wallet.address)) {
            await releaseWallet(wallet.address)
            logger.warn(
                { executor: wallet.address },
                "restored missing wallet to sender manager queue"
            )
        }
    }

    // Wallets held by this instance, and held wallets whose release failed
    // and is awaiting retry by the maintenance loop.
    const activeWallets = new Set<Account>()
    const pendingRelease = new Set<Account>()

    // Retry failed releases (a Redis outage can outlast markWalletProcessed's
    // retries) and re-stamp markers for held wallets so other pods'
    // reconciliation never mistakes a live hold for a leaked wallet.
    const maintain = async () => {
        for (const wallet of [...pendingRelease]) {
            try {
                await releaseWallet(wallet.address)
                pendingRelease.delete(wallet)
                activeWallets.delete(wallet)
                await updateAvailableMetric()
                logger.info(
                    { executor: wallet.address },
                    "returned wallet to sender manager queue after earlier failure"
                )
            } catch (err) {
                logger.error(
                    { err, executor: wallet.address },
                    "failed to return wallet to sender manager queue"
                )
            }
        }
        const now = Date.now()
        for (const wallet of [...activeWallets]) {
            try {
                await redis.zadd(senderManagerCheckedOut, now, wallet.address)
            } catch (err) {
                logger.error(
                    { err, executor: wallet.address },
                    "failed to refresh wallet checkout marker"
                )
            }
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
            // tracked so the maintenance loop, shutdown sweep and startup
            // reconciliation can restore it instead of leaking it from the
            // pool.
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await releaseWallet(wallet.address)
                    activeWallets.delete(wallet)
                    pendingRelease.delete(wallet)
                    await updateAvailableMetric()
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
