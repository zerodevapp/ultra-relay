import type { Logger } from "pino"

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
    const start = Date.now()
    try {
        const result = await fn()
        logger.info(
            { ...context, step, ms: Date.now() - start },
            `[timing] ${step}`
        )
        return result
    } catch (err) {
        logger.warn(
            {
                ...context,
                step,
                ms: Date.now() - start,
                err: err instanceof Error ? err.message : String(err)
            },
            `[timing] ${step} failed`
        )
        throw err
    }
}
