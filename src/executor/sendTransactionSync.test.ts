import type { Logger } from "@alto/utils"
import {
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

const receiptFor = (transactionHash: Hex, status: "0x1" | "0x0") => ({
    transactionHash,
    status,
    blockNumber: "0x1",
    blockHash: `0x${"cd".repeat(32)}`,
    logs: []
})

const nodeTimeout = () => {
    throw {
        code: 4,
        message:
            "The transaction was added to the mempool but wasn't processed within the designated timeout interval"
    }
}

function clientWith(onSync: (tx: Hex) => unknown) {
    const calls: unknown[][] = []
    const walletClient = createWalletClient({
        account,
        chain: foundry,
        transport: custom({
            async request({ method, params }) {
                calls.push([method, ...(params as unknown[])])
                if (method === "eth_sendRawTransactionSync") {
                    return onSync((params as Hex[])[0])
                }
                throw new Error(`unexpected ${method}`)
            }
        })
    })
    return { walletClient, calls }
}

describe("sendTransactionSync", () => {
    it("returns the receipt from one call that carries no timeout", async () => {
        const { walletClient, calls } = clientWith((tx) =>
            receiptFor(keccak256(tx), "0x1")
        )

        const sent = await sendTransactionSync({
            walletClient,
            request,
            logger
        })

        expect(calls).toHaveLength(1)
        expect(calls[0]).toHaveLength(2) // method and the signed tx only
        expect(sent.transactionHash).toBe(keccak256(calls[0][1] as Hex))
        expect(sent.receipt?.status).toBe("success")
    })

    it("returns a reverted receipt instead of throwing", async () => {
        const { walletClient } = clientWith((tx) =>
            receiptFor(keccak256(tx), "0x0")
        )

        const sent = await sendTransactionSync({
            walletClient,
            request,
            logger
        })

        expect(sent.receipt?.status).toBe("reverted")
    })

    it("tracks the signed hash as pending on a node timeout (code 4)", async () => {
        const { walletClient, calls } = clientWith(nodeTimeout)

        const sent = await sendTransactionSync({
            walletClient,
            request,
            logger
        })

        expect(sent.transactionHash).toBe(keccak256(calls[0][1] as Hex))
        expect(sent.receipt).toBeUndefined()
    })

    it("treats a client-side timeout as a failed send", async () => {
        const { walletClient } = clientWith(() => {
            throw new TimeoutError({ body: {}, url: "http://node" })
        })

        await expect(
            sendTransactionSync({ walletClient, request, logger })
        ).rejects.toBeInstanceOf(TransactionExecutionError)
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

describe("syncShouldThrow on the private fallback transport", () => {
    function fallbackClient(onPrivate: (params: Hex[]) => unknown) {
        const calls: string[] = []
        const transport = (name: string, handler: (params: Hex[]) => unknown) =>
            custom({
                async request({ method, params }) {
                    calls.push(name)
                    return method === "eth_sendRawTransactionSync"
                        ? handler(params as Hex[])
                        : receiptFor(keccak256((params as Hex[])[0]), "0x1")
                }
            })
        const walletClient = createWalletClient({
            account,
            chain: foundry,
            transport: fallback(
                [
                    transport("private", onPrivate),
                    transport("public", () =>
                        receiptFor(`0x${"ab".repeat(32)}`, "0x1")
                    )
                ],
                { rank: false, shouldThrow: syncShouldThrow }
            )
        })
        return { walletClient, calls }
    }

    it("does not resend a timed-out tx to the next transport", async () => {
        const { walletClient, calls } = fallbackClient(nodeTimeout)

        await sendTransactionSync({ walletClient, request, logger })

        expect(calls).toEqual(["private"])
    })

    it("still falls back when the private endpoint is unreachable", async () => {
        const { walletClient, calls } = fallbackClient(() => {
            throw new TimeoutError({ body: {}, url: "http://private" })
        })

        await sendTransactionSync({ walletClient, request, logger })

        expect(calls).toEqual(["private", "public"])
    })
})
