import { describe, expect, test } from "vitest"
import {
    type OrderingPolicy,
    defaultOrderingPolicy,
    getBundleGasPrice,
    getSequencerBehaviour
} from "./orderingPolicy"

const GWEI = 1_000_000_000n
const BASE_FEE = GWEI / 50n // 0.02 gwei, Arbitrum One's resting base fee

const config = {
    bundlerInitialCommission: 10n,
    resubmitMultiplierCeiling: 1000n,
    arbitrumGasBidMultiplier: 5n,
    legacyTransactions: false
}

const bid = (policy: OrderingPolicy, overrides = {}) =>
    getBundleGasPrice({
        policy,
        submissionAttempts: 0,
        networkGasPrice: {
            maxFeePerGas: 2n * GWEI,
            maxPriorityFeePerGas: GWEI
        },
        networkBaseFee: BASE_FEE,
        totalBeneficiaryFees: 10n * GWEI,
        bundleGasUsed: 1_000_000n,
        config,
        ...overrides
    })

// The sequencer's ranking key. Getting this wrong is silent: the transaction is
// still valid and still included, it just pays a tip nobody chose.
const effectiveTip = (
    { maxFeePerGas, maxPriorityFeePerGas }: ReturnType<typeof bid>,
    baseFee: bigint
) => {
    const headroom = maxFeePerGas - baseFee
    return maxPriorityFeePerGas < headroom ? maxPriorityFeePerGas : headroom
}

describe("capabilities", () => {
    test("only fee-ordered policies justify fetching a network gas price", () => {
        expect(getSequencerBehaviour("fcfs").feesAffectOrdering).toBe(false)
        expect(getSequencerBehaviour("timeboost").feesAffectOrdering).toBe(
            false
        )
        expect(getSequencerBehaviour("pga").feesAffectOrdering).toBe(true)
        expect(getSequencerBehaviour("priority-fee").feesAffectOrdering).toBe(
            true
        )
    })

    test("no Arbitrum-stack policy supports replace-by-fee", () => {
        for (const policy of ["fcfs", "timeboost", "pga"] as const) {
            expect(getSequencerBehaviour(policy).supportsReplaceByFee).toBe(
                false
            )
        }
        expect(getSequencerBehaviour("priority-fee").supportsReplaceByFee).toBe(
            true
        )
    })

    test("submit blocks until sequenced on every Arbitrum-stack policy", () => {
        for (const policy of ["fcfs", "timeboost", "pga"] as const) {
            expect(
                getSequencerBehaviour(policy).submitBlocksUntilSequenced
            ).toBe(true)
        }
        // A standard mempool chain returns on acceptance, so the receipt does
        // not exist yet and inclusion has to be observed rather than fetched.
        expect(
            getSequencerBehaviour("priority-fee").submitBlocksUntilSequenced
        ).toBe(false)
    })

    test("priority fees are only charged where they order", () => {
        for (const policy of [
            "priority-fee",
            "fcfs",
            "timeboost",
            "pga"
        ] as const) {
            const c = getSequencerBehaviour(policy)
            expect(c.priorityFeeIsCharged).toBe(c.feesAffectOrdering)
        }
    })

    test("defaults preserve existing behaviour per chain type", () => {
        expect(defaultOrderingPolicy("arbitrum")).toBe("fcfs")
        expect(defaultOrderingPolicy("default")).toBe("priority-fee")
        expect(defaultOrderingPolicy("op-stack")).toBe("priority-fee")
    })
})

describe("arrival-ordered policies (fcfs, timeboost)", () => {
    test("bid is base fee times the multiplier, both fields equal", () => {
        const result = bid("fcfs")
        expect(result.maxFeePerGas).toBe(BASE_FEE * 5n)
        expect(result.maxPriorityFeePerGas).toBe(BASE_FEE * 5n)
    })

    test("timeboost bids identically to fcfs — fees order in neither", () => {
        expect(bid("timeboost")).toStrictEqual(bid("fcfs"))
    })

    test("resubmission widens base-fee headroom by 20% per attempt", () => {
        expect(bid("fcfs", { submissionAttempts: 1 }).maxFeePerGas).toBe(
            ((BASE_FEE * 120n) / 100n) * 5n
        )
    })

    test("ignores the network gas price entirely", () => {
        const withTip = bid("fcfs", {
            networkGasPrice: {
                maxFeePerGas: 999n * GWEI,
                maxPriorityFeePerGas: 999n * GWEI
            }
        })
        expect(withTip).toStrictEqual(bid("fcfs"))
    })
})

