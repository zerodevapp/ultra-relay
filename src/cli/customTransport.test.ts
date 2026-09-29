import { type Server, createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Logger } from "pino"
import {
    HttpRequestError,
    MethodNotFoundRpcError,
    getAbiItem,
    toFunctionSelector
} from "viem"
import { formatAbiItem } from "viem/utils"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { EntryPointV06Abi } from "../types/contracts"
import {
    customTransport,
    pickSuccessHeaders,
    reduceLoggedBody,
    reduceLoggedError,
    reduceLoggedResult,
    reduceLoggedValue,
    sanitizeRpcUrl,
    stripSensitiveHeaders
} from "./customTransport"

const hex = (bytes: number) => `0x${"ab".repeat(bytes)}`

describe("sanitizeRpcUrl", () => {
    it("drops a path-based API key (Alchemy style)", () => {
        expect(
            sanitizeRpcUrl("https://base-mainnet.g.alchemy.com/v2/sk-SECRET")
        ).toBe("https://base-mainnet.g.alchemy.com")
    })

    it("drops a query-based API key", () => {
        expect(
            sanitizeRpcUrl("https://rpc.example.com/?apikey=sk-SECRET")
        ).toBe("https://rpc.example.com")
    })

    it("drops basic-auth userinfo", () => {
        expect(sanitizeRpcUrl("https://user:secret@rpc.example.com/path")).toBe(
            "https://rpc.example.com"
        )
    })

    it("keeps a non-default port", () => {
        expect(sanitizeRpcUrl("http://127.0.0.1:8545/")).toBe(
            "http://127.0.0.1:8545"
        )
    })

    it("returns a fixed marker for garbage input", () => {
        expect(sanitizeRpcUrl("not a url")).toBe("unparseable-url")
    })
})

describe("pickSuccessHeaders", () => {
    it("keeps only allowlisted and x-ratelimit-* headers", () => {
        expect(
            pickSuccessHeaders({
                "content-type": "application/json",
                "retry-after": "1",
                "cf-ray": "abc-BOM",
                "x-request-id": "req-1",
                "x-ratelimit-remaining": "99",
                "x-envoy-upstream-service-time": "12",
                "x-alchemy-trace-id": "trace-1",
                "set-cookie": "__cf_bm=SECRET",
                "alt-svc": "h3",
                server: "cloudflare"
            })
        ).toEqual({
            "content-type": "application/json",
            "retry-after": "1",
            "cf-ray": "abc-BOM",
            "x-request-id": "req-1",
            "x-ratelimit-remaining": "99",
            "x-envoy-upstream-service-time": "12",
            "x-alchemy-trace-id": "trace-1"
        })
    })

    it("passes undefined through", () => {
        expect(pickSuccessHeaders(undefined)).toBeUndefined()
    })
})

describe("stripSensitiveHeaders", () => {
    it("removes set-cookie and keeps everything else", () => {
        expect(
            stripSensitiveHeaders({
                "set-cookie": "__cf_bm=SECRET",
                "cf-ray": "abc-BOM",
                server: "cloudflare"
            })
        ).toEqual({ "cf-ray": "abc-BOM", server: "cloudflare" })
    })

    it("passes undefined through", () => {
        expect(stripSensitiveHeaders(undefined)).toBeUndefined()
    })
})

