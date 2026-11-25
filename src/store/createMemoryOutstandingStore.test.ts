import type { UserOpInfo } from "@alto/types"
import type { Address, Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../createConfig"
import { createMemoryOutstandingQueue } from "./createMemoryOutstandingStore"

const SENDER = "0x1111111111111111111111111111111111111111" as Address

const silentLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => silentLogger
}

const makeConfig = () =>
    ({
        logLevel: "silent",
        getLogger: () => silentLogger
    }) as unknown as AltoConfig

const makeInfo = (hashId: number, nonce: bigint): UserOpInfo => ({
    userOp: {
        sender: SENDER,
        nonce,
        initCode: "0x",
        callData: "0x",
        callGasLimit: 1n,
        verificationGasLimit: 1n,
        preVerificationGas: 1n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        paymasterAndData: "0x",
        signature: "0x"
    },
    userOpHash: `0x${hashId.toString(16).padStart(64, "0")}` as Hex,
    receivedAt: 900,
    addedToMempool: 1000,
    submissionAttempts: 0
})

const seedOutOfOrder = async () => {
    const store = createMemoryOutstandingQueue({ config: makeConfig() })
    await store.add(makeInfo(1, 1n))
    await store.add(makeInfo(0, 0n))
    return store
}

describe("MemoryOutstanding nonce ordering", () => {
    it("pops the lowest nonce of a slot first when added out of order", async () => {
        const store = await seedOutOfOrder()

        expect((await store.pop())?.userOp.nonce).toBe(0n)
        expect((await store.pop())?.userOp.nonce).toBe(1n)
    })

    it("keeps only the slot head in the priority queue", async () => {
        const store = await seedOutOfOrder()

        expect((await store.peek())?.userOp.nonce).toBe(0n)
    })
})
