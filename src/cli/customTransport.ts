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
    "x-request-id"
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
                    const fn = async (body: RpcRequest) => {
                        return [
                            await rpc.http(url, {
                                body,
                                fetchOptions,
                                onResponse: (response) => {
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
                                err: error,
                                body,
                                method,
                                ms,
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
                            body,
                            result,
                            method,
                            ms,
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
