import type { Logger } from "@alto/utils"
import {
    type Hex,
    type HttpTransport,
    type HttpTransportConfig,
    RpcRequestError,
    UrlRequiredError,
    createTransport,
    getAbiItem,
    isHex,
    slice,
    toFunctionSelector
} from "viem"
import { formatAbiItem, rpc } from "viem/utils"
import { simulationErrors } from "../rpc/estimation/utils"
import { EntryPointV06Abi } from "../types/contracts"

export function getRpcFetchOptions({
    rpcUrl,
    rpcBasicAuthUsername,
    rpcBasicAuthPassword
}: {
    rpcUrl: string
    rpcBasicAuthUsername?: string
    rpcBasicAuthPassword?: string
}): { headers: Record<string, string> } | undefined {
    const headers: Record<string, string> = {}

    // Basic auth
    if (rpcBasicAuthUsername && rpcBasicAuthPassword) {
        const credentials = `${rpcBasicAuthUsername}:${rpcBasicAuthPassword}`
        headers.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`
    }

    // Tenderly-specific header
    if (rpcUrl.includes("tenderly")) {
        headers["Accept-Encoding"] = "gzip"
    }

    return Object.keys(headers).length > 0 ? { headers } : undefined
}

export type RpcRequest = {
    jsonrpc?: "2.0" | undefined
    method: string
    params?: any | undefined
    id?: number | undefined
}

const EXECUTION_RESULT_SELECTOR = toFunctionSelector(
    formatAbiItem(
        getAbiItem({
            abi: EntryPointV06Abi,
            name: "ExecutionResult"
        })
    )
)

const VALIDATION_RESULT_SELECTOR = toFunctionSelector(
    formatAbiItem(
        getAbiItem({
            abi: EntryPointV06Abi,
            name: "ValidationResult"
        })
    )
)

const FAILED_OP_SELECTOR = toFunctionSelector(
    formatAbiItem(
        getAbiItem({
            abi: EntryPointV06Abi,
            name: "FailedOp"
        })
    )
)

// custom selector for when code overrides are used.
const CALLPHASE_REVERTED_SELECTOR = toFunctionSelector(
    formatAbiItem(
        getAbiItem({
            abi: simulationErrors,
            name: "CallPhaseReverted"
        })
    )
)

// Log the endpoint origin only (scheme + host): provider API keys live in
// the path (Alchemy) or the query string, so neither is safe to log.
export function sanitizeRpcUrl(url: string): string {
    try {
        return new URL(url).origin
    } catch {
        return "unparseable-url"
    }
}

// Header names from fetch's Headers.entries() are always lowercase.
const SUCCESS_HEADER_ALLOWLIST = new Set([
    "content-type",
    "retry-after",
    "cf-ray",
    "x-request-id",
    "x-envoy-upstream-service-time",
    "x-alchemy-trace-id"
])

// Success lines are the hottest log path in the fleet: keep only the headers
// with diagnostic value (rate-limit headroom, provider request ids) instead
// of the full map.
export function pickSuccessHeaders(
    headers: Record<string, string> | undefined
): Record<string, string> | undefined {
    if (!headers) {
        return undefined
    }
    return Object.fromEntries(
        Object.entries(headers).filter(
            ([headerName]) =>
                SUCCESS_HEADER_ALLOWLIST.has(headerName) ||
                headerName.startsWith("x-ratelimit-")
        )
    )
}

// Error lines get the full map for diagnosis, minus cookies: Cloudflare
// edges can set session cookies (__cf_bm) on RPC responses, which must not
// end up in logs.
export function stripSensitiveHeaders(
    headers: Record<string, string> | undefined
): Record<string, string> | undefined {
    if (!headers) {
        return undefined
    }
    const { "set-cookie": _setCookie, ...rest } = headers
    return rest
}

// Logging the full request and response of every upstream RPC call costs
// megabytes of JSON per pod per burst, all serialised by pino on the event
// loop while the same process is answering requests. The reducers below build
// bounded copies for the log lines only: they keep small allowlisted fields
// verbatim, replace everything large with its size, and never mutate the
// values the transport returns and throws.
const MAX_HEX_CHARS = 66
const MAX_STRING_CHARS = 200
const MAX_DEPTH = 4
const MAX_OBJECT_KEYS = 24
const MAX_ARRAY_ITEMS = 8

// Revert payloads get a far larger cap than the success path. They are what an
// operator decodes when an upstream revert is unexpected, a custom error with
// arguments is worthless as a bare selector, and the error path is not where
// the log volume is.
const MAX_ERROR_HEX_CHARS = 1024

// Hex is classified by the 0x prefix alone. Scanning every character of a
// 57 KB result to confirm it is really hex would make the reducer cost scale
// with the payload it exists to shrink.
function isHexLike(value: string): boolean {
    return value.startsWith("0x")
}

// Byte count comes from the string length, never from re-encoding. Clamped at
// zero so a value shorter than the 0x prefix cannot report negative bytes.
function hexByteLength(value: string): number {
    return Math.max(0, Math.floor((value.length - 2) / 2))
}

function truncateText(value: string): string {
    if (value.length <= MAX_STRING_CHARS) {
        return value
    }
    return `${value.slice(0, MAX_STRING_CHARS)}…(${value.length} chars)`
}

function reduceString(value: string): string {
    if (isHexLike(value)) {
        if (value.length <= MAX_HEX_CHARS) {
            return value
        }
        return `${value.slice(0, 10)}…(${hexByteLength(value)} bytes)`
    }
    return truncateText(value)
}

function reducerFailure(value: unknown): Record<string, unknown> {
    return { reducerFailed: true, type: typeof value }
}

// The depth cap is what makes this terminate on self-referencing objects, so
// no visited set is needed and the cost stays proportional to what is kept.
function reduceValue(value: unknown, depth: number): unknown {
    if (value === null || value === undefined) {
        return value
    }
    if (typeof value === "string") {
        return reduceString(value)
    }
    if (typeof value !== "object") {
        return value
    }
    if (depth >= MAX_DEPTH) {
        return "…(max depth)"
    }
    if (Array.isArray(value)) {
        const items: unknown[] = value
            .slice(0, MAX_ARRAY_ITEMS)
            .map((item) => reduceValue(item, depth + 1))
        if (value.length > MAX_ARRAY_ITEMS) {
            items.push(`…(${value.length} items)`)
        }
        return items
    }
    const source = value as Record<string, unknown>
    const keys = Object.keys(source)
    const reduced: Record<string, unknown> = {}
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
        reduced[key] = reduceValue(source[key], depth + 1)
    }
    if (keys.length > MAX_OBJECT_KEYS) {
        reduced["…"] = `(${keys.length} keys)`
    }
    return reduced
}

const RECEIPT_FIELDS = [
    "transactionHash",
    "blockNumber",
    "transactionIndex",
    "status",
    "from",
    "to",
    "gasUsed",
    "effectiveGasPrice",
    "gasPrice",
    "l1Fee"
]

const BLOCK_FIELDS = [
    "number",
    "hash",
    "parentHash",
    "timestamp",
    "baseFeePerGas",
    "gasUsed",
    "gasLimit",
    "l1BlockNumber"
]

const TRANSACTION_FIELDS = [
    "hash",
    "nonce",
    "from",
    "to",
    "blockNumber",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "gas"
]

function pickFields(
    source: Record<string, unknown>,
    fields: string[]
): Record<string, unknown> {
    const picked: Record<string, unknown> = {}
    for (const field of fields) {
        if (source[field] !== undefined) {
            picked[field] = source[field]
        }
    }
    return picked
}

// The custom tracer the bundler passes to debug_traceCall returns five arrays
// and nothing else worth logging. A trace tree is the largest and deepest
// response in the system, so it is summarised by size rather than left to the
// generic walk. Diagnosing a safe-mode validation failure needs the whole
// tree, which is what the debug log level is for.
const TRACE_ARRAY_FIELDS = [
    "callsFromEntryPoint",
    "keccak",
    "calls",
    "logs",
    "debug"
]

// The methods below dominate the log volume or the response size, so they get
// explicit reducers instead of the generic walk. Everything else falls
// through.
function reduceResultByMethod(
    method: string,
    source: Record<string, unknown>
): Record<string, unknown> | undefined {
    switch (method) {
        case "debug_traceCall": {
            const reduced: Record<string, unknown> = {}
            for (const field of TRACE_ARRAY_FIELDS) {
                if (Array.isArray(source[field])) {
                    reduced[`${field}Count`] = (
                        source[field] as unknown[]
                    ).length
                }
            }
            return reduced
        }
        case "eth_getTransactionReceipt": {
            const reduced = pickFields(source, RECEIPT_FIELDS)
            if (Array.isArray(source.logs)) {
                reduced.logsCount = source.logs.length
            }
            return reduced
        }
        case "eth_getBlockByNumber":
        case "eth_getBlockByHash": {
            const reduced = pickFields(source, BLOCK_FIELDS)
            if (Array.isArray(source.transactions)) {
                reduced.transactionsCount = source.transactions.length
            }
            return reduced
        }
        case "eth_getTransactionByHash": {
            const reduced = pickFields(source, TRANSACTION_FIELDS)
            if (typeof source.input === "string") {
                reduced.inputBytes = hexByteLength(source.input)
            }
            return reduced
        }
        default:
            return undefined
    }
}

function reduceErrorData(data: unknown): unknown {
    if (typeof data !== "string") {
        return reduceValue(data, 0)
    }
    if (!isHexLike(data)) {
        return truncateText(data)
    }
    if (data.length <= MAX_ERROR_HEX_CHARS) {
        return data
    }
    return { selector: data.slice(0, 10), bytes: hexByteLength(data) }
}

export function reduceLoggedValue(value: unknown): unknown {
    try {
        return reduceValue(value, 0)
    } catch {
        return reducerFailure(value)
    }
}

export function reduceLoggedResult(method: string, result: unknown): unknown {
    try {
        if (method === "eth_getLogs" && Array.isArray(result)) {
            return { count: result.length }
        }
        if (
            result !== null &&
            typeof result === "object" &&
            !Array.isArray(result)
        ) {
            const reduced = reduceResultByMethod(
                method,
                result as Record<string, unknown>
            )
            if (reduced) {
                return reduced
            }
        }
        return reduceValue(result, 0)
    } catch {
        return reducerFailure(result)
    }
}

export function reduceLoggedError(error: unknown): unknown {
    try {
        if (error === null || typeof error !== "object") {
            return reduceValue(error, 0)
        }
        const source = error as Record<string, unknown>
        const reduced: Record<string, unknown> = {}

        // `error` comes straight off the upstream response, so even the fields
        // that are normally a short class name and a small integer go through
        // the reducer rather than being copied verbatim.
        if (source.name !== undefined) {
            reduced.name = reduceValue(source.name, 0)
        }
        if (source.code !== undefined) {
            reduced.code = reduceValue(source.code, 0)
        }
        for (const field of ["message", "shortMessage", "details"]) {
            const value = source[field]
            if (typeof value === "string") {
                reduced[field] = truncateText(value)
            } else if (value !== undefined) {
                reduced[field] = reduceValue(value, 0)
            }
        }
        if (source.data !== undefined) {
            reduced.data = reduceErrorData(source.data)
        }
        return reduced
    } catch {
        return reducerFailure(error)
    }
}

export function reduceLoggedBody(body: {
    method: string
    params?: unknown
}): unknown {
    try {
        return { method: body.method, params: reduceLoggedValue(body.params) }
    } catch {
        return reducerFailure(body)
    }
}

export function customTransport(
    /** URL of the JSON-RPC API. Defaults to the chain's public RPC URL. */
    url_: string,
    config: HttpTransportConfig & { logger: Logger }
): HttpTransport {
    const {
        fetchOptions,
        key = "http",
        name = "HTTP JSON-RPC",
        retryDelay,
        logger
    } = config

    return ({ chain, retryCount: retryCount_, timeout: timeout_ }) => {
        const retryCount = config.retryCount ?? retryCount_
        const timeout = timeout_ ?? config.timeout ?? 10_000
        const url = url_ || chain?.rpcUrls.default.http[0]
        if (!url) {
            throw new UrlRequiredError()
        }

        const sanitizedUrl = sanitizeRpcUrl(url)
        const chainId = chain ? String(chain.id) : undefined
        const chainTag = chainId ? ` [chain ${chainId}]` : ""

        return createTransport(
            {
                key,
                name,
                async request({ method, params }) {
                    const body = { method, params }
                    const start = performance.now()
                    let responseHeaders: Record<string, string> | undefined
                    // viem's timeout covers only up to headers; the body read is unbounded.
                    let headersAt: number | undefined
                    const fn = async (body: RpcRequest) => {
                        return [
                            await rpc.http(url, {
                                body,
                                fetchOptions,
                                onResponse: (response) => {
                                    headersAt = performance.now()
                                    responseHeaders = Object.fromEntries(
                                        response.headers.entries()
                                    )
                                },
                                timeout
                            })
                        ]
                    }

                    const [{ error, result }] = await fn(body)
                    const ms = Number((performance.now() - start).toFixed(2))
                    const headersAtMs =
                        ms > 500 && headersAt !== undefined
                            ? Number((headersAt - start).toFixed(2))
                            : undefined
                    // Escape hatch: --public-client-log-level debug (or the
                    // wallet equivalent) puts the untouched payloads back in
                    // the logs. Resolved once per call, not once per field.
                    const logFullPayload = logger.isLevelEnabled("debug")
                    if (error) {
                        let loggerFn = logger.error.bind(logger)

                        if (isHex(error?.data) && error?.data?.length > 10) {
                            const errorSelector = slice(error?.data, 0, 4)

                            if (
                                [
                                    EXECUTION_RESULT_SELECTOR,
                                    VALIDATION_RESULT_SELECTOR,
                                    FAILED_OP_SELECTOR,
                                    CALLPHASE_REVERTED_SELECTOR
                                ].includes(errorSelector as Hex)
                            ) {
                                loggerFn = logger.info.bind(logger)
                            }
                        }

                        loggerFn(
                            {
                                err: logFullPayload
                                    ? error
                                    : reduceLoggedError(error),
                                body: logFullPayload
                                    ? body
                                    : reduceLoggedBody(body),
                                method,
                                ms,
                                headersAtMs,
                                success: false,
                                chainId,
                                url: sanitizedUrl,
                                responseHeaders:
                                    stripSensitiveHeaders(responseHeaders)
                            },
                            `upstream RPC ${method} to ${sanitizedUrl}${chainTag} failed after ${ms}ms`
                        )

                        throw new RpcRequestError({
                            body,
                            error: {
                                ...error,
                                // 24 Aug 2024, etherlink throws -32003 error code for eth_call
                                code:
                                    method === "eth_call" &&
                                    error.code === -32003
                                        ? 3
                                        : error.code
                            },
                            url: url
                        })
                    }
                    logger.info(
                        {
                            body: logFullPayload
                                ? body
                                : reduceLoggedBody(body),
                            result: logFullPayload
                                ? result
                                : reduceLoggedResult(method, result),
                            method,
                            ms,
                            headersAtMs,
                            success: true,
                            chainId,
                            url: sanitizedUrl,
                            responseHeaders: pickSuccessHeaders(responseHeaders)
                        },
                        `upstream RPC ${method} to ${sanitizedUrl}${chainTag} succeeded in ${ms}ms`
                    )
                    return result
                },
                retryCount,
                retryDelay,
                timeout,
                type: "http"
            },
            {
                fetchOptions,
                url
            }
        )
    }
}
