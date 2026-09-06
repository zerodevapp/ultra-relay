import type { Logger } from "pino"
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api"
import { publicOperationReason } from "./operationFailure"

// Times an async operation and emits a single structured log line on
// completion. Used to attribute eth_sendUserOperation latency to specific
// validator/RPC steps that otherwise run inside Promise.all and aren't
// distinguishable from the outside.
export async function timed<T>(
    logger: Logger,
    step: string,
    context: Record<string, unknown>,
    fn: () => T | Promise<T>
): Promise<T> {
    const operation = async (span?: Span): Promise<T> => {
    const start = performance.now()
    try {
        const result = await fn()
        logger.info(
            {
                ...context,
                step,
                ms: Number((performance.now() - start).toFixed(2))
            },
            `[timing] ${step}`
        )
        return result
    } catch (err) {
        logger.warn(
            {
                ...context,
                step,
                ms: Number((performance.now() - start).toFixed(2)),
                err: publicOperationReason(err instanceof Error ? err.message : undefined)
            },
            `[timing] ${step} failed`
        )
        span?.setStatus({ code: SpanStatusCode.ERROR })
        throw err
    } finally {
        span?.end()
    }
    }
    if (process.env.PERF_TRACING !== "true") return operation()
    const hash = context.userOpHash
    return trace.getTracer("ultra-relay-pipeline").startActiveSpan(step, {
        attributes: typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash)
            ? { "profiler.userop": hash } : {}
    }, operation)
}