describe("pga", () => {
    test("bids the suggested tip, not a base-fee multiple", () => {
        const result = bid("pga", {
            networkGasPrice: {
                maxFeePerGas: 0n,
                maxPriorityFeePerGas: GWEI / 100n
            }
        })
        expect(result.maxPriorityFeePerGas).toBe(GWEI / 100n)
        expect(effectiveTip(result, BASE_FEE)).toBe(GWEI / 100n)
    })

    test("regression: equal fields would bid (multiplier - 1) x base fee", () => {
        // What the pre-PGA Arbitrum branch produces. Kept as an explicit
        // counter-example: it is a valid transaction that silently pays
        // 4 x baseFee once tips are collected.
        const arrivalBid = bid("fcfs")
        expect(effectiveTip(arrivalBid, BASE_FEE)).toBe(BASE_FEE * 4n)

        // The pga branch must not do that.
        const pgaBid = bid("pga", {
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
        })
        expect(effectiveTip(pgaBid, BASE_FEE)).toBe(0n)
    })

    test("intended tip survives a base fee rise, rather than decaying", () => {
        const tip = GWEI / 100n
        const result = bid("pga", {
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: tip }
        })
        // Push the base fee all the way to the headroom limit. This is the case
        // that distinguishes additive headroom from multiplicative: if
        // maxFeePerGas were `multiplier x baseFee` alone, the whole tip would be
        // consumed here and the effective bid would collapse to zero — silently,
        // exactly when competition is highest.
        for (const risen of [BASE_FEE * 2n, BASE_FEE * 4n, BASE_FEE * 5n]) {
            expect(effectiveTip(result, risen)).toBe(tip)
        }
    })

    test("a tip larger than the headroom is still bid in full", () => {
        // Headroom scales with base fee, so on a cheap chain a meaningful tip
        // can exceed it. maxFeePerGas must still cover baseFee + tip.
        const tip = BASE_FEE * 100n
        const result = bid("pga", {
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: tip }
        })
        expect(effectiveTip(result, BASE_FEE)).toBe(tip)
    })

    test("resubmission raises the tip, not just the headroom", () => {
        const tip = GWEI / 100n
        const first = bid("pga", {
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: tip }
        })
        const retry = bid("pga", {
            submissionAttempts: 1,
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: tip }
        })
        expect(retry.maxPriorityFeePerGas).toBeGreaterThan(
            first.maxPriorityFeePerGas
        )
    })
})

describe("priority-fee (public mempool)", () => {
    test("resubmission clears the 1.10 replacement floor at every attempt", () => {
        let previous = bid("priority-fee").maxFeePerGas
        for (let attempt = 1; attempt <= 8; attempt++) {
            const next = bid("priority-fee", {
                submissionAttempts: attempt
            }).maxFeePerGas
            expect(next * 100n).toBeGreaterThanOrEqual(previous * 110n)
            previous = next
        }
    })

    test("legacy chains collapse to a single gas price", () => {
        const result = getBundleGasPrice({
            policy: "priority-fee",
            submissionAttempts: 0,
            networkGasPrice: {
                maxFeePerGas: 2n * GWEI,
                maxPriorityFeePerGas: GWEI
            },
            networkBaseFee: BASE_FEE,
            totalBeneficiaryFees: 10n * GWEI,
            bundleGasUsed: 1_000_000n,
            config: { ...config, legacyTransactions: true }
        })
        expect(result.maxFeePerGas).toBe(result.maxPriorityFeePerGas)
    })
})