describe("reduceLoggedValue", () => {
    it("keeps null, booleans and numbers", () => {
        expect(reduceLoggedValue(null)).toBe(null)
        expect(reduceLoggedValue(true)).toBe(true)
        expect(reduceLoggedValue(0)).toBe(0)
        expect(reduceLoggedValue({ a: null, b: false, c: 12 })).toEqual({
            a: null,
            b: false,
            c: 12
        })
    })

    it("keeps hex of 66 characters or less", () => {
        const word = `0x${"0".repeat(64)}`
        expect(word).toHaveLength(66)
        expect(reduceLoggedValue(word)).toBe(word)
        expect(reduceLoggedValue("0x1")).toBe("0x1")
    })

    it("summarises hex longer than 66 characters", () => {
        expect(reduceLoggedValue(hex(1000))).toBe("0xabababab…(1000 bytes)")
    })

    it("keeps non-hex strings of 200 characters or less", () => {
        const text = "z".repeat(200)
        expect(reduceLoggedValue(text)).toBe(text)
    })

    it("cuts non-hex strings longer than 200 characters", () => {
        const text = "z".repeat(250)
        expect(reduceLoggedValue(text)).toBe(`${"z".repeat(200)}…(250 chars)`)
    })

    it("cuts arrays at 8 items and records the original length", () => {
        expect(reduceLoggedValue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            "…(10 items)"
        ])
    })

    it("keeps arrays of 8 items or fewer intact", () => {
        expect(reduceLoggedValue([1, 2, 3])).toEqual([1, 2, 3])
    })

    it("cuts objects at 24 keys and records the original key count", () => {
        const wide: Record<string, number> = {}
        for (let i = 0; i < 30; i++) {
            wide[`k${i}`] = i
        }
        const reduced = reduceLoggedValue(wide) as Record<string, unknown>
        expect(Object.keys(reduced)).toHaveLength(25)
        expect(reduced.k23).toBe(23)
        expect(reduced.k24).toBeUndefined()
        expect(reduced["…"]).toBe("(30 keys)")
    })

    it("stops at depth 4", () => {
        expect(
            reduceLoggedValue({ a: { b: { c: { d: { e: "deep" } } } } })
        ).toEqual({ a: { b: { c: { d: "…(max depth)" } } } })
    })

    it("terminates on a self-referencing object", () => {
        const loop: Record<string, unknown> = {}
        loop.self = loop
        expect(reduceLoggedValue(loop)).toEqual({
            self: { self: { self: { self: "…(max depth)" } } }
        })
    })

    it("reports a failure marker instead of throwing", () => {
        const exploding = {
            get boom() {
                throw new Error("nope")
            }
        }
        expect(reduceLoggedValue(exploding)).toEqual({
            reducerFailed: true,
            type: "object"
        })
    })

    it("does not mutate the value it reduces", () => {
        const original = {
            calldata: hex(2000),
            note: "z".repeat(250),
            items: [1, 2, 3, 4, 5, 6, 7, 8, 9]
        }
        const before = structuredClone(original)
        reduceLoggedValue(original)
        expect(original).toEqual(before)
    })
})

