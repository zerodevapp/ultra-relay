import type { Logger } from "pino"

// Times an async operation and emits a single structured log line on
// completion. Used to attribute eth_sendUserOperation latency to specific
// validator/RPC steps that otherwise run inside Promise.all and aren't
// distinguishable from the outside.
// summarize receives the result and the unrounded elapsed ms and returns
// extra fields for the success line, or undefined to skip that line.
export async function timed<T>(
    logger: Logger,
    step: string,
    context: Record<string, unknown>,
    fn: () => T | Promise<T>,
    options?: {
        summarize?: (
            result: T,
            ms: number
        ) => Record<string, unknown> | undefined
    }
): Promise<T> {
    const start = performance.now()
    try {
        const result = await fn()
        const ms = performance.now() - start
        const summary = options?.summarize ? options.summarize(result, ms) : {}
        if (summary) {
            logger.info(
                {
                    ...context,
                    step,
                    ms: Number(ms.toFixed(2)),
                    ...summary
                },
                `[timing] ${step}`
            )
        }
        return result
    } catch (err) {
        logger.warn(
            {
                ...context,
                step,
                ms: Number((performance.now() - start).toFixed(2)),
                err: err instanceof Error ? err.message : String(err)
            },
            `[timing] ${step} failed`
        )
        throw err
    }
}
