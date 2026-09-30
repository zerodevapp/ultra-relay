import type { Metrics } from "@alto/utils"
import Redis, { type Result } from "ioredis"
import type { Account } from "viem"
import { getAvailableWallets } from "."
import { getRedisKeys } from "../../cli/config/redisKeys"
import type { AltoConfig } from "../../createConfig"
import type { SenderManager } from "../senderManager"

// Pods share a list of idle wallet addresses and a set of the addresses
// taken and not yet returned. List entries keep the form their pod wrote
// (checksummed); comparisons lowercase them, so a hand-pushed lowercase
// entry still matches. The in-use set holds lowercase addresses. Pods add
// addresses only while an operator-set marker says the pool is armed
// (ADR 0006).

// KEYS: pool list, in-use set. ARGV: this pod's addresses.
// Returns {entry or nil, pool length}. Scans the pool once: takes the first
// wallet this pod can sign for, drops extra copies of a wallet already in
// use, and pushes other pods' wallets back for their owners.
const TAKE_WALLET_SCRIPT = `
local own = {}
for i = 1, #ARGV do own[string.lower(ARGV[i])] = true end
local n = redis.call("LLEN", KEYS[1])
-- Validate both key types before RPOP can mutate the pool.
redis.call("SCARD", KEYS[2])
for _ = 1, n do
    local entry = redis.call("RPOP", KEYS[1])
    if not entry then break end
    local address = string.lower(entry)
    if redis.call("SISMEMBER", KEYS[2], address) == 1 then
        -- An extra copy of a wallet already in use: drop it.
    elseif own[address] then
        redis.call("SADD", KEYS[2], address)
        return {entry, redis.call("LLEN", KEYS[1])}
    else
        redis.call("LPUSH", KEYS[1], entry)
    end
end
return {false, redis.call("LLEN", KEYS[1])}
`

// KEYS: pool list, in-use set. ARGV[1]: the wallet's address.
// Returns {released (0 or 1), pool length}. This is not safe to replay
// after reacquisition: the local handle and no-replay policy are required.
const RETURN_WALLET_SCRIPT = `
local length = redis.call("LLEN", KEYS[1])
if redis.call("SREM", KEYS[2], string.lower(ARGV[1])) == 0 then
    return {0, length}
end
return {1, redis.call("LPUSH", KEYS[1], ARGV[1])}
`

// KEYS: pool list, in-use set, armed marker. ARGV: this pod's addresses.
// Adds each address that is neither in the pool nor in use, but only while
// the pool is armed: a missing marker means Redis lost its data, and adding
// then could hand out wallets that live pods still hold. Returns
// {armed (0 or 1), added addresses, pool length, in-use count,
// foreign address count}.
const RECONCILE_WALLETS_SCRIPT = `
-- Reads all three keys before any write, so a wrong type rejects first.
local armed = redis.call("GET", KEYS[3]) and 1 or 0
local present = {}
for _, entry in ipairs(redis.call("LRANGE", KEYS[1], 0, -1)) do
    present[string.lower(entry)] = true
end
for _, address in ipairs(redis.call("SMEMBERS", KEYS[2])) do
    present[address] = true
end
local own, added = {}, {}
for i = 1, #ARGV do
    local address = string.lower(ARGV[i])
    own[address] = true
    if armed == 1 and not present[address] then
        redis.call("LPUSH", KEYS[1], ARGV[i])
        present[address] = true
        added[#added + 1] = ARGV[i]
    end
end
local foreign = 0
for address in pairs(present) do
    if not own[address] then foreign = foreign + 1 end
end
return {armed, added, redis.call("LLEN", KEYS[1]), redis.call("SCARD", KEYS[2]), foreign}
`

declare module "ioredis" {
    interface RedisCommander<Context> {
        takeWallet(
            poolKey: string,
            inUseKey: string,
            ...ownAddresses: string[]
        ): Result<[string | null, number], Context>
        returnWallet(
            poolKey: string,
            inUseKey: string,
            address: string
        ): Result<[number, number], Context>
        reconcileWallets(
            poolKey: string,
            inUseKey: string,
            armedKey: string,
            ...ownAddresses: string[]
        ): Result<[number, string[], number, number, number], Context>
    }
}

// How often each pod re-adds its wallets that went missing from both keys.
const WALLET_SYNC_INTERVAL_MS = 5 * 60 * 1000

// ioredis rejects a command with this error, without writing it, while the
// connection is not ready. A return rejected this way provably never ran, so
// it waits for the next "ready" instead of stranding the wallet.
const NOT_SENT_ERROR =
    "Stream isn't writeable and enableOfflineQueue options is false"

const delay = async (delay: number) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
}

