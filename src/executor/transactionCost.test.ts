import { describe, expect, it } from "vitest"
import {
    type TransactionCostFields,
    computeTransactionCostEth
} from "./transactionCost"

// 21_000 gas at 1 gwei = 0.000021 ETH
const baseReceipt: TransactionCostFields = {
    gasUsed: 21_000n,
    effectiveGasPrice: 1_000_000_000n
}

describe("computeTransactionCostEth", () => {
    it("multiplies gasUsed by effectiveGasPrice", () => {
        expect(computeTransactionCostEth(baseReceipt)).toBe(0.000021)
    })

    it("falls back to gasPrice when effectiveGasPrice is absent", () => {
        expect(
            computeTransactionCostEth({
                gasUsed: 21_000n,
                gasPrice: 2_000_000_000n
            })
        ).toBe(0.000042)
    })

    it("falls back to gasPrice when effectiveGasPrice is null", () => {
        expect(
            computeTransactionCostEth({
                gasUsed: 21_000n,
                effectiveGasPrice: null,
                gasPrice: 2_000_000_000n
            })
        ).toBe(0.000042)
    })

    // viem's receipt formatter never converts gasPrice, so the legacy field
    // reaches us as the raw hex string the node returned.
    it("falls back to a hex string gasPrice", () => {
        expect(
            computeTransactionCostEth({
                gasUsed: 21_000n,
                effectiveGasPrice: null,
                gasPrice: "0x77359400"
            })
        ).toBe(0.000042)
    })

    it("returns undefined when no gas price field is present", () => {
        expect(computeTransactionCostEth({ gasUsed: 21_000n })).toBeUndefined()
    })

    it("returns undefined when both gas price fields are null", () => {
        expect(
            computeTransactionCostEth({
                gasUsed: 21_000n,
                effectiveGasPrice: null,
                gasPrice: null
            })
        ).toBeUndefined()
    })

    it("adds a bigint l1Fee", () => {
        expect(
            computeTransactionCostEth({
                ...baseReceipt,
                l1Fee: 21_000_000_000_000n
            })
        ).toBe(0.000042)
    })

    it("adds a hex string l1Fee from an OP stack receipt", () => {
        expect(
            computeTransactionCostEth({
                ...baseReceipt,
                l1Fee: "0x1319718a5000"
            })
        ).toBe(0.000042)
    })

    it("treats a null l1Fee as absent", () => {
        expect(computeTransactionCostEth({ ...baseReceipt, l1Fee: null })).toBe(
            0.000021
        )
    })

    it("does not mutate the receipt", () => {
        const receipt: TransactionCostFields = {
            gasUsed: 21_000n,
            effectiveGasPrice: 1_000_000_000n,
            l1Fee: 21_000_000_000_000n
        }
        const before = structuredClone(receipt)

        computeTransactionCostEth(receipt)

        expect(receipt).toEqual(before)
    })
})
