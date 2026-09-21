import type { Logger } from "pino"
import type { Hex, PublicClient, TransactionReceipt } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { SubmittedBundleInfo } from "../types/mempool"
import { getBundleStatus } from "./getBundleStatus"

// Stubbed so the test does not need real EntryPoint logs to parse.
vi.mock("../utils/userop", () => ({
    parseUserOpReceipt: (userOpHash: Hex) => ({ userOpHash })
}))

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex

const CURRENT = hash(1)
const PREVIOUS = hash(2)
const OLDEST = hash(3)
const USER_OP = hash(9)
const OTHER_USER_OP = hash(10)

const makeReceipt = (
    transactionHash: Hex,
    status: "success" | "reverted"
): TransactionReceipt =>
    ({
        transactionHash,
        status,
        blockNumber: 100n,
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n,
        from: "0x000000000000000000000000000000000000dead"
    }) as unknown as TransactionReceipt

const makeSubmittedBundle = (
    transactionHash: Hex,
    previousTransactionHashes: Hex[],
    userOpHashes: Hex[] = [USER_OP]
): SubmittedBundleInfo =>
    ({
        transactionHash,
        previousTransactionHashes,
        bundle: { userOps: userOpHashes.map((userOpHash) => ({ userOpHash })) }
    }) as unknown as SubmittedBundleInfo

const makeClient = (receipts: Partial<Record<Hex, TransactionReceipt>>) => {
    const getTransactionReceipt = vi.fn(({ hash: h }: { hash: Hex }) => {
        const found = receipts[h]
        return found
            ? Promise.resolve(found)
            : Promise.reject(new Error("receipt not found"))
    })

    return {
        getTransactionReceipt,
        publicClient: { getTransactionReceipt } as unknown as PublicClient
    }
}

const logger = {} as unknown as Logger

describe("getBundleStatus", () => {
    it("returns the receipt when the current hash was included", async () => {
        const receipt = makeReceipt(CURRENT, "success")
        const { publicClient, getTransactionReceipt } = makeClient({
            [CURRENT]: receipt
        })

        const result = await getBundleStatus({
            submittedBundle: makeSubmittedBundle(CURRENT, []),
            publicClient,
            logger
        })

        if (result.status !== "included") {
            throw new Error(`expected included, got ${result.status}`)
        }
        expect(result.receipt).toBe(receipt)
        expect(result.transactionHash).toBe(CURRENT)
        expect(result.blockNumber).toBe(100n)
        expect(result.userOpReceipts[USER_OP]).toBeDefined()
        expect(getTransactionReceipt).toHaveBeenCalledTimes(1)
    })

    it("returns the previous hash receipt after a replacement", async () => {
        const receipt = makeReceipt(PREVIOUS, "success")
        const { publicClient, getTransactionReceipt } = makeClient({
            [PREVIOUS]: receipt
        })

        const result = await getBundleStatus({
            submittedBundle: makeSubmittedBundle(CURRENT, [PREVIOUS]),
            publicClient,
            logger
        })

        if (result.status !== "included") {
            throw new Error(`expected included, got ${result.status}`)
        }
        expect(result.receipt).toBe(receipt)
        expect(result.transactionHash).toBe(PREVIOUS)
        expect(getTransactionReceipt).toHaveBeenCalledTimes(2)
    })

    it("returns the receipt when the bundle reverted", async () => {
        const receipt = makeReceipt(CURRENT, "reverted")
        const { publicClient } = makeClient({ [CURRENT]: receipt })

        const result = await getBundleStatus({
            submittedBundle: makeSubmittedBundle(CURRENT, []),
            publicClient,
            logger
        })

        if (result.status !== "reverted") {
            throw new Error(`expected reverted, got ${result.status}`)
        }
        expect(result.receipt).toBe(receipt)
        expect(result.transactionHash).toBe(CURRENT)
        expect(result.blockNumber).toBe(100n)
    })

    it("shares one receipt across every userOp in the bundle", async () => {
        const receipt = makeReceipt(CURRENT, "success")
        const { publicClient, getTransactionReceipt } = makeClient({
            [CURRENT]: receipt
        })

        const result = await getBundleStatus({
            submittedBundle: makeSubmittedBundle(
                CURRENT,
                [],
                [USER_OP, OTHER_USER_OP]
            ),
            publicClient,
            logger
        })

        if (result.status !== "included") {
            throw new Error(`expected included, got ${result.status}`)
        }
        expect(Object.keys(result.userOpReceipts)).toEqual([
            USER_OP,
            OTHER_USER_OP
        ])
        expect(result.receipt).toBe(receipt)
        expect(getTransactionReceipt).toHaveBeenCalledTimes(1)
    })

    it("returns not_found and fetches one receipt per hash", async () => {
        const { publicClient, getTransactionReceipt } = makeClient({})

        const result = await getBundleStatus({
            submittedBundle: makeSubmittedBundle(CURRENT, [PREVIOUS, OLDEST]),
            publicClient,
            logger
        })

        expect(result).toEqual({ status: "not_found" })
        expect(getTransactionReceipt).toHaveBeenCalledTimes(3)
    })
})
