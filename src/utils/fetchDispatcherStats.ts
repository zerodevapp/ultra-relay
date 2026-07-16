import type { Logger } from "pino"
import type { Dispatcher } from "undici"

// Per-origin count of fetch requests "awaiting a socket": dispatched to the
// connection pool but not yet written to a connection — queued for a free
// connection (undici pool saturation) or waiting on DNS/TLS setup (the
// Jul 15-16 Base incident mode).
//
// Implemented as a dispatcher interceptor (undici's documented compose() /
// dispatch-handler API) rather than undici's diagnostics channels, because
// (verified against undici 6.27.0 source and empirically):
// - requests queued at the Pool level (past the `connections` cap) never
//   construct a Request object, so undici:request:create doesn't fire for
//   them — the diagnostics approach reads ZERO during true pool saturation
// - the HTTP/2 client path never publishes undici:client:sendHeaders
// - diagnostics channels are process-global; the interceptor only counts
//   traffic through the Agent it is composed onto
// UNDO: once the fleet runs Node >= 20.18.1, upgrade undici to ^7 and
// replace this module with getGlobalDispatcher().stats.

type OriginStats = {
    awaitingSocket: number
    peakAwaitingSocket: number
}

const statsByOrigin = new Map<string, OriginStats>()

// settle callbacks: the request has reached a socket (onConnect fires right
// before headers are written, on both the h1 and h2 paths) or terminally
// failed (onError fires for failures at any stage, including aborts while
// still queued at the pool level). onHeaders is a belt-and-braces settle for
// any exotic dispatch path that skips onConnect.
const SETTLE_HOOKS = ["onConnect", "onHeaders", "onError"]

function normalizeOrigin(origin: unknown): string | null {
    if (typeof origin === "string") {
        return origin
    }
    // URL.origin strips path/query/userinfo, keeping API keys and basic-auth
    // credentials out of metric labels and logs
    if (origin instanceof URL) {
        return origin.origin
    }
    return null
}

function increment(origin: string) {
    let stats = statsByOrigin.get(origin)
    if (!stats) {
        stats = { awaitingSocket: 0, peakAwaitingSocket: 0 }
        statsByOrigin.set(origin, stats)
    }
    stats.awaitingSocket += 1
    if (stats.awaitingSocket > stats.peakAwaitingSocket) {
        stats.peakAwaitingSocket = stats.awaitingSocket
    }
}

function decrement(origin: string) {
    const stats = statsByOrigin.get(origin)
    if (stats && stats.awaitingSocket > 0) {
        stats.awaitingSocket -= 1
    }
}

export const awaitingSocketInterceptor = (
    dispatch: Dispatcher["dispatch"]
): Dispatcher["dispatch"] => {
    return (opts, handler) => {
        const origin = normalizeOrigin(opts.origin)
        if (!origin) {
            return dispatch(opts, handler)
        }

        increment(origin)
        let settled = false
        const settle = () => {
            if (!settled) {
                settled = true
                decrement(origin)
            }
        }

        // Proxy instead of object spread so handler methods that live on a
        // class prototype (e.g. fetch's RequestHandler) are preserved and
        // undici's `typeof handler.onX === "function"` probes see the same
        // shape as the original handler.
        const wrapped = new Proxy(handler, {
            get(target, prop, receiver) {
                const value: unknown = Reflect.get(target, prop, receiver)
                if (typeof value !== "function") {
                    return value
                }
                if (SETTLE_HOOKS.includes(prop as string)) {
                    return (...args: unknown[]) => {
                        settle()
                        return value.apply(target, args)
                    }
                }
                return value.bind(target)
            }
        })

        try {
            return dispatch(opts, wrapped)
        } catch (err) {
            settle()
            throw err
        }
    }
}

export function getAwaitingSocketCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const [origin, stats] of statsByOrigin) {
        counts.set(origin, stats.awaitingSocket)
    }
    return counts
}

export function startFetchDispatcherHeartbeat(
    logger: Logger,
    intervalMs = 300_000
): void {
    const timer = setInterval(() => {
        // observability must never take the process down
        try {
            const origins: Record<string, OriginStats> = {}
            for (const [origin, stats] of statsByOrigin) {
                origins[origin] = { ...stats }
                if (
                    stats.awaitingSocket === 0 &&
                    stats.peakAwaitingSocket === 0
                ) {
                    // idle all window: drop the entry to keep the map and
                    // metric label set bounded to active origins
                    statsByOrigin.delete(origin)
                } else {
                    // peak is per heartbeat window
                    stats.peakAwaitingSocket = stats.awaitingSocket
                }
            }
            logger.info({ origins }, "fetch dispatcher stats")
        } catch {
            // swallow: a failing logger must not crash the bundler
        }
    }, intervalMs)
    timer.unref()
}