export const createRedisSenderManager = async ({
    config,
    metrics,
    redisEndpoint
}: {
    config: AltoConfig
    metrics: Metrics
    redisEndpoint: string
}): Promise<SenderManager> => {
    const walletsByAddress = new Map(
        getAvailableWallets(config).map((w) => [w.address.toLowerCase(), w])
    )
    const wallets = [...walletsByAddress.values()]
    if (wallets.length === 0) {
        throw new Error("Redis sender manager requires an eligible wallet")
    }
    metrics.walletsTotal.set(wallets.length)
    const ownAddresses = wallets.map((w) => w.address)
    const logger = config.getLogger(
        { module: "redis-sender-manager" },
        {
            level: config.executorLogLevel || config.logLevel
        }
    )

    // No offline queue and no resend: a take or return whose reply was lost
    // may already have run, so replaying it could release a later checkout.
    const redis = new Redis(redisEndpoint, {
        lazyConnect: true,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 0
    })
    redis.defineCommand("takeWallet", {
        numberOfKeys: 2,
        lua: TAKE_WALLET_SCRIPT
    })
    redis.defineCommand("returnWallet", {
        numberOfKeys: 2,
        lua: RETURN_WALLET_SCRIPT
    })
    redis.defineCommand("reconcileWallets", {
        numberOfKeys: 3,
        lua: RECONCILE_WALLETS_SCRIPT
    })
    const {
        senderManagerQueue: poolKey,
        senderManagerInUse: inUseKey,
        senderManagerArmed: armedKey
    } = getRedisKeys(config)
    const reconcile = () =>
        redis.reconcileWallets(poolKey, inUseKey, armedKey, ...ownAddresses)

    await redis.connect().catch((err: unknown) => {
        redis.disconnect()
        throw err
    })

    // Adds this instance's wallets that are neither idle in the pool nor in
    // use (only while the pool is armed), so new keys join a pool that other
    // pods are already using.
    const [armed, added, poolSize, inUseCount, foreignCount] =
        await reconcile().catch((err: unknown) => {
            redis.disconnect()
            throw err
        })
    if (armed !== 1) {
        redis.disconnect()
        throw new Error(
            `executor wallet pool ${poolKey} is not armed; rebuild it with every pod stopped (ADR 0006)`
        )
    }
    metrics.walletsAvailable.set(poolSize)
    logger.info(
        {
            added,
            addedCount: added.length,
            poolSize,
            inUseCount,
            foreignCount
        },
        "reconciled executor wallet pool"
    )

    // Re-adds this instance's wallets that went missing from both keys while
    // it runs. Each run schedules the next, so runs never overlap; closing
    // the client ends the loop.
    let syncTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleSync = () => {
        syncTimer = setTimeout(async () => {
            try {
                const [armed, added, poolSize, inUseCount, foreignCount] =
                    await reconcile()
                metrics.walletsAvailable.set(poolSize)
                if (armed !== 1) {
                    logger.error(
                        { poolSize, inUseCount },
                        "executor wallet pool is not armed; added no wallets"
                    )
                } else if (added.length > 0) {
                    logger.warn(
                        {
                            added,
                            addedCount: added.length,
                            poolSize,
                            inUseCount,
                            foreignCount
                        },
                        "re-added missing executor wallets"
                    )
                }
            } catch (err) {
                logger.error({ err }, "executor wallet sync failed")
            }
            if (redis.status !== "end") {
                scheduleSync()
            }
        }, WALLET_SYNC_INTERVAL_MS)
        syncTimer.unref()
    }
    redis.once("end", () => clearTimeout(syncTimer))
    scheduleSync()

    // Track active wallets for this instance
    const activeWallets = new Set<Account>()
    // Returns ioredis rejected before sending; sent again on reconnect.
    const deferredReturns = new Set<Account>()

    const sendReturn = async (wallet: Account) => {
        try {
            const [released, poolLength] = await redis.returnWallet(
                poolKey,
                inUseKey,
                wallet.address
            )
            metrics.walletsAvailable.set(poolLength)
            if (released !== 1) {
                throw new Error("Active wallet has no in-use reservation")
            }
        } catch (err) {
            if (err instanceof Error && err.message === NOT_SENT_ERROR) {
                deferredReturns.add(wallet)
                logger.warn(
                    { executor: wallet.address },
                    "wallet return deferred until Redis reconnects"
                )
                return
            }
            logger.error(
                { err, executor: wallet.address },
                "wallet return failed; reservation requires inspection"
            )
            // Never retry an uncertain return or restore the handle.
            throw err
        }
    }

    redis.on("ready", () => {
        for (const wallet of [...deferredReturns]) {
            deferredReturns.delete(wallet)
            // sendReturn logs its own failures, and nothing awaits this send.
            sendReturn(wallet).catch(() => undefined)
        }
    })

    logger.info(`Created redis sender manager with queueName: ${poolKey}`)
    return {
        getAllWallets: () => [...wallets],
        getWallet: async () => {
            logger.trace("waiting for wallet ")

            let address: string | null = null

            while (!address) {
                const [taken, poolLength] = await redis.takeWallet(
                    poolKey,
                    inUseKey,
                    ...ownAddresses
                )
                metrics.walletsAvailable.set(poolLength)
                address = taken
                // Only back off when none of this instance's wallets is
                // free; a successful take sits on the bundling critical path.
                if (!address) {
                    await delay(100)
                }
            }

            const wallet = walletsByAddress.get(address.toLowerCase())
            // The take script only returns this instance's addresses.
            if (!wallet) {
                throw new Error(
                    `wallet pool returned an address this instance does not own: ${address}`
                )
            }

            // Object identity distinguishes this checkout from later ones.
            const checkout = { ...wallet }
            activeWallets.add(checkout)

            logger.trace(
                { executor: wallet.address },
                "got wallet from sender manager"
            )

            return checkout
        },
        markWalletProcessed: async (wallet: Account) => {
            if (activeWallets.delete(wallet)) {
                await sendReturn(wallet)
            } else {
                logger.warn(
                    { executor: wallet.address },
                    "Attempted to mark a wallet as processed that wasn't active"
                )
            }
        },
        getActiveWallets: () => {
            return [...activeWallets, ...deferredReturns]
        }
    }
}
