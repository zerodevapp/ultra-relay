import { context, trace } from "@opentelemetry/api"
import type { UserOpInfo } from "@alto/types"

/** Export the source-stamped lifecycle, including the queue intervals that HTTP tracing cannot see. */
export function profileIncludedUserOp(info: UserOpInfo, transactionHash: string, observedAt: number) {
    if (process.env.PERF_TRACING !== "true") return
    const tracer = trace.getTracer("ultra-relay-lifecycle")
    const start = info.receivedAt ?? info.addedToMempool
    const attributes = {
        "profiler.userop": info.userOpHash.toLowerCase(),
        "profiler.transaction": transactionHash.toLowerCase(),
        "profiler.clock_error_us": 1000,
        "profiler.reentered": Boolean(info.reentered)
    }
    const root = tracer.startSpan("userop.lifecycle", { startTime: start, attributes })
    const parent = trace.setSpan(context.active(), root)
    let previous = ""
    const interval = (name: string, from: number | undefined, to: number | undefined) => {
        if (from === undefined || to === undefined || to < from) return
        const span = tracer.startSpan(name, {
            startTime: from,
            attributes: { ...attributes, "profiler.predecessors": previous }
        }, parent)
        const ctx = span.spanContext()
        previous = `${ctx.traceId}:${ctx.spanId}`
        span.end(to)
    }
    // A reentered op's original receivedAt predates this attempt. Do not mislabel that gap as validation.
    if (!info.reentered) interval("mempool.validation", info.receivedAt, info.addedToMempool)
    interval("mempool.outstanding", info.addedToMempool, info.processingAt)
    interval("mempool.processing", info.processingAt, info.submittedAt)
    interval("receipt.observation", info.submittedAt, observedAt)
    root.end(observedAt)
}
