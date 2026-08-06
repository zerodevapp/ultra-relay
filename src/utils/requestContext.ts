import { AsyncLocalStorage } from "node:async_hooks"

// Per-async-flow log context. Entered once at a flow boundary (RPC request,
// bundle submission, block handling) and injected into every log line by the
// pino mixin in logger.ts, so all logs -- including upstream RPC transport
// logs -- can be attributed to the userop or bundle that caused them.
export type LogContext = {
    flow?: string
    userOpHash?: string
    userOpHashes?: string[]
}

const storage = new AsyncLocalStorage<LogContext>()

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
    return storage.run(ctx, fn)
}

// Merge fields into the current context (e.g. set userOpHash once it is
// computed mid-flow). No-op when called outside runWithLogContext.
export function addLogContext(fields: Partial<LogContext>): void {
    const current = storage.getStore()
    if (current) {
        Object.assign(current, fields)
    }
}

export function getLogContext(): LogContext | undefined {
    return storage.getStore()
}
