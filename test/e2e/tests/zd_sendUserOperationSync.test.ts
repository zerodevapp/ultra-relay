import { deepHexlify } from "permissionless"
import { type Hex, parseEther } from "viem"
import {
    type EntryPointVersion,
    type UserOperation,
    entryPoint06Address,
    entryPoint07Address,
    entryPoint08Address
} from "viem/account-abstraction"
import { beforeEach, describe, expect, inject, test } from "vitest"
import {
    beforeEachCleanUp,
    getSmartAccountClient,
    sendBundleNow,
    setBundlingMode
} from "../src/utils/index.js"

type JsonRpcResponse = {
    result?: any
    error?: { code: number; message: string; data?: any }
}

const rpc = async (
    altoRpc: string,
    method: string,
    params: unknown[]
): Promise<JsonRpcResponse> => {
    const response = await fetch(altoRpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    })
    return (await response.json()) as JsonRpcResponse
}

const waitForReceipt = async (altoRpc: string, userOpHash: Hex) => {
    for (let attempt = 0; attempt < 50; attempt++) {
        const { result } = await rpc(altoRpc, "eth_getUserOperationReceipt", [
            userOpHash
        ])
        if (result) {
            return result
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`no receipt for ${userOpHash}`)
}

describe.each([
    {
        entryPoint: entryPoint06Address,
        entryPointVersion: "0.6" as EntryPointVersion
    },
    {
        entryPoint: entryPoint07Address,
        entryPointVersion: "0.7" as EntryPointVersion
    },
    {
        entryPoint: entryPoint08Address,
        entryPointVersion: "0.8" as EntryPointVersion
    }
])(
    "$entryPointVersion supports zd_sendUserOperationSync",
    ({ entryPoint, entryPointVersion }) => {
        const anvilRpc = inject("anvilRpc")
        const altoRpc = inject("altoRpc")

        beforeEach(async () => {
            await beforeEachCleanUp({ anvilRpc, altoRpc })
        })

        const signedOp = async () => {
            const smartAccountClient = await getSmartAccountClient({
                entryPointVersion,
                anvilRpc,
                altoRpc
            })
            const op = (await smartAccountClient.prepareUserOperation({
                calls: [
                    {
                        to: "0x23B608675a2B2fB1890d3ABBd85c5775c51691d5",
                        value: parseEther("0.01"),
                        data: "0x"
                    }
                ]
            })) as UserOperation
            op.signature =
                await smartAccountClient.account.signUserOperation(op)
            return op
        }

        test("returns the receipt in the same response", async () => {
            const op = await signedOp()

            const { result, error } = await rpc(
                altoRpc,
                "zd_sendUserOperationSync",
                [deepHexlify(op), entryPoint]
            )

            expect(error).toBeUndefined()
            expect(result.success).toEqual(true)
            expect(result.entryPoint.toLowerCase()).toEqual(
                entryPoint.toLowerCase()
            )

            // The same receipt eth_getUserOperationReceipt serves afterwards.
            const polled = await waitForReceipt(altoRpc, result.userOpHash)
            expect(result).toEqual(polled)
        })

        test("waits through a bundle that is sent while the request is open", async () => {
            await setBundlingMode({ mode: "manual", altoRpc })
            const op = await signedOp()

            const pending = rpc(altoRpc, "zd_sendUserOperationSync", [
                deepHexlify(op),
                entryPoint,
                { timeoutMs: 10_000 }
            ])
            await new Promise((resolve) => setTimeout(resolve, 1_000))
            await sendBundleNow({ altoRpc })

            const { result, error } = await pending
            expect(error).toBeUndefined()
            expect(result.success).toEqual(true)
        })

        test("times out with the userOpHash, and the op still lands", async () => {
            await setBundlingMode({ mode: "manual", altoRpc })
            const op = await signedOp()

            const { result, error } = await rpc(
                altoRpc,
                "zd_sendUserOperationSync",
                [deepHexlify(op), entryPoint, { timeoutMs: 500 }]
            )

            expect(result).toBeUndefined()
            expect(error?.code).toEqual(4)
            const userOpHash = error?.data?.userOpHash as Hex
            expect(userOpHash).toMatch(/^0x[0-9a-f]{64}$/)

            await sendBundleNow({ altoRpc })
            const receipt = await waitForReceipt(altoRpc, userOpHash)
            expect(receipt.success).toEqual(true)
        })

        test("shares a bundle with a regular eth_sendUserOperation op", async () => {
            await setBundlingMode({ mode: "manual", altoRpc })
            const regularOp = await signedOp()
            const syncOp = await signedOp()

            const regular = await rpc(altoRpc, "eth_sendUserOperation", [
                deepHexlify(regularOp),
                entryPoint
            ])
            expect(regular.error).toBeUndefined()
            const regularHash = regular.result as Hex

            const pending = rpc(altoRpc, "zd_sendUserOperationSync", [
                deepHexlify(syncOp),
                entryPoint,
                { timeoutMs: 10_000 }
            ])

            // Both ops wait in the mempool before the one bundle is sent.
            let queued = 0
            for (let attempt = 0; attempt < 50 && queued < 2; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 100))
                const { result } = await rpc(
                    altoRpc,
                    "debug_bundler_dumpMempool",
                    [entryPoint]
                )
                queued = result?.length ?? 0
            }
            expect(queued).toEqual(2)

            await sendBundleNow({ altoRpc })

            // The sync caller gets its receipt; the regular op is polled as before.
            const sync = await pending
            expect(sync.error).toBeUndefined()
            expect(sync.result.success).toEqual(true)
            expect(sync.result.userOpHash).not.toEqual(regularHash)

            const regularReceipt = await waitForReceipt(altoRpc, regularHash)
            expect(regularReceipt.success).toEqual(true)

            expect(sync.result.receipt.transactionHash).toEqual(
                regularReceipt.receipt.transactionHash
            )
            expect(sync.result).toEqual(
                await waitForReceipt(altoRpc, sync.result.userOpHash)
            )
        })

        test("rejects an invalid op exactly like eth_sendUserOperation", async () => {
            const op = await signedOp()
            op.signature = `0x${"00".repeat(65)}` as Hex

            const sync = await rpc(altoRpc, "zd_sendUserOperationSync", [
                deepHexlify(op),
                entryPoint
            ])
            const async = await rpc(altoRpc, "eth_sendUserOperation", [
                deepHexlify(op),
                entryPoint
            ])

            expect(sync.error).toBeDefined()
            expect(sync.error?.code).toEqual(async.error?.code)
            expect(sync.error?.message).toEqual(async.error?.message)
        })
    }
)
