import Queue from "bull"
import Redis from "ioredis"
import StandaloneConnector from "ioredis/built/connectors/StandaloneConnector"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../createConfig"
import { createRedisOutstandingQueue } from "../store/createRedisOutstandingStore"
import { REDIS_WORKER_OPTIONS } from "./redis-options"

// Keep the real ioredis command/timer handling; only prevent network access.
const clients: Redis[] = []

beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(StandaloneConnector.prototype, "connect").mockImplementation(
        () => new Promise(() => {})
    )
    const connect = Redis.prototype.connect
    vi.spyOn(Redis.prototype, "connect").mockImplementation(function (
        this: Redis
    ) {
        clients.push(this)
        return connect.call(this)
    })
})

afterEach(() => {
    for (const client of clients) client.disconnect()
    clients.length = 0
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

function createStoreClient() {
    createRedisOutstandingQueue({
        config: { chainId: 1 } as AltoConfig,
        entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
        redisEndpoint: "redis://localhost:6379"
    })
    return clients[0]
}

describe("Redis outage policy", () => {
    it("keeps an offline pop pending until Redis executes or discards it", async () => {
        const client = createStoreClient()
        const result = client
            .rpop("wallets")
            .catch((error: Error) => error.message)

        await vi.advanceTimersByTimeAsync(10_000)

        expect(await Promise.race([result, Promise.resolve("pending")])).toBe(
            "pending"
        )
    })

    it("keeps reconnecting with jitter even after a long outage", () => {
        const retry = createStoreClient().options.retryStrategy
        vi.spyOn(Math, "random")
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0.99)

        const first = retry?.(1_000)
        const second = retry?.(1_000)

        expect(first).toBeGreaterThan(0)
        expect(second).toBeGreaterThan(first as number)
        expect(second).toBeLessThanOrEqual(2_000)
    })

    it("allows Bull blocking reads to wait through an outage", async () => {
        const queue = new Queue("redis-options-test", {
            createClient: () => new Redis(REDIS_WORKER_OPTIONS)
        })
        // Access the connections through Bull to exercise its option checks.
        const { bclient, eclient } = queue as unknown as {
            bclient: Redis
            eclient: Redis
        }
        expect(eclient.options.maxRetriesPerRequest).toBeNull()
        const result = bclient.brpop("restoration", 0).then(
            () => "completed",
            () => "failed"
        )

        await vi.advanceTimersByTimeAsync(60_000)

        expect(await Promise.race([result, Promise.resolve("pending")])).toBe(
            "pending"
        )
        expect(bclient.options.socketTimeout).toBeUndefined()
    })
})
