import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../../createConfig"
import { createRedisSenderManager } from "./createRedisSenderManager"

type ReconcileReply = [number, string[], number, number, number]

// Minimal stand-in for the manager's Redis client: the three pool scripts
// over one array, plus the connection surface the manager touches.
// Hand-rolled (not ioredis-mock) so fake timers can't interfere with command
// completion. Script correctness is covered against a real Redis in
// createRedisSenderManager.script.test.ts. Wrapped in vi.hoisted because
// vi.mock factories run before module-level statements.
const { pool, calls, state, FakeRedis } = vi.hoisted(() => {
    const pool: string[] = []
    const calls = {
        takeWallet: 0,
        returnWallet: 0,
        reconcileWallets: 0,
        disconnect: 0
    }
    const state = {
        options: undefined as unknown,
        client: undefined as
            | { disconnect(): void; emitReady(): void }
            | undefined,
        seeded: false,
        // Overrides for the next reconcile replies, oldest first.
        reconcileReplies: [] as (() => Promise<ReconcileReply>)[],
        returnFailures: [] as Error[]
    }

    class FakeRedis {
        status = "wait"
        private endListeners: (() => void)[] = []
        private readyListeners: (() => void)[] = []

        constructor(_url: string, options: unknown) {
            state.options = options
            state.client = this
        }
        defineCommand() {}
        connect() {
            this.status = "ready"
            return Promise.resolve()
        }
        disconnect() {
            calls.disconnect++
            this.status = "end"
            const listeners = this.endListeners
            this.endListeners = []
            for (const listener of listeners) listener()
        }
        once(event: string, listener: () => void) {
            if (event === "end") this.endListeners.push(listener)
            return this
        }
        on(event: string, listener: () => void) {
            if (event === "ready") this.readyListeners.push(listener)
            return this
        }
        emitReady() {
            for (const listener of this.readyListeners) listener()
        }
        reconcileWallets(
            _pool: string,
            _inUse: string,
            _armed: string,
            ...addresses: string[]
        ): Promise<ReconcileReply> {
            calls.reconcileWallets++
            const override = state.reconcileReplies.shift()
            if (override) return override()
            // The first reconcile seeds an empty armed pool; later ones find
            // nothing missing.
            const added = state.seeded ? [] : addresses
            state.seeded = true
            pool.unshift(...added)
            return Promise.resolve([1, added, pool.length, 0, 0])
        }
        takeWallet() {
            calls.takeWallet++
            const address = pool.pop() ?? null
            return Promise.resolve([address, pool.length])
        }
        returnWallet(_pool: string, _inUse: string, address: string) {
            calls.returnWallet++
            const failure = state.returnFailures.shift()
            if (failure) return Promise.reject(failure)
            pool.unshift(address)
            return Promise.resolve([1, pool.length])
        }
    }

    return { pool, calls, state, FakeRedis }
})

vi.mock("ioredis", () => ({ default: FakeRedis, Redis: FakeRedis }))

const SYNC_MS = 5 * 60 * 1000
const NOT_SENT =
    "Stream isn't writeable and enableOfflineQueue options is false"
const redisEndpoint = "redis://fake"
const wallets = [
    { address: "0x1111111111111111111111111111111111111111" },
    { address: "0x2222222222222222222222222222222222222222" }
]
const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn()
}
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
const createManager = () =>
    createRedisSenderManager({ config, metrics, redisEndpoint })

