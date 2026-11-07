import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMinMaxQueue } from "."
import type { AltoConfig } from "../../createConfig"

// Set ALTO_TEST_REDIS_URL only to a disposable Redis to exercise the same
// contract against the real backend. Default unit runs stay network-free.
const { clients } = vi.hoisted(() => ({
    clients: [] as { quit: () => Promise<unknown>; disconnect: () => void }[]
}))
vi.mock("ioredis", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ioredis")>()
    const Backend = process.env.ALTO_TEST_REDIS_URL
        ? actual.Redis
        : (await import("ioredis-mock")).default
    class TestRedis extends Backend {
        constructor(endpoint: string) {
            super(endpoint)
            clients.push(this)
        }
    }
    return { ...actual, default: TestRedis, Redis: TestRedis }
})

const epoch = Date.UTC(2026, 0, 1)
// ioredis-mock truncates fractional score bounds; use whole-second clock steps.
const logger = { error: vi.fn() }

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(epoch)
})
afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.quit()))
    vi.useRealTimers()
})

describe.each(["memory", "redis"] as const)(
    "%s min/max fee cache",
    (backend) => {
        function makeQueue(allowZero = true, gasPriceExpiry = 20) {
            const config = {
                chainId: 82937461,
                gasPriceExpiry,
                enableHorizontalScaling: backend === "redis",
                redisEndpoint:
                    process.env.ALTO_TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
                redisKeyPrefix: `fee-cache-test-${randomUUID()}`,
                getLogger: () => logger
            } as unknown as AltoConfig
            return createMinMaxQueue({ config, keyPrefix: "fees", allowZero })
        }

        it("distinguishes an empty cache from a cached zero", async () => {
            const queue = makeQueue()
            expect(await queue.getLatestValue()).toBeNull()
            expect(await queue.getMinValue()).toBeNull()
            expect(await queue.getMaxValue()).toBeNull()
            await queue.saveValue(0n)
            expect(await queue.getLatestValue()).toBe(0n)
            expect(await queue.getMinValue()).toBe(0n)
            expect(await queue.getMaxValue()).toBe(0n)
        })

        it("preserves zero filtering for non-fee oracle queues", async () => {
            const queue = makeQueue(false)
            await queue.saveValue(0n)
            expect(await queue.getLatestValue()).toBeNull()
            await queue.saveValue(7n)
            vi.setSystemTime(epoch + 1_000)
            await queue.saveValue(0n)
            expect(await queue.getLatestValue()).toBe(7n)
            expect(await queue.getMinValue()).toBe(7n)
            expect(await queue.getMaxValue()).toBe(7n)
        })

        it("tracks min, max and latest through zero/positive transitions", async () => {
            const queue = makeQueue()
            await queue.saveValue(0n)
            vi.setSystemTime(epoch + 1_000)
            await queue.saveValue(7n)
            expect(await queue.getMinValue()).toBe(0n)
            expect(await queue.getMaxValue()).toBe(7n)
            expect(await queue.getLatestValue()).toBe(7n)
            vi.setSystemTime(epoch + 2_000)
            await queue.saveValue(0n)
            expect(await queue.getLatestValue()).toBe(0n)
            expect(await queue.getMaxValue()).toBe(7n)
        })

        it.each([
            [0n, 7n],
            [7n, 0n]
        ])("expires older %s on a later write of %s", async (older, newer) => {
            const queue = makeQueue()
            await queue.saveValue(older)
            vi.setSystemTime(epoch + 21_000)
            await queue.saveValue(newer)
            expect(await queue.getLatestValue()).toBe(newer)
            expect(await queue.getMinValue()).toBe(newer)
            expect(await queue.getMaxValue()).toBe(newer)
        })

        it("refreshes the lifetime when the same zero is observed again", async () => {
            const queue = makeQueue()
            await queue.saveValue(0n)
            vi.setSystemTime(epoch + 10_000)
            await queue.saveValue(0n)
            vi.setSystemTime(epoch + 21_000)
            expect(await queue.getLatestValue()).toBe(0n)
            expect(await queue.getMinValue()).toBe(0n)
            vi.setSystemTime(epoch + 31_000)
            await queue.saveValue(7n)
            expect(await queue.getLatestValue()).toBe(7n)
            expect(await queue.getMinValue()).toBe(7n)
            expect(await queue.getMaxValue()).toBe(7n)
        })

        it("honors a zero-second validity window on the next write", async () => {
            const queue = makeQueue(true, 0)
            await queue.saveValue(0n)
            expect(await queue.getLatestValue()).toBe(0n)
            vi.setSystemTime(epoch + 1_000)
            await queue.saveValue(7n)
            expect(await queue.getLatestValue()).toBe(7n)
            expect(await queue.getMinValue()).toBe(7n)
            expect(await queue.getMaxValue()).toBe(7n)
        })
    }
)
