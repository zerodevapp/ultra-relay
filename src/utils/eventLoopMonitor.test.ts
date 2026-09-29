import type { EventLoopUtilization } from "node:perf_hooks"
import type { Logger } from "pino"
import { Registry } from "prom-client"
import { describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../createConfig"
import {
    type EventLoopSources,
    startEventLoopMonitor,
    startEventLoopMonitorIfEnabled
} from "./eventLoopMonitor"

const ACTIVE = "ultra_relay_event_loop_active_seconds_total"
const IDLE = "ultra_relay_event_loop_idle_seconds_total"
const BLOCKS = "ultra_relay_event_loop_blocks_total"
const BLOCK_MAX_DELAY = "ultra_relay_event_loop_block_max_delay_seconds"
const METRIC_NAMES = [ACTIVE, IDLE, BLOCKS, BLOCK_MAX_DELAY]

type LogFields = Record<string, unknown>

// A controllable stand-in for monitorEventLoopDelay's histogram. Values are ns,
// like the real one; reset() empties it, like the real one.
function fakeSampler() {
    const state = { max: 0, count: 0, p99: 0, p50: 0 }
    return {
        get max() {
            return state.max
        },
        get count() {
            return state.count
        },
        percentile: (percentile: number) =>
            percentile === 99 ? state.p99 : state.p50,
        reset: vi.fn(() => {
            state.max = 0
            state.count = 0
            state.p99 = 0
            state.p50 = 0
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        set: ({
            maxMs,
            p99Ms = maxMs,
            p50Ms = 11,
            count = 91
        }: {
            maxMs: number
            p99Ms?: number
            p50Ms?: number
            count?: number
        }) => {
            state.max = maxMs * 1e6
            state.p99 = p99Ms * 1e6
            state.p50 = p50Ms * 1e6
            state.count = count
        }
    }
}

function setup({
    thresholdMs = 50,
    sources: overrides = {}
}: { thresholdMs?: number; sources?: Partial<EventLoopSources> } = {}) {
    const second = fakeSampler()
    const minute = fakeSampler()
    const samplers = [second, minute]
    const clock = { now: 0 }
    const elu = { active: 0, idle: 0 }
    let onGc: ((durationMs: number) => void) | undefined
    let check: (() => void) | undefined
    const handle = { unref: vi.fn() }
    const unsubscribeGc = vi.fn()

    const sources: EventLoopSources = {
        createDelaySampler: () => {
            const sampler = samplers.shift()
            if (!sampler) {
                throw new Error("expected exactly two samplers")
            }
            return sampler
        },
        eventLoopUtilization: (
            current?: EventLoopUtilization,
            previous?: EventLoopUtilization
        ) => {
            if (!current) {
                return { ...elu, utilization: 0 }
            }
            if (!previous) {
                return current
            }
            const active = current.active - previous.active
            const idle = current.idle - previous.idle
            const total = active + idle
            return { active, idle, utilization: total ? active / total : 0 }
        },
        subscribeGc: (listener) => {
            onGc = listener
            return unsubscribeGc
        },
        now: () => clock.now,
        heapUsedBytes: () => 184_700_000,
        setInterval: vi.fn((callback: () => void) => {
            check = callback
            return handle
        }),
        clearInterval: vi.fn(),
        readFile: () => undefined,
        ...overrides
    }

    const registry = new Registry()
    const info = vi.fn<(fields: LogFields, msg: string) => void>()
    const warn = vi.fn<(msg: string) => void>()
    const logger = { info, warn } as unknown as Logger
    const monitor = startEventLoopMonitor({
        logger,
        registry,
        thresholdMs,
        sources
    })

    // One 1-second check: advance the clock and utilization, then run the
    // interval callback.
    const tick = ({
        elapsedMs = 1000,
        activeMs = 0
    }: { elapsedMs?: number; activeMs?: number } = {}) => {
        clock.now += elapsedMs
        elu.active += activeMs
        elu.idle += elapsedMs - activeMs
        check?.()
    }
    const ticks = (n: number, options?: Parameters<typeof tick>[0]) => {
        for (let i = 0; i < n; i++) {
            tick(options)
        }
    }
    const lines = (step: string) =>
        info.mock.calls
            .filter(([fields]) => fields.step === step)
            .map(([fields]) => fields)
    const gc = (durationMs: number) => onGc?.(durationMs)

    return {
        second,
        minute,
        tick,
        ticks,
        lines,
        gc,
        info,
        warn,
        registry,
        monitor,
        sources,
        handle,
        unsubscribeGc
    }
}

async function metricValues(registry: Registry, name: string) {
    const metric = registry.getSingleMetric(name)
    if (!metric) {
        throw new Error(`${name} is not registered`)
    }
    return (await metric.get()).values
}

async function counterValue(registry: Registry, name: string) {
    return (await metricValues(registry, name))[0]?.value ?? 0
}

// Cumulative bucket counts keyed by `le`, e.g. { "0.05": 1, "+Inf": 2 }.
async function bucketCounts(registry: Registry) {
    const values = await metricValues(registry, BLOCK_MAX_DELAY)
    return Object.fromEntries(
        values
            .filter(
                (value) =>
                    "metricName" in value &&
                    value.metricName === `${BLOCK_MAX_DELAY}_bucket`
            )
            .map((value) => [String(value.labels.le), value.value])
    )
}

// A cgroup v2 container (limit 1 CPU, one machine CPU) whose cumulative
// counters the test advances between checks.
function fakeCgroupFs() {
    const counters = {
        usageUs: 0,
        throttledPeriods: 0,
        throttledUs: 0,
        waitUs: 0,
        busyTicks: 0,
        stealTicks: 0
    }
    const files: Record<string, () => string> = {
        "/proc/self/cgroup": () => "0::/\n",
        "/sys/fs/cgroup/cgroup.controllers": () => "cpu memory\n",
        "/sys/fs/cgroup/cpu.max": () => "100000 100000\n",
        "/sys/fs/cgroup/cpu.stat": () =>
            `usage_usec ${counters.usageUs}\nnr_periods 0\nnr_throttled ${counters.throttledPeriods}\nthrottled_usec ${counters.throttledUs}\n`,
        "/sys/fs/cgroup/cpu.pressure": () =>
            `some avg10=0.00 avg60=0.00 avg300=0.00 total=${counters.waitUs}\n`,
        "/proc/stat": () =>
            `cpu  ${counters.busyTicks} 0 0 1000 0 0 0 ${counters.stealTicks} 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\n`
    }
    const readFile = (path: string) => files[path]?.()
    const advance = (delta: Partial<typeof counters>) => {
        for (const key of Object.keys(delta) as (keyof typeof counters)[]) {
            counters[key] += delta[key] ?? 0
        }
    }
    return { readFile, advance }
}

describe("startEventLoopMonitor", () => {
    it("starts both samplers, an unref'd 1s interval and logs the startup line", () => {
        const h = setup()

        expect(h.monitor).toBeDefined()
        expect(h.second.enable).toHaveBeenCalledTimes(1)
        expect(h.minute.enable).toHaveBeenCalledTimes(1)
        expect(h.sources.setInterval).toHaveBeenCalledWith(
            expect.any(Function),
            1000
        )
        expect(h.handle.unref).toHaveBeenCalledTimes(1)
        expect(h.info).toHaveBeenCalledWith(
            {
                thresholdMs: 50,
                resolutionMs: 10,
                windowMs: 1000,
                summaryMs: 60000,
                cgroup: "none",
                cpuLimit: null,
                cpuPressure: false,
                steal: false,
                nodeCpus: null
            },
            "event-loop monitor enabled"
        )
    })

    it("does not flag a window below the threshold and counts utilization", async () => {
        const h = setup()
        h.second.set({ maxMs: 49.9 })

        h.tick({ activeMs: 400 })

        expect(h.lines("eventLoop.blocked")).toEqual([])
        expect(await counterValue(h.registry, BLOCKS)).toBe(0)
        expect(await counterValue(h.registry, ACTIVE)).toBeCloseTo(0.4)
        expect(await counterValue(h.registry, IDLE)).toBeCloseTo(0.6)
    })

    it("flags windows at or above the threshold with every field", async () => {
        const h = setup()

        h.second.set({ maxMs: 50, p99Ms: 48.26, p50Ms: 11.04, count: 90 })
        h.tick({ activeMs: 250 })
        h.second.set({ maxMs: 212.44, p99Ms: 212.44, p50Ms: 11.06, count: 72 })
        h.tick({ elapsedMs: 1003, activeMs: 419.3 })

        expect(h.lines("eventLoop.blocked")).toEqual([
            {
                step: "eventLoop.blocked",
                windowMs: 1000,
                maxMs: 50,
                p99Ms: 48.3,
                p50Ms: 11,
                samples: 90,
                busy: 0.25,
                gcMs: 0,
                gcMaxMs: 0,
                gcCount: 0,
                heapUsedMb: 184.7,
                thresholdMs: 50
            },
            {
                step: "eventLoop.blocked",
                windowMs: 1003,
                maxMs: 212.4,
                p99Ms: 212.4,
                p50Ms: 11.1,
                samples: 72,
                busy: 0.418,
                gcMs: 0,
                gcMaxMs: 0,
                gcCount: 0,
                heapUsedMb: 184.7,
                thresholdMs: 50
            }
        ])
        expect(h.info).toHaveBeenCalledWith(
            expect.objectContaining({ step: "eventLoop.blocked" }),
            "[timing] eventLoop.blocked"
        )
        expect(await counterValue(h.registry, BLOCKS)).toBe(2)
        expect(await bucketCounts(h.registry)).toMatchObject({
            "0.025": 0,
            "0.05": 1,
            "0.2": 1,
            "0.5": 2,
            "+Inf": 2
        })
    })

    it("ignores an empty window even if max reads high", () => {
        const h = setup()
        h.second.set({ maxMs: 500, count: 0 })

        h.tick()

        expect(h.lines("eventLoop.blocked")).toEqual([])
    })

    it("resets the second sampler and GC totals on every check", () => {
        const h = setup()

        h.gc(5)
        h.second.set({ maxMs: 80 })
        h.tick()
        h.tick()
        h.second.set({ maxMs: 90 })
        h.tick()

        const blocked = h.lines("eventLoop.blocked")
        expect(blocked).toHaveLength(2)
        expect(blocked[0]).toMatchObject({ gcMs: 5, gcCount: 1 })
        expect(blocked[1]).toMatchObject({ maxMs: 90, gcMs: 0, gcCount: 0 })
        expect(h.second.reset).toHaveBeenCalledTimes(3)
    })

    it("writes one summary per 60s, then counts the next minute from zero", () => {
        const h = setup()

        h.second.set({ maxMs: 70 })
        h.tick({ activeMs: 100 })
        h.second.set({ maxMs: 80 })
        h.tick({ activeMs: 100 })
        h.ticks(57, { activeMs: 100 })
        expect(h.lines("eventLoop.summary")).toEqual([])

        h.minute.set({ maxMs: 80, p99Ms: 12.3, p50Ms: 11, count: 5460 })
        h.tick({ activeMs: 100 })

        expect(h.lines("eventLoop.summary")).toEqual([
            {
                step: "eventLoop.summary",
                windowMs: 60000,
                maxMs: 80,
                p99Ms: 12.3,
                p50Ms: 11,
                samples: 5460,
                busy: 0.1,
                gcMs: 0,
                gcMaxMs: 0,
                gcCount: 0,
                heapUsedMb: 184.7,
                blockedWindows: 2,
                thresholdMs: 50
            }
        ])
        expect(h.info).toHaveBeenCalledWith(
            expect.objectContaining({ step: "eventLoop.summary" }),
            "[timing] eventLoop.summary"
        )
        expect(h.minute.reset).toHaveBeenCalledTimes(1)

        // Next minute: no stalls, and the minute sampler recorded nothing.
        h.ticks(60)

        const summaries = h.lines("eventLoop.summary")
        expect(summaries).toHaveLength(2)
        expect(summaries[1]).toMatchObject({
            windowMs: 60000,
            maxMs: 0,
            p99Ms: 0,
            p50Ms: 0,
            samples: 0,
            busy: 0,
            blockedWindows: 0
        })
    })

    it("uses real elapsed time for late checks and the summary", () => {
        const h = setup()

        h.second.set({ maxMs: 300 })
        h.tick({ elapsedMs: 3000 })
        expect(h.lines("eventLoop.blocked")[0]).toMatchObject({
            windowMs: 3000
        })

        h.ticks(18, { elapsedMs: 3000 })
        expect(h.lines("eventLoop.summary")).toEqual([])

        h.tick({ elapsedMs: 3000 })
        expect(h.lines("eventLoop.summary")).toHaveLength(1)
        expect(h.lines("eventLoop.summary")[0]).toMatchObject({
            windowMs: 60000,
            blockedWindows: 1
        })
    })

    it("adds GC pauses to the window line and the summary", () => {
        const h = setup()

        h.gc(2.1)
        h.gc(0.4)
        h.gc(1.0)
        h.second.set({ maxMs: 60 })
        h.tick()
        h.ticks(59)

        const gcFields = { gcMs: 3.5, gcMaxMs: 2.1, gcCount: 3 }
        expect(h.lines("eventLoop.blocked")[0]).toMatchObject(gcFields)
        expect(h.lines("eventLoop.summary")[0]).toMatchObject(gcFields)
    })

    it("honours a custom threshold", () => {
        const h = setup({ thresholdMs: 100 })

        h.second.set({ maxMs: 60 })
        h.tick()
        h.second.set({ maxMs: 100 })
        h.tick()

        const blocked = h.lines("eventLoop.blocked")
        expect(blocked).toHaveLength(1)
        expect(blocked[0]).toMatchObject({ maxMs: 100, thresholdMs: 100 })
    })

    it.each([
        ["monitorEventLoopDelay", { createDelaySampler: undefined }],
        ["eventLoopUtilization", { eventLoopUtilization: undefined }]
    ])("warns and starts nothing without %s", (_api, missing) => {
        const h = setup({ sources: missing })

        expect(h.monitor).toBeUndefined()
        expect(h.warn).toHaveBeenCalledWith(
            "event-loop monitor unavailable on this runtime; enable-event-loop-metrics ignored"
        )
        expect(h.info).not.toHaveBeenCalled()
        expect(h.sources.setInterval).not.toHaveBeenCalled()
        for (const name of METRIC_NAMES) {
            expect(h.registry.getSingleMetric(name)).toBeUndefined()
        }
    })

    it("stop() clears the interval, disables samplers and ends the GC subscription", () => {
        const h = setup()

        h.monitor?.stop()

        // The handle setInterval returned is the one cleared, so no further
        // checks run on the real runtime.
        expect(h.sources.clearInterval).toHaveBeenCalledWith(h.handle)
        expect(h.second.disable).toHaveBeenCalledTimes(1)
        expect(h.minute.disable).toHaveBeenCalledTimes(1)
        expect(h.unsubscribeGc).toHaveBeenCalledTimes(1)
    })

    it("flags a real 150ms block on the real runtime", async () => {
        const registry = new Registry()
        const info = vi.fn<(fields: LogFields, msg: string) => void>()
        const logger = { info, warn: vi.fn() } as unknown as Logger
        const monitor = startEventLoopMonitor({
            logger,
            registry,
            thresholdMs: 50
        })

        try {
            // The sampler ignores its first 10ms interval, so a block that
            // starts right after enable() isn't recorded. Let it warm up.
            await new Promise((resolve) => setTimeout(resolve, 30))
            const until = performance.now() + 150
            while (performance.now() < until) {
                // Busy-wait: hold the event loop for 150ms.
            }

            // Poll rather than sleep a fixed time: a loaded CI box can delay
            // the check or add its own stalls, so assert "at least" our block.
            await vi.waitFor(
                () => {
                    const maxes = info.mock.calls
                        .filter(
                            ([fields]) => fields.step === "eventLoop.blocked"
                        )
                        .map(([fields]) => Number(fields.maxMs))
                    expect(maxes.some((maxMs) => maxMs >= 140)).toBe(true)
                },
                { timeout: 3000, interval: 50 }
            )
            expect(await counterValue(registry, BLOCKS)).toBeGreaterThanOrEqual(
                1
            )
        } finally {
            monitor?.stop()
        }
    })

    it("puts the stalled second's own CPU counters on its line", () => {
        const cgroup = fakeCgroupFs()
        const h = setup({ sources: { readFile: cgroup.readFile } })
        expect(h.info).toHaveBeenCalledWith(
            expect.objectContaining({
                cgroup: "v2",
                cpuLimit: 1,
                cpuPressure: true,
                steal: true,
                nodeCpus: 1
            }),
            "event-loop monitor enabled"
        )

        cgroup.advance({ usageUs: 10_000, waitUs: 2_000, busyTicks: 100 })
        h.tick()
        cgroup.advance({ usageUs: 10_000, waitUs: 2_000, busyTicks: 100 })
        h.tick()
        cgroup.advance({
            usageUs: 30_000,
            throttledPeriods: 2,
            throttledUs: 50_000,
            waitUs: 61_000,
            busyTicks: 95,
            stealTicks: 5
        })
        h.second.set({ maxMs: 120 })
        h.tick()

        const blocked = h.lines("eventLoop.blocked")
        expect(blocked).toHaveLength(1)
        expect(blocked[0]).toMatchObject({
            cpuMs: 30,
            throttledPeriods: 2,
            throttledMs: 50,
            cpuWaitMs: 61,
            stealPct: 5,
            thresholdMs: 50
        })
    })

    it("puts the whole minute's CPU counters on the summary, then starts over", () => {
        const cgroup = fakeCgroupFs()
        const h = setup({ sources: { readFile: cgroup.readFile } })

        for (let i = 0; i < 60; i++) {
            cgroup.advance({
                usageUs: 10_000,
                throttledPeriods: 1,
                throttledUs: 2_000,
                waitUs: 1_000,
                busyTicks: 99,
                stealTicks: 1
            })
            h.tick()
        }
        // 60 steal ticks of 6,000 total = 1%.
        expect(h.lines("eventLoop.summary")[0]).toMatchObject({
            cpuMs: 600,
            throttledPeriods: 60,
            throttledMs: 120,
            cpuWaitMs: 60,
            stealPct: 1,
            blockedWindows: 0
        })

        for (let i = 0; i < 60; i++) {
            cgroup.advance({
                usageUs: 5_000,
                throttledPeriods: 2,
                throttledUs: 500,
                waitUs: 3_000,
                busyTicks: 96,
                stealTicks: 4
            })
            h.tick()
        }
        // Counts only the second minute: 240 steal ticks of 6,000 = 4%.
        expect(h.lines("eventLoop.summary")[1]).toMatchObject({
            cpuMs: 300,
            throttledPeriods: 120,
            throttledMs: 30,
            cpuWaitMs: 180,
            stealPct: 4
        })
    })
})

describe("startEventLoopMonitorIfEnabled", () => {
    const makeConfig = (enableEventLoopMetrics: boolean) => {
        const getLogger = vi.fn(
            () => ({ info: vi.fn(), warn: vi.fn() }) as unknown as Logger
        )
        const config = {
            enableEventLoopMetrics,
            eventLoopBlockThresholdMs: 50,
            logLevel: "info",
            getLogger
        } as unknown as AltoConfig
        return { config, getLogger }
    }

    it("starts nothing and registers no metrics when the option is off", async () => {
        const registry = new Registry()
        const { config, getLogger } = makeConfig(false)

        expect(
            startEventLoopMonitorIfEnabled({ config, registry })
        ).toBeUndefined()
        expect(getLogger).not.toHaveBeenCalled()
        const exposed = await registry.metrics()
        for (const name of METRIC_NAMES) {
            expect(exposed).not.toContain(name)
        }
    })

    it("starts the monitor with an event_loop logger when the option is on", async () => {
        const registry = new Registry()
        const { config, getLogger } = makeConfig(true)

        const monitor = startEventLoopMonitorIfEnabled({ config, registry })

        try {
            expect(monitor).toBeDefined()
            expect(getLogger).toHaveBeenCalledWith(
                { module: "event_loop" },
                { level: "info" }
            )
            const exposed = await registry.metrics()
            for (const name of METRIC_NAMES) {
                expect(exposed).toContain(name)
            }
        } finally {
            monitor?.stop()
        }
    })
})
