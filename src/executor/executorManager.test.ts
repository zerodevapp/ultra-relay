import { expect, it, vi } from "vitest"
import { ExecutorManager } from "./executorManager"

it("serializes ticks and rearms after failure, not while getBundles is running", async () => {
    vi.useFakeTimers()
    try {
        let reject!: (error: Error) => void
        const getBundles = vi.fn(() => new Promise<never>((_, fail) => { reject = fail }))
        const manager = Object.create(ExecutorManager.prototype) as ExecutorManager
        Object.assign(manager, { bundlingMode: "auto", bundlingTickRunning: false, opsCount: [],
            config: { maxBundleInterval: 100, minBundleInterval: 25, bundleIntervalScaleMs: 1 },
            mempool: { getBundles }, logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn() } })
        const running = manager.autoScalingBundling()
        await manager.autoScalingBundling()
        expect(getBundles).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
        reject(new Error("failed"))
        await running
        expect(vi.getTimerCount()).toBe(1)
        expect((manager as any).bundlingTickRunning).toBe(false)
    } finally { vi.clearAllTimers(); vi.useRealTimers() }
})
