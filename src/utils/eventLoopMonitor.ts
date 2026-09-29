import {
    type EventLoopUtilization,
    type IntervalHistogram,
    PerformanceObserver,
    monitorEventLoopDelay,
    performance
} from "node:perf_hooks"
import type { Logger } from "pino"
import { Counter, Histogram, type Registry } from "prom-client"
import type { AltoConfig } from "../createConfig"

const RESOLUTION_MS = 10
const WINDOW_MS = 1_000
const SUMMARY_MS = 60_000

// The parts of monitorEventLoopDelay's histogram the monitor reads (values in
// ns). count exists at runtime since Node 17.4 but not in @types/node 18.
export type DelaySampler = {
    readonly max: number
    readonly count: number
    percentile: (percentile: number) => number
    reset: () => void
    enable: () => unknown
    disable: () => unknown
}

type IntervalHandle = { unref: () => unknown }

// The Node calls the monitor makes, injectable so tests don't depend on real
// timing.
export type EventLoopSources = {
    createDelaySampler: (() => DelaySampler) | undefined
    eventLoopUtilization:
        | ((
              current?: EventLoopUtilization,
              previous?: EventLoopUtilization
          ) => EventLoopUtilization)
        | undefined
    subscribeGc: (onGc: (durationMs: number) => void) => () => void
    now: () => number
    heapUsedBytes: () => number
    setInterval: (callback: () => void, ms: number) => IntervalHandle
    clearInterval: (handle: IntervalHandle) => void
}

const defaultSources: EventLoopSources = {
    createDelaySampler:
        typeof monitorEventLoopDelay === "function"
            ? () =>
                  monitorEventLoopDelay({
                      resolution: RESOLUTION_MS
                  }) as IntervalHistogram & { readonly count: number }
            : undefined,
    eventLoopUtilization:
        typeof performance.eventLoopUtilization === "function"
            ? (current, previous) =>
                  performance.eventLoopUtilization(current, previous)
            : undefined,
    subscribeGc: (onGc) => {
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                onGc(entry.duration)
            }
        })
        observer.observe({ entryTypes: ["gc"] })
        return () => observer.disconnect()
    },
    now: () => performance.now(),
    heapUsedBytes: () => process.memoryUsage().heapUsed,
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>)
}

type GcTotals = { gcMs: number; gcMaxMs: number; gcCount: number }

const emptyGc = (): GcTotals => ({ gcMs: 0, gcMaxMs: 0, gcCount: 0 })

function addGc(totals: GcTotals, durationMs: number) {
    totals.gcMs += durationMs
    totals.gcMaxMs = Math.max(totals.gcMaxMs, durationMs)
    totals.gcCount++
}

function resetGc(totals: GcTotals) {
    totals.gcMs = 0
    totals.gcMaxMs = 0
    totals.gcCount = 0
}

const round1 = (value: number) => Math.round(value * 10) / 10
const round3 = (value: number) => Math.round(value * 1000) / 1000
const nsToMs = (ns: number) => ns / 1e6

export type EventLoopMonitor = { stop: () => void }

