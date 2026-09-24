import type { UserOpInfo, UserOperation06 } from "@alto/types"
import { type Hex, getAddress } from "viem"
import { describe, expect, it } from "vitest"
import { computeInclusionTimings } from "./inclusionTimings"

const USER_OP_HASH: Hex = `0x${"1".repeat(64)}`

const userOp: UserOperation06 = {
    sender: getAddress("0x1111111111111111111111111111111111111111"),
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    callGasLimit: 6_000_000n,
    verificationGasLimit: 350_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    paymasterAndData: "0x",
    signature: "0x"
}

// Fixture from spec §7.1: a complete, ordered timestamp chain.
const baseUserOpInfo = (overrides: Partial<UserOpInfo> = {}): UserOpInfo => ({
    userOp,
    userOpHash: USER_OP_HASH,
    receivedAt: 900,
    addedToMempool: 1000,
    processingAt: 1100,
    bundledAt: 1130,
    dispatchedAt: 1190,
    walletAcquiredAt: 1290,
    submittedAt: 1500,
    submissionAttempts: 0,
    ...overrides
})

const BLOCK_RECEIVED_TIMESTAMP = 1760

describe("computeInclusionTimings", () => {
    it("computes the full four-stage breakdown for a complete ordered chain", () => {
        const timings = computeInclusionTimings(
            baseUserOpInfo(),
            BLOCK_RECEIVED_TIMESTAMP
        )

        expect(timings).toEqual({
            inclusionTimeMs: 760,
            totalMs: 860,
            validationMs: 100,
            outstandingMs: 100,
            processingMs: 400,
            submittedMs: 260,
            bundleBuildMs: 30,
            handOffMs: 60,
            walletWaitMs: 100,
            submissionMs: 210
        })

        const stageSum =
            (timings.bundleBuildMs ?? 0) +
            (timings.handOffMs ?? 0) +
            (timings.walletWaitMs ?? 0) +
            (timings.submissionMs ?? 0)
        expect(stageSum).toBe(timings.processingMs)
    })

    it.each([
        { stamp: "bundledAt" },
        { stamp: "dispatchedAt" },
        { stamp: "walletAcquiredAt" }
    ] as const)(
        "omits the four-stage breakdown when $stamp is missing",
        ({ stamp }) => {
            const timings = computeInclusionTimings(
                baseUserOpInfo({ [stamp]: undefined }),
                BLOCK_RECEIVED_TIMESTAMP
            )

            expect(timings.bundleBuildMs).toBeUndefined()
            expect(timings.handOffMs).toBeUndefined()
            expect(timings.walletWaitMs).toBeUndefined()
            expect(timings.submissionMs).toBeUndefined()

            // The six existing fields are unchanged from the full-chain case.
            expect(timings.inclusionTimeMs).toBe(760)
            expect(timings.totalMs).toBe(860)
            expect(timings.validationMs).toBe(100)
            expect(timings.outstandingMs).toBe(100)
            expect(timings.processingMs).toBe(400)
            expect(timings.submittedMs).toBe(260)
        }
    )

    it.each([
        {
            name: "processingAt > bundledAt",
            overrides: { bundledAt: 1050 }
        },
        {
            name: "bundledAt > dispatchedAt",
            overrides: { bundledAt: 1190, dispatchedAt: 1130 }
        },
        {
            name: "dispatchedAt > walletAcquiredAt",
            overrides: { walletAcquiredAt: 1150 }
        },
        {
            name: "walletAcquiredAt > submittedAt",
            overrides: { walletAcquiredAt: 1550 }
        }
    ])("omits the four-stage breakdown when $name", ({ overrides }) => {
        const timings = computeInclusionTimings(
            baseUserOpInfo(overrides),
            BLOCK_RECEIVED_TIMESTAMP
        )

        expect(timings.bundleBuildMs).toBeUndefined()
        expect(timings.handOffMs).toBeUndefined()
        expect(timings.walletWaitMs).toBeUndefined()
        expect(timings.submissionMs).toBeUndefined()

        // The six existing fields are unchanged from the full-chain case.
        expect(timings.inclusionTimeMs).toBe(760)
        expect(timings.totalMs).toBe(860)
        expect(timings.validationMs).toBe(100)
        expect(timings.outstandingMs).toBe(100)
        expect(timings.processingMs).toBe(400)
        expect(timings.submittedMs).toBe(260)
    })

    it.each([
        {
            name: "processingAt === bundledAt",
            overrides: { bundledAt: 1100 },
            zeroField: "bundleBuildMs"
        },
        {
            name: "bundledAt === dispatchedAt",
            overrides: { dispatchedAt: 1130 },
            zeroField: "handOffMs"
        },
        {
            name: "dispatchedAt === walletAcquiredAt",
            overrides: { walletAcquiredAt: 1190 },
            zeroField: "walletWaitMs"
        },
        {
            name: "walletAcquiredAt === submittedAt",
            overrides: { submittedAt: 1290 },
            zeroField: "submissionMs"
        }
    ] as const)(
        "still emits the breakdown with a zero-length stage when $name",
        ({ overrides, zeroField }) => {
            const timings = computeInclusionTimings(
                baseUserOpInfo(overrides),
                BLOCK_RECEIVED_TIMESTAMP
            )

            expect(timings[zeroField]).toBe(0)

            const stageSum =
                (timings.bundleBuildMs ?? 0) +
                (timings.handOffMs ?? 0) +
                (timings.walletWaitMs ?? 0) +
                (timings.submissionMs ?? 0)
            expect(stageSum).toBe(timings.processingMs)
        }
    )

    it("suppresses validationMs for a reentered record; the rest matches the full chain", () => {
        const timings = computeInclusionTimings(
            baseUserOpInfo({ reentered: true }),
            BLOCK_RECEIVED_TIMESTAMP
        )

        expect(timings).toEqual({
            inclusionTimeMs: 760,
            totalMs: 860,
            validationMs: undefined,
            outstandingMs: 100,
            processingMs: 400,
            submittedMs: 260,
            bundleBuildMs: 30,
            handOffMs: 60,
            walletWaitMs: 100,
            submissionMs: 210
        })
    })

    it("falls back totalMs to inclusionTimeMs when receivedAt is absent", () => {
        const timings = computeInclusionTimings(
            baseUserOpInfo({ receivedAt: undefined }),
            BLOCK_RECEIVED_TIMESTAMP
        )

        expect(timings.validationMs).toBeUndefined()
        expect(timings.totalMs).toBe(timings.inclusionTimeMs)
    })

    it("computes only inclusionTimeMs/totalMs for a legacy record with no stage stamps", () => {
        const legacyUserOpInfo: UserOpInfo = {
            userOp,
            userOpHash: USER_OP_HASH,
            addedToMempool: 1000,
            submissionAttempts: 0
        }

        const timings = computeInclusionTimings(
            legacyUserOpInfo,
            BLOCK_RECEIVED_TIMESTAMP
        )

        expect(timings).toEqual({
            inclusionTimeMs: 760,
            totalMs: 760,
            validationMs: undefined,
            outstandingMs: undefined,
            processingMs: undefined,
            submittedMs: undefined,
            bundleBuildMs: undefined,
            handOffMs: undefined,
            walletWaitMs: undefined,
            submissionMs: undefined
        })
    })

    it("omits the breakdown for a rotated record whose new executor stamps follow the old submittedAt", () => {
        // submittedAt is the original successful submission; dispatchedAt and
        // walletAcquiredAt are from a later rotation pass through
        // sendBundleToExecutor, which (per D3) does not move submittedAt.
        const timings = computeInclusionTimings(
            baseUserOpInfo({ dispatchedAt: 2000, walletAcquiredAt: 2100 }),
            BLOCK_RECEIVED_TIMESTAMP
        )

        expect(timings.bundleBuildMs).toBeUndefined()
        expect(timings.handOffMs).toBeUndefined()
        expect(timings.walletWaitMs).toBeUndefined()
        expect(timings.submissionMs).toBeUndefined()

        // The six existing fields are unchanged from the full-chain case.
        expect(timings.inclusionTimeMs).toBe(760)
        expect(timings.totalMs).toBe(860)
        expect(timings.validationMs).toBe(100)
        expect(timings.outstandingMs).toBe(100)
        expect(timings.processingMs).toBe(400)
        expect(timings.submittedMs).toBe(260)
    })

    it("keeps existing zero-timestamp truthiness for processingAt: 0 and omits the breakdown", () => {
        const timings = computeInclusionTimings(
            baseUserOpInfo({ processingAt: 0 }),
            BLOCK_RECEIVED_TIMESTAMP
        )

        expect(timings.outstandingMs).toBeUndefined()
        expect(timings.processingMs).toBeUndefined()
        expect(timings.submittedMs).toBe(260)
        expect(timings.validationMs).toBe(100)
        expect(timings.bundleBuildMs).toBeUndefined()
        expect(timings.handOffMs).toBeUndefined()
        expect(timings.walletWaitMs).toBeUndefined()
        expect(timings.submissionMs).toBeUndefined()
    })

    it("keeps existing zero-timestamp truthiness for submittedAt: 0 and omits the breakdown", () => {
        const timings = computeInclusionTimings(
            baseUserOpInfo({ submittedAt: 0 }),
            BLOCK_RECEIVED_TIMESTAMP
        )

        expect(timings.processingMs).toBeUndefined()
        expect(timings.submittedMs).toBeUndefined()
        expect(timings.outstandingMs).toBe(100)
        expect(timings.validationMs).toBe(100)
        expect(timings.bundleBuildMs).toBeUndefined()
        expect(timings.handOffMs).toBeUndefined()
        expect(timings.walletWaitMs).toBeUndefined()
        expect(timings.submissionMs).toBeUndefined()
    })
})
