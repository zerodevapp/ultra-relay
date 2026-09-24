import type { RedisOptions } from "ioredis"

const REDIS_CONNECTION_OPTIONS: RedisOptions = {
    connectTimeout: 5_000,
    keepAlive: 10_000,
    // Keep reconnecting through primary promotion. Jitter spreads reconnects
    // across bundler instances, including once the backoff reaches its cap.
    retryStrategy: (attempt) => {
        const delay = Math.min(100 * 2 ** Math.min(attempt - 1, 5), 2_000)
        return Math.floor(delay * (0.5 + Math.random() / 2))
    }
}

export const REDIS_OPTIONS: RedisOptions = {
    ...REDIS_CONNECTION_OPTIONS,
    maxRetriesPerRequest: 20,
    // No commandTimeout: ioredis can execute an offline RPOP/ZMPOP even after
    // that deadline rejects its caller. Let the retry limit discard commands.
    // Reconnect when an established socket stops replying.
    socketTimeout: 10_000
}

// Bull restoration workers must survive outages and idle blocking reads.
// Do not apply ordinary command/socket deadlines to these connections.
export const REDIS_WORKER_OPTIONS: RedisOptions = {
    ...REDIS_CONNECTION_OPTIONS,
    enableReadyCheck: false,
    maxRetriesPerRequest: null
}
