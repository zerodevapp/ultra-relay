import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Logger } from "@alto/utils"
import {
    http,
    type Hex,
    TimeoutError,
    createWalletClient,
    custom,
    keccak256
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { describe, expect, it, vi } from "vitest"
import {
    isSyncSubmissionSupported,
    sendTransactionSyncOrFallback
} from "./sendTransactionSync"

const HASH = `0x${"ab".repeat(32)}` as Hex
const account = privateKeyToAccount(`0x${"11".repeat(32)}`)
const logger = { warn: vi.fn() } as unknown as Logger

const request = {
    to: account.address,
    account,
    chain: foundry,
    chainId: foundry.id,
    gas: 21000n,
    nonce: 0,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n
}

// A fresh client per test gets a fresh uid, so the latch never leaks between tests.
function clientWith(onSync: () => unknown) {
    const calls: string[] = []
    const sent: Hex[] = []
    const client = createWalletClient({
        account,
        chain: foundry,
        transport: custom({
            async request({ method, params }) {
                calls.push(method)
                if (method === "eth_sendRawTransactionSync") {
                    sent.push((params as Hex[])[0])
                    return onSync()
                }
                if (method === "eth_sendRawTransaction") return HASH
                if (method === "eth_chainId") return "0x7a69"
                throw new Error(`unexpected ${method}`)
            }
        })
    })
    return { client, calls, sent }
}

describe("sendTransactionSyncOrFallback", () => {
    it("uses the sync receipt when the node supports the method", async () => {
        const { client, calls } = clientWith(() => ({ transactionHash: HASH }))

        const hash = await sendTransactionSyncOrFallback(
            client,
            request,
            logger
        )

        expect(hash).toBe(HASH)
        expect(calls).not.toContain("eth_sendRawTransaction")
        expect(isSyncSubmissionSupported(client)).toBe(true)
    })

    it.each([
        ["-32601", -32601, "the method does not exist"],
        ["-32004", -32004, "method not supported"],
        [
            "Alchemy's -32600",
            -32600,
            "eth_sendRawTransactionSync is not available on the ETH_MAINNET."
        ]
    ])("falls back and latches on %s", async (_, code, message) => {
        const { client, calls } = clientWith(() => {
            throw { code, message }
        })

        const hash = await sendTransactionSyncOrFallback(
            client,
            request,
            logger
        )

        expect(hash).toBe(HASH)
        expect(calls).toContain("eth_sendRawTransaction")
        expect(isSyncSubmissionSupported(client)).toBe(false)
    })

    it("goes straight to the async send once latched", async () => {
        const { client, calls } = clientWith(() => {
            throw { code: -32601, message: "method not found" }
        })
        await sendTransactionSyncOrFallback(client, request, logger)
        calls.length = 0

        await sendTransactionSyncOrFallback(client, request, logger)

        expect(calls).not.toContain("eth_sendRawTransactionSync")
        expect(calls).toContain("eth_sendRawTransaction")
    })

    it.each([
        [
            "EIP-7966 code 4",
            () => {
                throw {
                    code: 4,
                    message:
                        "The transaction was added to the mempool but wasn't processed in time"
                }
            }
        ],
        [
            "viem's client-side TimeoutError",
            () => {
                throw new TimeoutError({ body: {}, url: "http://node" })
            }
        ]
    ])("tracks the local hash as pending on %s", async (_, onSync) => {
        const { client, calls, sent } = clientWith(onSync)

        const hash = await sendTransactionSyncOrFallback(
            client,
            request,
            logger
        )

        expect(hash).toBe(keccak256(sent[0]))
        expect(calls).not.toContain("eth_sendRawTransaction")
        expect(isSyncSubmissionSupported(client)).toBe(true)
    })

    it("rethrows an unrelated -32600 without latching", async () => {
        const { client } = clientWith(() => {
            throw { code: -32600, message: "App is inactive." }
        })

        await expect(
            sendTransactionSyncOrFallback(client, request, logger)
        ).rejects.toThrow(/App is inactive/)

        expect(isSyncSubmissionSupported(client)).toBe(true)
    })

    it("rethrows -32000 without falling back or latching", async () => {
        const { client, calls } = clientWith(() => {
            throw { code: -32000, message: "nonce too low" }
        })

        await expect(
            sendTransactionSyncOrFallback(client, request, logger)
        ).rejects.toThrow(/nonce too low/)

        expect(calls).toContain("eth_sendRawTransactionSync")
        expect(calls).not.toContain("eth_sendRawTransaction")
        expect(isSyncSubmissionSupported(client)).toBe(true)
    })
})

// The bundler talks to nodes over viem's http transport, which wraps a JSON-RPC error body
// differently from the custom transport above, so run the fallback end to end over HTTP.
describe("sendTransactionSyncOrFallback over http", () => {
    it.each([
        ["a -32601 body", { code: -32601, message: "method not found" }],
        [
            "Alchemy's -32600 body",
            {
                code: -32600,
                message:
                    "eth_sendRawTransactionSync is not available on the ETH_MAINNET."
            }
        ]
    ])("falls back on %s", async (_, rpcError) => {
        const calls: string[] = []
        const server = createServer((req, res) => {
            let body = ""
            req.on("data", (chunk) => {
                body += chunk
            })
            req.on("end", () => {
                const { id, method } = JSON.parse(body)
                calls.push(method)
                const reply =
                    method === "eth_sendRawTransactionSync"
                        ? { jsonrpc: "2.0", id, error: rpcError }
                        : method === "eth_sendRawTransaction"
                          ? { jsonrpc: "2.0", id, result: HASH }
                          : { jsonrpc: "2.0", id, result: "0x7a69" }
                res.setHeader("content-type", "application/json")
                res.end(JSON.stringify(reply))
            })
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const { port } = server.address() as AddressInfo
        try {
            const client = createWalletClient({
                account,
                chain: foundry,
                transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 })
            })

            const hash = await sendTransactionSyncOrFallback(
                client,
                request,
                logger
            )

            expect(hash).toBe(HASH)
            expect(calls).toEqual([
                "eth_sendRawTransactionSync",
                "eth_sendRawTransaction"
            ])
            expect(isSyncSubmissionSupported(client)).toBe(false)
        } finally {
            server.close()
        }
    })
})
