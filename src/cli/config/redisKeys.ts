import type { AltoConfig } from "../../createConfig"

// Prefix for the mempool stores and gas-price queues. The default prefix keeps
// the legacy bare `<chainId>:` layout so deployments that never set
// --redis-key-prefix keep their existing keys; any explicit prefix namespaces
// everything, which lets two same-chain services share one Redis.
export const getRedisStorePrefix = (config: AltoConfig) => {
    const prefix = config.redisKeyPrefix
    if (!prefix || prefix === "alto") {
        return `${config.chainId}`
    }
    return `${prefix}:${config.chainId}`
}

export const getRedisKeys = (config: AltoConfig) => {
    const prefix = `${config.redisKeyPrefix}:${config.chainId}`

    return {
        // Mempool queue
        mempoolQueue: `${prefix}:outstanding-mempool`,

        // User operation receipt cache - returns just the key prefix for receipt cache
        userOpReceiptCachePrefix: `${prefix}:receipt-cache`,

        // User operation status
        userOpStatusQueue: `${prefix}:userop-status`,

        // Gas price queue
        gasPriceQueue: `${prefix}:gas-price`,

        // Sender manager queue
        senderManagerQueue: `${prefix}:sender-manager`
    }
}