describe("reduceLoggedResult", () => {
    it("logs a null result as null", () => {
        expect(reduceLoggedResult("eth_getTransactionReceipt", null)).toBe(null)
        expect(reduceLoggedResult("eth_getBlockByNumber", null)).toBe(null)
    })

    it("keeps short hex results unchanged", () => {
        expect(reduceLoggedResult("eth_chainId", "0x2105")).toBe("0x2105")
        expect(
            reduceLoggedResult("eth_sendRawTransaction", `0x${"1".repeat(64)}`)
        ).toBe(`0x${"1".repeat(64)}`)
    })

    it("summarises a long eth_call result", () => {
        const result = reduceLoggedResult("eth_call", hex(20_000))
        expect(result).toBe("0xabababab…(20000 bytes)")
        expect(JSON.stringify(result).length).toBeLessThan(100)
    })

    describe("eth_getTransactionReceipt", () => {
        const receipt = {
            transactionHash: `0x${"1".repeat(64)}`,
            blockHash: `0x${"2".repeat(64)}`,
            blockNumber: "0x1234",
            transactionIndex: "0x2",
            status: "0x1",
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x3b9aca00",
            cumulativeGasUsed: "0x9999",
            logsBloom: hex(256),
            type: "0x2",
            logs: [{ data: hex(500) }, { data: hex(500) }]
        }

        it("keeps the diagnostic fields and counts the logs", () => {
            expect(
                reduceLoggedResult("eth_getTransactionReceipt", receipt)
            ).toEqual({
                transactionHash: receipt.transactionHash,
                blockNumber: "0x1234",
                transactionIndex: "0x2",
                status: "0x1",
                from: receipt.from,
                to: receipt.to,
                gasUsed: "0x5208",
                effectiveGasPrice: "0x3b9aca00",
                logsCount: 2
            })
        })

        it("falls back to gasPrice when effectiveGasPrice is absent", () => {
            const { effectiveGasPrice: _dropped, ...rest } = receipt
            const reduced = reduceLoggedResult("eth_getTransactionReceipt", {
                ...rest,
                gasPrice: "0x3b9aca00"
            }) as Record<string, unknown>
            expect(reduced.effectiveGasPrice).toBeUndefined()
            expect(reduced.gasPrice).toBe("0x3b9aca00")
        })

        it("keeps l1Fee on OP-stack receipts", () => {
            const reduced = reduceLoggedResult("eth_getTransactionReceipt", {
                ...receipt,
                l1Fee: "0x123"
            }) as Record<string, unknown>
            expect(reduced.l1Fee).toBe("0x123")
        })

        it("reduces a 12-log receipt to under 1500 characters", () => {
            const fat = {
                ...receipt,
                logs: Array.from({ length: 12 }, () => ({
                    address: "0x3333333333333333333333333333333333333333",
                    topics: [`0x${"4".repeat(64)}`],
                    data: hex(500)
                }))
            }
            const reduced = reduceLoggedResult("eth_getTransactionReceipt", fat)
            expect((reduced as Record<string, unknown>).logsCount).toBe(12)
            expect(JSON.stringify(reduced).length).toBeLessThan(1500)
        })

        it("does not mutate the receipt", () => {
            const before = structuredClone(receipt)
            reduceLoggedResult("eth_getTransactionReceipt", receipt)
            expect(receipt).toEqual(before)
        })
    })

    describe("blocks", () => {
        const block = {
            number: "0x100",
            hash: `0x${"5".repeat(64)}`,
            parentHash: `0x${"6".repeat(64)}`,
            timestamp: "0x66e0",
            baseFeePerGas: "0x7",
            gasUsed: "0x1c9c380",
            gasLimit: "0x1c9c380",
            l1BlockNumber: "0xff",
            extraData: hex(100),
            transactions: Array.from(
                { length: 300 },
                (_, i) => `0x${String(i).padStart(64, "0")}`
            )
        }

        it("counts transaction hashes for eth_getBlockByNumber", () => {
            expect(reduceLoggedResult("eth_getBlockByNumber", block)).toEqual({
                number: "0x100",
                hash: block.hash,
                parentHash: block.parentHash,
                timestamp: "0x66e0",
                baseFeePerGas: "0x7",
                gasUsed: "0x1c9c380",
                gasLimit: "0x1c9c380",
                l1BlockNumber: "0xff",
                transactionsCount: 300
            })
        })

        it("counts full transaction objects too", () => {
            const reduced = reduceLoggedResult("eth_getBlockByHash", {
                ...block,
                transactions: [{ input: hex(2000) }, { input: hex(2000) }]
            }) as Record<string, unknown>
            expect(reduced.transactionsCount).toBe(2)
            expect(JSON.stringify(reduced).length).toBeLessThan(1000)
        })
    })

    it("replaces the input of eth_getTransactionByHash with a byte count", () => {
        expect(
            reduceLoggedResult("eth_getTransactionByHash", {
                hash: `0x${"7".repeat(64)}`,
                nonce: "0x1",
                from: "0x1111111111111111111111111111111111111111",
                to: "0x2222222222222222222222222222222222222222",
                blockNumber: "0x100",
                maxFeePerGas: "0x9",
                maxPriorityFeePerGas: "0x1",
                gas: "0x5208",
                r: `0x${"8".repeat(64)}`,
                input: hex(4000)
            })
        ).toEqual({
            hash: `0x${"7".repeat(64)}`,
            nonce: "0x1",
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            blockNumber: "0x100",
            maxFeePerGas: "0x9",
            maxPriorityFeePerGas: "0x1",
            gas: "0x5208",
            inputBytes: 4000
        })
    })

    it("never reports a negative input size", () => {
        expect(
            reduceLoggedResult("eth_getTransactionByHash", { input: "" })
        ).toEqual({ inputBytes: 0 })
        expect(
            reduceLoggedResult("eth_getTransactionByHash", { input: "0x" })
        ).toEqual({ inputBytes: 0 })
    })

    it("replaces an eth_getLogs array with a count", () => {
        expect(reduceLoggedResult("eth_getLogs", [{ data: hex(500) }])).toEqual(
            { count: 1 }
        )
    })

    it("falls back to the generic reducer for other methods", () => {
        expect(
            reduceLoggedResult("eth_feeHistory", {
                oldestBlock: "0x5208",
                blob: hex(3000),
                reward: [[hex(3000)]]
            })
        ).toEqual({
            oldestBlock: "0x5208",
            blob: "0xabababab…(3000 bytes)",
            reward: [["0xabababab…(3000 bytes)"]]
        })
    })

    describe("debug_traceCall", () => {
        // Shape of BundlerTracerResult, the custom tracer the bundler passes.
        const trace = {
            callsFromEntryPoint: [
                { opcodes: { CALL: 3 }, access: {}, contractSize: {} },
                { opcodes: { SSTORE: 9 }, access: {}, contractSize: {} }
            ],
            keccak: Array.from({ length: 40 }, () => hex(64)),
            calls: Array.from({ length: 120 }, () => ({
                type: "RETURN",
                gasUsed: 21000,
                data: hex(400)
            })),
            logs: Array.from({ length: 12 }, () => ({
                topics: [hex(32)],
                data: hex(200)
            })),
            debug: []
        }

        it("summarises every array by size", () => {
            expect(reduceLoggedResult("debug_traceCall", trace)).toEqual({
                callsFromEntryPointCount: 2,
                keccakCount: 40,
                callsCount: 120,
                logsCount: 12,
                debugCount: 0
            })
        })

        it("bounds the largest response in the system", () => {
            const reduced = reduceLoggedResult("debug_traceCall", trace)
            expect(JSON.stringify(reduced).length).toBeLessThan(150)
        })

        it("omits arrays the tracer did not return", () => {
            expect(
                reduceLoggedResult("debug_traceCall", { keccak: [] })
            ).toEqual({ keccakCount: 0 })
        })

        it("does not mutate the trace", () => {
            const before = structuredClone(trace)
            reduceLoggedResult("debug_traceCall", trace)
            expect(trace).toEqual(before)
        })
    })
})