// Logs each 1-second window whose worst event-loop delay reaches thresholdMs,
// plus a 60-second summary, and exports utilization and stall metrics.
export function startEventLoopMonitor({
    logger,
    registry,
    thresholdMs,
    sources = defaultSources
}: {
    logger: Logger
    registry: Registry
    thresholdMs: number
    sources?: EventLoopSources
}): EventLoopMonitor | undefined {
    const { createDelaySampler, eventLoopUtilization } = sources
    if (!(createDelaySampler && eventLoopUtilization)) {
        logger.warn(
            "event-loop monitor unavailable on this runtime; enable-event-loop-metrics ignored"
        )
        return undefined
    }

    const registers = [registry]
    const active = new Counter({
        name: "ultra_relay_event_loop_active_seconds_total",
        help: "Time the event loop spent running callbacks",
        registers
    })
    const idle = new Counter({
        name: "ultra_relay_event_loop_idle_seconds_total",
        help: "Time the event loop spent idle, waiting for events",
        registers
    })
    const blocks = new Counter({
        name: "ultra_relay_event_loop_blocks_total",
        help: "1-second windows whose worst event-loop delay reached the stall threshold",
        registers
    })
    const blockMaxDelay = new Histogram({
        name: "ultra_relay_event_loop_block_max_delay_seconds",
        help: "Worst event-loop delay of each stalled 1-second window",
        buckets: [0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
        registers
    })

    // Two samplers: a live one can't be folded into another histogram, so the
    // minute's percentiles can't be built from the per-second one.
    const secondSampler = createDelaySampler()
    const minuteSampler = createDelaySampler()
    secondSampler.enable()
    minuteSampler.enable()

    const gcSecond = emptyGc()
    const gcMinute = emptyGc()
    const unsubscribeGc = sources.subscribeGc((durationMs) => {
        addGc(gcSecond, durationMs)
        addGc(gcMinute, durationMs)
    })

    let lastTick = sources.now()
    let lastSummary = lastTick
    let eluSecond = eventLoopUtilization()
    let eluMinute = eluSecond
    let blockedWindows = 0

    const fields = (
        sampler: DelaySampler,
        windowMs: number,
        utilization: number,
        gc: GcTotals
    ) => ({
        windowMs: Math.round(windowMs),
        maxMs: round1(nsToMs(sampler.max)),
        p99Ms: round1(nsToMs(sampler.percentile(99))),
        p50Ms: round1(nsToMs(sampler.percentile(50))),
        samples: sampler.count,
        busy: round3(utilization),
        gcMs: round1(gc.gcMs),
        gcMaxMs: round1(gc.gcMaxMs),
        gcCount: gc.gcCount,
        heapUsedMb: round1(sources.heapUsedBytes() / 1e6)
    })

    const check = () => {
        const now = sources.now()
        const elu = eventLoopUtilization()
        const second = eventLoopUtilization(elu, eluSecond)
        eluSecond = elu
        active.inc(second.active / 1000)
        idle.inc(second.idle / 1000)

        const maxMs = nsToMs(secondSampler.max)
        if (secondSampler.count > 0 && maxMs >= thresholdMs) {
            blockedWindows++
            blocks.inc()
            blockMaxDelay.observe(maxMs / 1000)
            logger.info(
                {
                    step: "eventLoop.blocked",
                    ...fields(
                        secondSampler,
                        now - lastTick,
                        second.utilization,
                        gcSecond
                    ),
                    thresholdMs
                },
                "[timing] eventLoop.blocked"
            )
        }
        // ponytail: reset() also clears the sampler's last wake-up time, so the
        // next ≤10ms interval is dropped and a block starting in it never reaches
        // this window's line or blocks_total (~0.5-1% of stalls; the 60s summary
        // still shows its max). Upgrade: our own 10ms timer into createHistogram().
        secondSampler.reset()
        resetGc(gcSecond)
        lastTick = now

        if (now - lastSummary >= SUMMARY_MS) {
            const minute = eventLoopUtilization(elu, eluMinute)
            eluMinute = elu
            logger.info(
                {
                    step: "eventLoop.summary",
                    ...fields(
                        minuteSampler,
                        now - lastSummary,
                        minute.utilization,
                        gcMinute
                    ),
                    blockedWindows,
                    thresholdMs
                },
                "[timing] eventLoop.summary"
            )
            minuteSampler.reset()
            resetGc(gcMinute)
            blockedWindows = 0
            lastSummary = now
        }
    }

    const interval = sources.setInterval(check, WINDOW_MS)
    interval.unref()

    logger.info(
        {
            thresholdMs,
            resolutionMs: RESOLUTION_MS,
            windowMs: WINDOW_MS,
            summaryMs: SUMMARY_MS
        },
        "event-loop monitor enabled"
    )

    return {
        // Production never calls this: the interval is unref'd and shutdown
        // ends with process.exit. It exists for tests.
        stop: () => {
            sources.clearInterval(interval)
            secondSampler.disable()
            minuteSampler.disable()
            unsubscribeGc()
        }
    }
}

// The handler's one call: starts the monitor only when enable-event-loop-metrics
// is on, so nothing is created or registered otherwise.
export function startEventLoopMonitorIfEnabled({
    config,
    registry
}: {
    config: Pick<
        AltoConfig,
        | "enableEventLoopMetrics"
        | "eventLoopBlockThresholdMs"
        | "logLevel"
        | "getLogger"
    >
    registry: Registry
}): EventLoopMonitor | undefined {
    if (!config.enableEventLoopMetrics) {
        return undefined
    }
    return startEventLoopMonitor({
        logger: config.getLogger(
            { module: "event_loop" },
            { level: config.logLevel }
        ),
        registry,
        thresholdMs: config.eventLoopBlockThresholdMs
    })
}
