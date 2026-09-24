import { describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

import { Executor } from "./executor"

const getBundleGasPrice = Executor.prototype.getBundleGasPrice

const call = (submissionAttempts: number, arbitrumPriorityFeePerGas = 0n) =>
    getBundleGasPrice.call(
        {
            config: {
                chainType: "arbitrum",
                arbitrumGasBidMultiplier: 5n,
                arbitrumPriorityFeePerGas,
                bundlerInitialCommission: 0n,
                resubmitMultiplierCeiling: 0n,
                legacyTransactions: false
            }
        } as unknown as Executor,
        {
            bundle: { submissionAttempts } as never,
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
            networkBaseFee: 20_000_000n, // 0.02 gwei
            totalBeneficiaryFees: 0n,
            bundleGasUsed: 0n
        }
    )

describe("getBundleGasPrice on arbitrum", () => {
    it("bids no priority fee so the bundle pays baseFee", () => {
        expect(call(0)).toEqual({
            maxFeePerGas: 100_000_000n,
            maxPriorityFeePerGas: 0n
        })
    })

    it("raises only maxFee on resubmission", () => {
        expect(call(1)).toEqual({
            maxFeePerGas: 120_000_000n,
            maxPriorityFeePerGas: 0n
        })
    })

    it("bids the configured priority fee", () => {
        expect(call(0, 10_000_000n)).toEqual({
            maxFeePerGas: 100_000_000n,
            maxPriorityFeePerGas: 10_000_000n
        })
    })

    it("scales a configured priority fee on resubmission", () => {
        expect(call(1, 10_000_000n)).toEqual({
            maxFeePerGas: 120_000_000n,
            maxPriorityFeePerGas: 12_000_000n
        })
    })

    it("keeps maxFee above baseFee plus a large configured tip", () => {
        expect(call(0, 200_000_000n)).toEqual({
            maxFeePerGas: 220_000_000n,
            maxPriorityFeePerGas: 200_000_000n
        })
    })
})