describe("reduceLoggedError", () => {
    it("keeps a revert payload whole up to 1024 characters", () => {
        const data = `0x8b7ac980${"0".repeat(1014)}`
        expect(data).toHaveLength(1024)
        expect(
            reduceLoggedError({
                code: 3,
                message: "execution reverted",
                data
            })
        ).toEqual({
            code: 3,
            message: "execution reverted",
            data
        })
    })

    it("summarises a revert payload past 1024 characters", () => {
        expect(
            reduceLoggedError({
                code: 3,
                message: "execution reverted",
                data: `0x8b7ac980${"0".repeat(2000)}`
            })
        ).toEqual({
            code: 3,
            message: "execution reverted",
            data: { selector: "0x8b7ac980", bytes: 1004 }
        })
    })

    it("keeps hex data too short to carry a selector", () => {
        expect(
            reduceLoggedError({ code: 3, message: "reverted", data: "0x1234" })
        ).toEqual({
            code: 3,
            message: "reverted",
            data: "0x1234"
        })
        expect(
            (reduceLoggedError({ data: "0x" }) as Record<string, unknown>).data
        ).toBe("0x")
    })

    it("cuts non-hex string data at 200 characters", () => {
        const reduced = reduceLoggedError({
            code: -32000,
            data: "reason: ".concat("z".repeat(300))
        }) as Record<string, unknown>
        expect(reduced.data).toBe(`reason: ${"z".repeat(192)}…(308 chars)`)
    })

    it("runs the generic reducer over object data", () => {
        expect(
            reduceLoggedError({
                code: -32015,
                data: { reason: "reverted", raw: hex(900) }
            })
        ).toEqual({
            code: -32015,
            data: { reason: "reverted", raw: "0xabababab…(900 bytes)" }
        })
    })

    it("omits data when the error carries none", () => {
        const reduced = reduceLoggedError({
            name: "HttpRequestError",
            code: 429,
            message: "Too Many Requests",
            shortMessage: "rate limited",
            details: "upstream returned 429"
        }) as Record<string, unknown>
        expect(reduced).toEqual({
            name: "HttpRequestError",
            code: 429,
            message: "Too Many Requests",
            shortMessage: "rate limited",
            details: "upstream returned 429"
        })
        expect("data" in reduced).toBe(false)
    })

    it("cuts message, shortMessage and details at 200 characters", () => {
        const long = "z".repeat(260)
        expect(
            reduceLoggedError({
                message: long,
                shortMessage: long,
                details: long
            })
        ).toEqual({
            message: `${"z".repeat(200)}…(260 chars)`,
            shortMessage: `${"z".repeat(200)}…(260 chars)`,
            details: `${"z".repeat(200)}…(260 chars)`
        })
    })

    it("bounds an oversized name or code from a malformed upstream", () => {
        expect(
            reduceLoggedError({
                name: "E".repeat(400),
                code: "F".repeat(400),
                message: "boom"
            })
        ).toEqual({
            name: `${"E".repeat(200)}…(400 chars)`,
            code: `${"F".repeat(200)}…(400 chars)`,
            message: "boom"
        })
    })

    it("does not mutate the error it summarises", () => {
        const error = {
            code: 3,
            message: "execution reverted",
            data: `0x8b7ac980${"0".repeat(2000)}`
        }
        const before = structuredClone(error)
        reduceLoggedError(error)
        expect(error).toEqual(before)
    })
})

