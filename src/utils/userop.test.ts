import { describe, expect, it } from "vitest"
import { minBigInt } from "./bigInt"
import { getRequiredPrefund } from "./userop"

const v07Base = {
    sender: "0x0000000000000000000000000000000000000001",
    nonce: 0n,
    factory: null,
    factoryData: null,
    callData: "0x",
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 10n,
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature: "0x"
} as any

const v06Base = {
    sender: "0x0000000000000000000000000000000000000001",
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 10n,
    paymasterAndData: "0x",
    signature: "0x"
} as any

describe("getRequiredPrefund", () => {
    it("is zero for a sponsored (zero-fee) op", () => {
        expect(getRequiredPrefund({ ...v07Base, maxFeePerGas: 0n })).toBe(0n)
    })

    it("sums every billable v0.7 gas limit", () => {
        // (100k + 200k + 50k) * 10
        expect(getRequiredPrefund(v07Base)).toBe(3_500_000n)
    })

    it("includes v0.7 paymaster gas limits", () => {
        const op = {
            ...v07Base,
            paymaster: "0x0000000000000000000000000000000000000002",
            paymasterVerificationGasLimit: 30_000n,
            paymasterPostOpGasLimit: 20_000n
        }
        // (100k + 200k + 30k + 20k + 50k) * 10
        expect(getRequiredPrefund(op)).toBe(4_000_000n)
    })

    it("ignores paymaster gas limits when no paymaster is set", () => {
        // Packing drops these limits when paymaster is null, so the EntryPoint
        // never bills them and they must not raise the ceiling.
        const op = {
            ...v07Base,
            paymaster: null,
            paymasterVerificationGasLimit: 10n ** 12n,
            paymasterPostOpGasLimit: 10n ** 12n
        }

        expect(getRequiredPrefund(op)).toBe(getRequiredPrefund(v07Base))
    })

    it("applies the v0.6 x3 verification multiplier only with a paymaster", () => {
        // no paymaster: (100k + 200k + 50k) * 10
        expect(getRequiredPrefund(v06Base)).toBe(3_500_000n)

        const withPaymaster = {
            ...v06Base,
            paymasterAndData: "0x0000000000000000000000000000000000000002"
        }
        // (100k + 200k*3 + 50k) * 10
        expect(getRequiredPrefund(withPaymaster)).toBe(7_500_000n)
    })

    it("bounds a payload transfer to the executor wallet", () => {
        const balanceChange = 300n * 10n ** 18n
        const bound = getRequiredPrefund({ ...v07Base, maxFeePerGas: 0n })

        expect(bound < balanceChange).toBe(true)
        expect(bound).toBe(0n)
    })

    it("clamps a mixed bundle to the fee-paying ops' bound only", () => {
        // What the executor prices off: min(balanceChange, summed prefund).
        const bundle = [v07Base, { ...v07Base, maxFeePerGas: 0n }]
        const balanceChange = 300n * 10n ** 18n

        const maxPossibleRefund = bundle.reduce(
            (acc, userOp) => acc + getRequiredPrefund(userOp),
            0n
        )

        expect(maxPossibleRefund).toBe(3_500_000n)
        expect(minBigInt(balanceChange, maxPossibleRefund)).toBe(3_500_000n)
    })
})
