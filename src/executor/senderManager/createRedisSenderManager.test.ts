import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../../createConfig"
import { createRedisSenderManager } from "./createRedisSenderManager"

// Minimal in-memory stand-in for the four list commands the sender manager
// uses. Hand-rolled (not ioredis-mock) so fake timers can't interfere with
// command completion and so llen can be made to fail on demand. Wrapped in
// vi.hoisted because vi.mock factories run before module-level statements.
const { lists, calls, state, FakeRedis } = vi.hoisted(() => {
    const lists = new Map<string, string[]>()
    const calls = { rpop: 0, llen: 0 }
    const state = { failLlen: false }

    class FakeRedis {
        llen(name: string) {
            calls.llen++
            if (state.failLlen) return Promise.reject(new Error("llen boom"))
            return Promise.resolve(lists.get(name)?.length ?? 0)
        }
        rpop(name: string) {
            calls.rpop++
            return Promise.resolve(lists.get(name)?.pop() ?? null)
        }
        lpush(name: string, value: string) {
            const list = lists.get(name) ?? []
            list.unshift(value)
            lists.set(name, list)
            return Promise.resolve(list.length)
        }
        multi() {
            const ops: (() => void)[] = []
            const chain = {
                del: (name: string) => {
                    ops.push(() => lists.delete(name))
                    return chain
                },
                rpush: (name: string, ...values: string[]) => {
                    ops.push(() =>
                        lists.set(name, [...(lists.get(name) ?? []), ...values])
                    )
                    return chain
                },
                exec: () => {
                    for (const op of ops) op()
                    return Promise.resolve([])
                }
            }
            return chain
        }
    }

    return { lists, calls, state, FakeRedis }
})

vi.mock("ioredis", () => ({ default: FakeRedis, Redis: FakeRedis }))

const redisEndpoint = "redis://fake"
const wallets = [
    { address: "0x1111111111111111111111111111111111111111" },
    { address: "0x2222222222222222222222222222222222222222" }
]
const logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {} }
const config = {
    chainId: 42161,
    redisKeyPrefix: "test",
    executorPrivateKeys: wallets,
    getLogger: () => logger
} as unknown as AltoConfig
const metrics = {
    walletsTotal: { set() {} },
    walletsAvailable: { set() {} }
} as never

const flush = () => new Promise<void>((r) => queueMicrotask(r))

describe("createRedisSenderManager.getWallet", () => {
    beforeEach(() => {
        lists.clear()
        calls.rpop = 0
        calls.llen = 0
        state.failLlen = false
        // Only fake setTimeout: if getWallet awaited delay() on a successful
        // pop, the promise below could never settle and the test would hang.
        vi.useFakeTimers({ toFake: ["setTimeout"] })
    })
    afterEach(() => vi.useRealTimers())

    it("resolves without any timer when a wallet is available", async () => {
        const manager = await createRedisSenderManager({
            config,
            metrics,
            redisEndpoint
        })

        const wallet = await manager.getWallet()

        expect(wallets.map((w) => w.address)).toContain(wallet.address)
        expect(calls.rpop).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it("backs off 100ms between polls while the pool is empty, then resolves", async () => {
        const manager = await createRedisSenderManager({
            config,
            metrics,
            redisEndpoint
        })
        const first = await manager.getWallet()
        await manager.getWallet()
        calls.rpop = 0

        const pending = manager.getWallet()
        await flush()
        expect(calls.rpop).toBe(1) // first poll, empty

        await vi.advanceTimersByTimeAsync(99)
        expect(calls.rpop).toBe(1) // still sleeping, no busy loop

        await vi.advanceTimersByTimeAsync(1)
        expect(calls.rpop).toBe(2) // one retry exactly at 100ms

        await manager.markWalletProcessed(first)
        await vi.advanceTimersByTimeAsync(100)
        const third = await pending
        expect(third.address).toBe(first.address)
    })

    it("still returns the wallet when the metrics llen read fails", async () => {
        const manager = await createRedisSenderManager({
            config,
            metrics,
            redisEndpoint
        })
        state.failLlen = true
        const unhandled = vi.fn()
        process.on("unhandledRejection", unhandled)

        const wallet = await manager.getWallet()
        await flush()
        await new Promise((r) => setImmediate(r))
        process.off("unhandledRejection", unhandled)

        expect(wallets.map((w) => w.address)).toContain(wallet.address)
        expect(unhandled).not.toHaveBeenCalled()
    })
})