describe("reduceLoggedBody", () => {
    it("keeps the method and reduces eth_call params with state overrides", () => {
        const body = {
            method: "eth_call",
            params: [
                {
                    to: "0x1111111111111111111111111111111111111111",
                    data: hex(3000)
                },
                "latest",
                {
                    "0x2222222222222222222222222222222222222222": {
                        code: hex(9000)
                    }
                }
            ]
        }
        expect(reduceLoggedBody(body)).toEqual({
            method: "eth_call",
            params: [
                {
                    to: "0x1111111111111111111111111111111111111111",
                    data: "0xabababab…(3000 bytes)"
                },
                "latest",
                {
                    "0x2222222222222222222222222222222222222222": {
                        code: "0xabababab…(9000 bytes)"
                    }
                }
            ]
        })
    })

    it("summarises the raw transaction of eth_sendRawTransaction", () => {
        const body = { method: "eth_sendRawTransaction", params: [hex(4000)] }
        const reduced = reduceLoggedBody(body)
        expect(reduced).toEqual({
            method: "eth_sendRawTransaction",
            params: ["0xabababab…(4000 bytes)"]
        })
        expect(JSON.stringify(reduced).length).toBeLessThan(100)
    })

    it("passes a params-less body through", () => {
        expect(reduceLoggedBody({ method: "eth_chainId" })).toEqual({
            method: "eth_chainId",
            params: undefined
        })
    })

    it("does not mutate the body it reduces", () => {
        const body = {
            method: "eth_call",
            params: [{ data: hex(3000) }, "latest"]
        }
        const before = structuredClone(body)
        reduceLoggedBody(body)
        expect(body).toEqual(before)
    })
})

