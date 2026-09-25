import type { Metrics } from "@alto/utils"
import Redis from "ioredis"
import type { Account } from "viem"
import { getAvailableWallets } from "."
import { getRedisKeys } from "../../cli/config/redisKeys"
import type { AltoConfig } from "../../createConfig"
import type { SenderManager } from "../senderManager"

async function createRedisQueue({
    redis,
    name,
    entries
}: {
    redis: Redis
    name: string
    entries: string[]
}) {
    const hasElements = await redis.llen(name)

    // Ensure queue is populated on startup
    // Avoids race case where queue is populated twice due to multi (atomic txs)
    if (hasElements === 0) {
        const multi = redis.multi()
        multi.del(name)
        multi.rpush(name, ...entries)
        await multi.exec()
    }

    return {
        llen: () => redis.llen(name),
        pop: () => redis.rpop(name),
        push: (entry: string) => redis.lpush(name, entry)
    }
}

// The popped address is not one of this instance's keys: another instance
// shares the queue (e.g. during an executor-key rotation). The address has
// already been popped and is not pushed back.
export class WalletNotFoundError extends Error {
    readonly address: string

    constructor(address: string) {
        super(`wallet not found: ${address}`)
        this.name = "WalletNotFoundError"
        this.address = address
    }
}

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
    const redisQueueName = getRedisKeys(config).senderManagerQueue
    const redisQueue = await createRedisQueue({
        redis,
        name: redisQueueName,
        entries: wallets.map((w) => w.address)
    })

    // Track active wallets for this instance
    const activeWallets = new Set<Account>()

    logger.info(
        `Created redis sender manager with queueName: ${redisQueueName}`
    )
    return {
        getAllWallets: () => [...wallets],
        getWallet: async () => {
            logger.trace("waiting for wallet ")

            let walletAddress: string | null = null

            while (!walletAddress) {
                walletAddress = await redisQueue.pop()
                // Only back off when the pool is empty; a successful pop must
                // return immediately, it sits on the bundling critical path.
                if (!walletAddress) {
                    await delay(100)
                }
            }

            const wallet = wallets.find((w) => w.address === walletAddress)

            // Only when another instance's keys share the queue.
            if (!wallet) {
                throw new WalletNotFoundError(walletAddress)
            }

            activeWallets.add(wallet)

            logger.trace(
                { executor: wallet.address },
                "got wallet from sender manager"
            )

            // Metrics only; don't hold the bundle for the round-trip, and a
            // failed read isn't worth surfacing (pop on the same connection
            // just succeeded).
            redisQueue
                .llen()
                .then((len) => {
                    metrics.walletsAvailable.set(len)
                })
                .catch(() => {})

            return wallet
        },
        markWalletProcessed: async (wallet: Account) => {
            if (activeWallets.delete(wallet)) {
                await redisQueue.push(wallet.address)
                const len = await redisQueue.llen()
                metrics.walletsAvailable.set(len)
            } else {
                logger.warn(
                    { executor: wallet.address },
                    "Attempted to mark a wallet as processed that wasn't active"
                )
            }
        },
        getActiveWallets: () => {
            return [...activeWallets]
        }
    }
}