describe("createRedisSenderManager", () => {
    beforeEach(() => {
        pool.length = 0
        calls.takeWallet = 0
        calls.returnWallet = 0
        calls.reconcileWallets = 0
        calls.disconnect = 0
        state.options = undefined
        state.client = undefined
        state.seeded = false
        state.reconcileReplies = []
        state.returnFailures = []
        for (const fn of Object.values(logger)) fn.mockClear()
        // Only fake the timeout pair: if getWallet awaited delay() on a
        // successful take, the promise below could never settle and the test
        // would hang. clearTimeout must be faked too, or the manager's
        // cleanup could not cancel its fake sync timer.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    })
    afterEach(() => vi.useRealTimers())

    it("connects without an offline queue and never resends commands", async () => {
        await createManager()

        expect(state.options).toEqual({
            lazyConnect: true,
            enableOfflineQueue: false,
            autoResendUnfulfilledCommands: false,
            maxRetriesPerRequest: 0
        })
    })

    it("resolves without any poll delay when a wallet is available", async () => {
        const manager = await createManager()

        const wallet = await manager.getWallet()

        expect(wallets.map((w) => w.address)).toContain(wallet.address)
        expect(calls.takeWallet).toBe(1)
        // Only the 5-minute sync is pending.
        expect(vi.getTimerCount()).toBe(1)
    })

    it("backs off 100ms between polls while none of this instance's wallets is free, then resolves", async () => {
        const manager = await createManager()
        const first = await manager.getWallet()
        await manager.getWallet()
        calls.takeWallet = 0

        const pending = manager.getWallet()
        await flush()
        expect(calls.takeWallet).toBe(1) // first poll, empty

        await vi.advanceTimersByTimeAsync(99)
        expect(calls.takeWallet).toBe(1) // still sleeping, no busy loop

        await vi.advanceTimersByTimeAsync(1)
        expect(calls.takeWallet).toBe(2) // one retry exactly at 100ms

        await manager.markWalletProcessed(first)
        await vi.advanceTimersByTimeAsync(100)
        const third = await pending
        expect(third.address).toBe(first.address)
    })

    it("rejects startup on an unarmed pool and closes the client", async () => {
        state.reconcileReplies.push(() => Promise.resolve([0, [], 0, 0, 0]))

        await expect(createManager()).rejects.toThrow(
            "executor wallet pool test:42161:sender-manager is not armed; rebuild it with every pod stopped (ADR 0006)"
        )
        expect(calls.disconnect).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it("syncs every 5 minutes and stays quiet when nothing is missing", async () => {
        await createManager()
        expect(calls.reconcileWallets).toBe(1)

        await vi.advanceTimersByTimeAsync(SYNC_MS - 1)
        expect(calls.reconcileWallets).toBe(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(calls.reconcileWallets).toBe(2)
        await vi.advanceTimersByTimeAsync(SYNC_MS)
        expect(calls.reconcileWallets).toBe(3)

        expect(logger.warn).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    })

    it("never starts a sync while the previous one is still running", async () => {
        await createManager()
        let finish: (reply: ReconcileReply) => void = () => {}
        state.reconcileReplies.push(
            () =>
                new Promise<ReconcileReply>((resolve) => {
                    finish = resolve
                })
        )

        await vi.advanceTimersByTimeAsync(SYNC_MS)
        expect(calls.reconcileWallets).toBe(2)
        await vi.advanceTimersByTimeAsync(3 * SYNC_MS)
        expect(calls.reconcileWallets).toBe(2)

        finish([1, [], 2, 0, 0])
        await vi.advanceTimersByTimeAsync(SYNC_MS)
        expect(calls.reconcileWallets).toBe(3)
    })

    it("logs a failed sync and keeps syncing", async () => {
        await createManager()
        const error = new Error("redis down")
        state.reconcileReplies.push(() => Promise.reject(error))

        await vi.advanceTimersByTimeAsync(SYNC_MS)
        expect(logger.error).toHaveBeenCalledWith(
            { err: error },
            "executor wallet sync failed"
        )

        await vi.advanceTimersByTimeAsync(SYNC_MS)
        expect(calls.reconcileWallets).toBe(3)
    })

    it("logs an unarmed pool during a sync and adds nothing", async () => {
        await createManager()
        state.reconcileReplies.push(() => Promise.resolve([0, [], 2, 0, 0]))

        await vi.advanceTimersByTimeAsync(SYNC_MS)

        expect(logger.error).toHaveBeenCalledWith(
            { poolSize: 2, inUseCount: 0 },
            "executor wallet pool is not armed; added no wallets"
        )
        expect(logger.warn).not.toHaveBeenCalled()
    })

    it("warns when a sync re-adds wallets", async () => {
        await createManager()
        const [lost] = wallets
        state.reconcileReplies.push(() =>
            Promise.resolve([1, [lost.address], 2, 0, 0])
        )

        await vi.advanceTimersByTimeAsync(SYNC_MS)

        expect(logger.warn).toHaveBeenCalledWith(
            {
                added: [lost.address],
                addedCount: 1,
                poolSize: 2,
                inUseCount: 0,
                foreignCount: 0
            },
            "re-added missing executor wallets"
        )
    })

    it("stops syncing once the client closes", async () => {
        await createManager()

        state.client?.disconnect()

        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(2 * SYNC_MS)
        expect(calls.reconcileWallets).toBe(1)
    })

    it("schedules no next sync when the client closes during a run", async () => {
        await createManager()
        let finish: (reply: ReconcileReply) => void = () => {}
        state.reconcileReplies.push(
            () =>
                new Promise<ReconcileReply>((resolve) => {
                    finish = resolve
                })
        )
        await vi.advanceTimersByTimeAsync(SYNC_MS)

        state.client?.disconnect()
        finish([1, [], 2, 0, 0])
        // Lets the run finish, then gives any wrongly scheduled sync time to fire.
        await vi.advanceTimersByTimeAsync(SYNC_MS)

        expect(vi.getTimerCount()).toBe(0)
        expect(calls.reconcileWallets).toBe(2)
    })

    it("defers a return Redis never received and sends it once the client is ready", async () => {
        const manager = await createManager()
        const wallet = await manager.getWallet()
        state.returnFailures.push(new Error(NOT_SENT))
        calls.returnWallet = 0

        await manager.markWalletProcessed(wallet)

        expect(calls.returnWallet).toBe(1)
        expect(logger.warn).toHaveBeenCalledWith(
            { executor: wallet.address },
            "wallet return deferred until Redis reconnects"
        )
        expect(logger.error).not.toHaveBeenCalled()
        expect(manager.getActiveWallets()).toEqual([wallet])

        state.client?.emitReady()
        await flush()

        expect(calls.returnWallet).toBe(2)
        expect(manager.getActiveWallets()).toEqual([])
        expect(pool).toContain(wallet.address)
    })

    it("sends a deferred return only once, even if the caller releases it again", async () => {
        const manager = await createManager()
        const wallet = await manager.getWallet()
        state.returnFailures.push(new Error(NOT_SENT))
        calls.returnWallet = 0
        await manager.markWalletProcessed(wallet)

        await manager.markWalletProcessed(wallet)

        expect(calls.returnWallet).toBe(1)
        expect(logger.warn).toHaveBeenCalledWith(
            { executor: wallet.address },
            "Attempted to mark a wallet as processed that wasn't active"
        )
        state.client?.emitReady()
        await flush()
        expect(calls.returnWallet).toBe(2)
    })

    it("still rejects, and never resends, a return whose outcome is unknown", async () => {
        const manager = await createManager()
        const wallet = await manager.getWallet()
        const lost = new Error("Connection is closed.")
        state.returnFailures.push(lost)
        calls.returnWallet = 0

        await expect(manager.markWalletProcessed(wallet)).rejects.toBe(lost)
        state.client?.emitReady()
        await flush()

        expect(calls.returnWallet).toBe(1)
        expect(manager.getActiveWallets()).toEqual([])
        expect(logger.error).toHaveBeenCalledWith(
            { err: lost, executor: wallet.address },
            "wallet return failed; reservation requires inspection"
        )
    })
})