describe("customTransport log lines", () => {
    const EXECUTION_RESULT_SELECTOR = toFunctionSelector(
        formatAbiItem(
            getAbiItem({ abi: EntryPointV06Abi, name: "ExecutionResult" })
        )
    )

    type LogLine = {
        level: "info" | "error"
        obj: Record<string, unknown>
        msg: string
    }

    let server: Server
    let baseUrl: string
    let nextResponse: Record<string, unknown> = {}

    beforeAll(async () => {
        server = createServer((req, res) => {
            req.on("data", () => {})
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                    JSON.stringify({ jsonrpc: "2.0", id: 1, ...nextResponse })
                )
            })
        })
        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve)
        })
        const { port } = server.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve())
        })
    })

    const callTransport = async ({
        method,
        params,
        response,
        debug = false
    }: {
        method: string
        params?: unknown
        response: Record<string, unknown>
        debug?: boolean
    }) => {
        nextResponse = response
        const lines: LogLine[] = []
        const record =
            (level: "info" | "error") =>
            (obj: Record<string, unknown>, msg: string) => {
                lines.push({ level, obj, msg })
            }
        const logger = {
            isLevelEnabled: () => debug,
            info: record("info"),
            error: record("error")
        } as unknown as Logger

        const transport = customTransport(baseUrl, { logger, retryCount: 0 })(
            {}
        )

        let result: unknown
        let thrown: unknown
        try {
            result = await transport.request({ method, params })
        } catch (error) {
            thrown = error
        }
        return { lines, result, thrown }
    }

    // Viem rethrows the transport's RpcRequestError untouched for a code it
    // does not recognise, but wraps it in one of its own error classes for the
    // standard JSON-RPC codes, so look for the payload along the cause chain.
    const findErrorData = (error: unknown): unknown => {
        let current = error as { data?: unknown; cause?: unknown } | undefined
        while (current) {
            if (typeof current.data === "string") {
                return current.data
            }
            current = current.cause as typeof current
        }
        return undefined
    }

    it("returns the result unchanged and logs a reduced copy", async () => {
        const { lines, result } = await callTransport({
            method: "eth_call",
            params: [{ to: `0x${"1".repeat(40)}`, data: hex(3000) }, "latest"],
            response: { result: hex(20_000) }
        })

        expect(result).toBe(hex(20_000))
        expect(lines).toHaveLength(1)

        const [line] = lines
        expect(line.level).toBe("info")
        expect(line.msg).toBe(
            `upstream RPC eth_call to ${baseUrl} succeeded in ${line.obj.ms}ms`
        )
        expect(Object.keys(line.obj).sort()).toEqual([
            "body",
            "chainId",
            "headersAtMs",
            "method",
            "ms",
            "responseHeaders",
            "result",
            "success",
            "url"
        ])
        expect(line.obj.body).toEqual({
            method: "eth_call",
            params: [
                {
                    to: `0x${"1".repeat(40)}`,
                    data: "0xabababab…(3000 bytes)"
                },
                "latest"
            ]
        })
        expect(line.obj.result).toBe("0xabababab…(20000 bytes)")
        expect(line.obj.method).toBe("eth_call")
        expect(line.obj.success).toBe(true)
        expect(line.obj.url).toBe(baseUrl)
        expect(line.obj.responseHeaders).toEqual({
            "content-type": "application/json"
        })
    })

    it("logs the full payload when the logger has debug enabled", async () => {
        const { lines, result } = await callTransport({
            method: "eth_call",
            params: [{ data: hex(3000) }],
            response: { result: hex(20_000) },
            debug: true
        })

        expect(result).toBe(hex(20_000))
        expect(lines[0].obj.result).toBe(hex(20_000))
        expect(lines[0].obj.body).toEqual({
            method: "eth_call",
            params: [{ data: hex(3000) }]
        })
    })

    it("reduces the failure line but still throws the full revert data", async () => {
        const data = `0xdeadbeef${"0".repeat(2000)}`
        const { lines, thrown } = await callTransport({
            method: "eth_call",
            params: [{ data: hex(3000) }],
            response: {
                error: { code: 3, message: "execution reverted", data }
            }
        })

        expect(lines).toHaveLength(1)
        const [line] = lines
        expect(line.level).toBe("error")
        expect(line.msg).toBe(
            `upstream RPC eth_call to ${baseUrl} failed after ${line.obj.ms}ms`
        )
        expect(Object.keys(line.obj).sort()).toEqual([
            "body",
            "chainId",
            "err",
            "headersAtMs",
            "method",
            "ms",
            "responseHeaders",
            "success",
            "url"
        ])
        expect(line.obj.err).toEqual({
            code: 3,
            message: "execution reverted",
            data: { selector: "0xdeadbeef", bytes: 1004 }
        })
        expect(line.obj.success).toBe(false)
        expect(findErrorData(thrown)).toBe(data)
    })

    it("still downgrades expected simulation reverts to info", async () => {
        const { lines } = await callTransport({
            method: "eth_call",
            params: [],
            response: {
                error: {
                    code: 3,
                    message: "execution reverted",
                    data: `${EXECUTION_RESULT_SELECTOR}${"0".repeat(4000)}`
                }
            }
        })

        expect(lines[0].level).toBe("info")
        expect(
            (lines[0].obj.err as { data: Record<string, unknown> }).data
        ).toEqual({ selector: EXECUTION_RESULT_SELECTOR, bytes: 2004 })
    })

    it("logs a null result as null", async () => {
        const { lines, result } = await callTransport({
            method: "eth_getTransactionReceipt",
            params: [`0x${"1".repeat(64)}`],
            response: { result: null }
        })

        expect(result).toBe(null)
        expect(lines[0].obj.result).toBe(null)
    })
})

