import type { Logger } from "@alto/utils"
import dotenv from "dotenv"
import logger, { pino, type SerializerFn } from "pino"
import { toHex } from "viem"

// Load environment variables from .env file
if (process.env.DOTENV_CONFIG_PATH) {
    dotenv.config({ path: process.env.DOTENV_CONFIG_PATH })
} else {
    dotenv.config()
}

// customFormatter.ts
// biome-ignore lint/suspicious/noExplicitAny: it's a generic type
type AnyObject = { [key: string]: any }

// biome-ignore lint/suspicious/noExplicitAny: it's a generic type
function bigintToJson(_key: string, value: any): any {
    if (typeof value === "bigint") {
        return toHex(value)
    }
    return value
}

function logLevel(label: string) {
    return {
        level: label
    }
}

function stringifyWithCircularHandling(
    obj: AnyObject,
    // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
    replacer?: (key: string, value: any) => any
): string {
    // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
    const cache: Set<any> = new Set()
    return JSON.stringify(obj, (key, value) => {
        if (typeof value === "object" && value !== null) {
            if (cache.has(value)) {
                return // Circular reference found, discard the key
            }
            cache.add(value)
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return replacer ? replacer(key, value) : value
    })
}

export const customSerializer: SerializerFn = (input: AnyObject): AnyObject => {
    const output: AnyObject = {}
    for (const key in input) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const value = input[key]
            if (typeof value === "object" && value !== null) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
                output[key] = JSON.parse(
                    stringifyWithCircularHandling(value, bigintToJson)
                )
            } else {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                output[key] = bigintToJson(key, value)
            }
        }
    }
    return output
}

// Fields injected into every log line via pino mixin. env is read from the
// environment at process start; networkName comes from the --network-name CLI
// arg (set via setNetworkName), falling back to the NETWORK_NAME env var;
// chainId is resolved after the RPC handshake (set via setChainId). Each
// defaults to "unknown" until set.
const ctx = {
    env: process.env.NODE_ENV ?? "unknown",
    networkName: process.env.NETWORK_NAME ?? "unknown",
    chainId: "unknown"
}

export const setChainId = (id: number): void => {
    ctx.chainId = String(id)
}

export const setNetworkName = (name: string | undefined): void => {
    if (name) {
        ctx.networkName = name
    }
}

// Return a fresh object each call: pino's default mixin merge does
// Object.assign(mixinResult, logObject), which would otherwise mutate the
// shared ctx and bleed per-call fields onto every later log line.
const loggerMixin = () => ({ ...ctx })

export const initDebugLogger = (level = "debug"): Logger => {
    const l = logger({
        transport: {
            target: "pino-pretty",
            options: {
                colorize: true
            }
        },
        mixin: loggerMixin,
        formatters: {
            level: logLevel,
            log: customSerializer
        }
    })

    l.level = level

    return l
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
let transport: any

if (process.env.BETTER_STACK_TOKEN) {
    const logtailOptions: { sourceToken: string; endpoint?: string } = {
        sourceToken: process.env.BETTER_STACK_TOKEN
    }
    if (process.env.BETTER_STACK_ENDPOINT) {
        logtailOptions.endpoint = process.env.BETTER_STACK_ENDPOINT
    }

    // @ts-ignore - pino.transport exists at runtime but types may be incomplete
    transport = pino.transport({
        target: "@logtail/pino",
        options: logtailOptions
    })

    let reviving = false
    function handleTransportError(err: Error) {
        try {
            console.error(`Logtail transport error: ${err.message}`)
            if (err.message === "the worker has exited" && !reviving) {
                reviving = true
                transport.write = () => true
                transport.end = () => {}

                setTimeout(() => {
                    try {
                        // @ts-ignore
                        const revived = pino.transport({
                            target: "@logtail/pino",
                            options: logtailOptions
                        })
                        revived.on("error", handleTransportError)
                        transport.write = revived.write.bind(revived)
                        transport.end = revived.end.bind(revived)
                        reviving = false
                        console.error("Logtail transport revived")
                    } catch {}
                }, 30_000).unref()
            }
        } catch {}
    }

    transport.on("error", handleTransportError)
}

export const initProductionLogger = (level: string): Logger => {
    if (!transport) {
        // No Betterstack token: emit single-line JSON to STDOUT so external
        // log shippers (syslog, Render's collector) treat each log as one
        // record. pino-pretty here splits structured objects across lines and
        // makes them unsearchable downstream.
        const l = pino({
            mixin: loggerMixin,
            formatters: {
                level: logLevel,
                log: customSerializer
            }
        })
        l.level = level
        return l
    }
    // No `level` formatter here: @logtail/pino's getLogLevel does numeric
    // comparisons on obj.level, so emitting a string label ("info") makes every
    // record fall through to "fatal". Keep level numeric for the transport;
    // only transform the log body so bigints are hex-encoded.
    const l = pino(
        {
            mixin: loggerMixin,
            formatters: {
                log: customSerializer
            }
        },
        transport
    )
    l.level = level
    return l
}
