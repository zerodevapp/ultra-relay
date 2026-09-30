import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Logger } from "@alto/utils"
import {
    http,
    type Hex,
    NonceTooLowError,
    TimeoutError,
    TransactionExecutionError,
    createWalletClient,
    custom,
    fallback,
    keccak256
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { describe, expect, it, vi } from "vitest"
import { sendTransactionSync, syncShouldThrow } from "./sendTransactionSync"

const HASH = `0x${"ab".repeat(32)}` as Hex
const account = privateKeyToAccount(`0x${"11".repeat(32)}`)
const logger = { warn: vi.fn() } as unknown as Logger

// All fields set, as the executor does, so viem prepares nothing over RPC.
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

function clientWith(onSync: () => unknown) {
    const calls: string[] = []
    const sent: Hex[] = []
    const walletClient = createWalletClient({
        account,
        chain: foundry,
        transport: custom({
            async request({ method, params }) {
                calls.push(method)
                if (method === "eth_sendRawTransactionSync") {
                    sent.push((params as Hex[])[0])
                    return onSync()
                }
                throw new Error(`unexpected ${method}`)
            }
        })
    })
    return { walletClient, calls, sent }
}

describe("sendTransactionSync", () => {
    it("returns the receipt's hash from one eth_sendRawTransactionSync call", async () => {
        const { walletClient, calls } = clientWith(() => ({
            transactionHash: HASH
        }))

        const hash = await sendTransactionSync({
            walletClient,
            request,
            logger
        })

        expect(hash).toBe(HASH)
        expect(calls).toEqual(["eth_sendRawTransactionSync"])
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
    ])("returns the signed transaction's hash on %s", async (_, onSync) => {
        const { walletClient, sent } = clientWith(onSync)

        const hash = await sendTransactionSync({
            walletClient,
            request,
            logger
        })

        expect(hash).toBe(keccak256(sent[0]))
    })

    // The executor's retry loop matches this shape.
    it("wraps node errors the way sendTransaction does", async () => {
        const { walletClient } = clientWith(() => {
            throw { code: -32000, message: "nonce too low" }
        })

        const error = await sendTransactionSync({
            walletClient,
            request,
            logger
        }).catch((e) => e)

        expect(error).toBeInstanceOf(TransactionExecutionError)
        expect(error.cause).toBeInstanceOf(NonceTooLowError)
    })
})

// http wraps error bodies differently from custom.
describe("sendTransactionSync over http", () => {
    it("treats a code 4 error body as a timeout", async () => {
        const sent: Hex[] = []
        const server = createServer((req, res) => {
            let body = ""
            req.on("data", (chunk) => {
                body += chunk
            })
            req.on("end", () => {
                const { id, params } = JSON.parse(body)
                sent.push(params[0])
                res.setHeader("content-type", "application/json")
                res.end(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id,
                        error: {
                            code: 4,
                            message:
                                "The transaction was added to the mempool but wasn't processed in time"
                        }
                    })
                )
            })
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const { port } = server.address() as AddressInfo
        try {
            const walletClient = createWalletClient({
                account,
                chain: foundry,
                transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 })
            })

            const hash = await sendTransactionSync({
                walletClient,
                request,
                logger
            })

            expect(sent).toHaveLength(1)
            expect(hash).toBe(keccak256(sent[0]))
        } finally {
            server.close()
        }
    })
})

describe("sendTransactionSync over the private fallback transport", () => {
    it("does not resend a timed-out tx to the next transport", async () => {
        const calls: string[] = []
        const sent: Hex[] = []
        const transport = (name: string) =>
            custom({
                async request({ method, params }) {
                    calls.push(`${name}:${method}`)
                    sent.push((params as Hex[])[0])
                    throw { code: 4, message: "wasn't processed in time" }
                }
            })
        const walletClient = createWalletClient({
            account,
            chain: foundry,
            transport: fallback([transport("private"), transport("public")], {
                rank: false,
                shouldThrow: syncShouldThrow
            })
        })

        const hash = await sendTransactionSync({
            walletClient,
            request,
            logger
        })

        expect(calls).toEqual(["private:eth_sendRawTransactionSync"])
        expect(hash).toBe(keccak256(sent[0]))
    })
})