describe("customTransport HTTP status retries", () => {
    type Reply = {
        status: number
        headers?: Record<string, string>
        body: Record<string, unknown>
    }

    let server: Server
    let baseUrl: string
    let replies: Reply[] = []
    let requestCount = 0

    beforeAll(async () => {
        server = createServer((req, res) => {
            req.on("data", () => {})
            req.on("end", () => {
                const reply = replies[requestCount++]
                res.writeHead(reply.status, {
                    "content-type": "application/json",
                    ...reply.headers
                })
                res.end(
                    JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply.body })
                )
            })
        })
        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve)
        })
        const { port } = server.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve())
        })
    })

    const logger = {
        isLevelEnabled: () => false,
        info: () => {},
        error: () => {}
    } as unknown as Logger

    const serverError = { error: { code: -32000, message: "server error" } }

    const callWith = async (scripted: Reply[], retryCount: number) => {
        replies = scripted
        requestCount = 0
        const transport = customTransport(baseUrl, {
            logger,
            retryCount,
            retryDelay: 1
        })({})
        const start = performance.now()
        let result: unknown
        let thrown: unknown
        try {
            result = await transport.request({ method: "eth_chainId" })
        } catch (error) {
            thrown = error
        }
        const elapsed = performance.now() - start
        return { result, thrown, elapsed, requests: requestCount }
    }

    it.each([429, 503])(
        "retries an HTTP %i that carries a JSON-RPC -32000 error",
        async (status) => {
            const { result, requests } = await callWith(
                [
                    { status, body: serverError },
                    { status: 200, body: { result: "0x1" } }
                ],
                1
            )

            expect(result).toBe("0x1")
            expect(requests).toBe(2)
        }
    )

    it("throws HttpRequestError with the status and headers", async () => {
        const { thrown, requests } = await callWith(
            [
                {
                    status: 429,
                    headers: { "retry-after": "7" },
                    body: serverError
                }
            ],
            0
        )

        expect(requests).toBe(1)
        expect(thrown).toBeInstanceOf(HttpRequestError)
        const error = thrown as HttpRequestError
        expect(error.status).toBe(429)
        expect(error.headers?.get("retry-after")).toBe("7")
    })

    it("waits for Retry-After before retrying", async () => {
        const { result, requests, elapsed } = await callWith(
            [
                {
                    status: 429,
                    headers: { "retry-after": "1" },
                    body: serverError
                },
                { status: 200, body: { result: "0x1" } }
            ],
            1
        )

        expect(result).toBe("0x1")
        expect(requests).toBe(2)
        expect(elapsed).toBeGreaterThanOrEqual(900)
    })

    it("accepts a response larger than viem's 10 MiB default cap", async () => {
        const large = `0x${"ab".repeat(6 * 1024 * 1024)}`
        const { result } = await callWith(
            [{ status: 200, body: { result: large } }],
            0
        )

        expect(result).toBe(large)
    })

    it("keeps the typed JSON-RPC error for a non-retryable status", async () => {
        const { thrown, requests } = await callWith(
            [
                {
                    status: 400,
                    body: { error: { code: -32601, message: "not found" } }
                },
                { status: 200, body: { result: "0x1" } }
            ],
            1
        )

        expect(requests).toBe(1)
        expect(thrown).toBeInstanceOf(MethodNotFoundRpcError)
    })

    it("does not retry a JSON-RPC error on HTTP 200", async () => {
        const { thrown, requests } = await callWith(
            [
                { status: 200, body: serverError },
                { status: 200, body: { result: "0x1" } }
            ],
            1
        )

        expect(requests).toBe(1)
        expect(thrown).not.toBeInstanceOf(HttpRequestError)
    })
})
