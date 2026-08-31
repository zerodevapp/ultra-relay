import { describe, expect, test } from "vitest"
import {
    type OrderingPolicy,
    defaultOrderingPolicy,
    getBundleGasPrice,
    getSequencerBehaviour,
    isBidNoLongerViable,
    needsNetworkGasPrice,
    resolveOrderingPolicy
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

describe("skipping the network gas price fetch", () => {
    test("only fee-ordered policies need one", () => {
        expect(needsNetworkGasPrice("fcfs")).toBe(false)
        expect(needsNetworkGasPrice("timeboost")).toBe(false)
        expect(needsNetworkGasPrice("pga")).toBe(true)
        expect(needsNetworkGasPrice("priority-fee")).toBe(true)
    })

    // The gate and the bid must agree about who needs a price. These two pin
    // both halves of that contract: the policies the gate exempts must build a
    // bid without one, and the policies it does not exempt must refuse to
    // invent one rather than silently misbidding every bundle.
    test.each(["fcfs", "timeboost"] as const)(
        "%s bids without a network gas price",
        (policy) => {
            const priced = bid(policy)
            const unpriced = bid(policy, { networkGasPrice: undefined })

            expect(unpriced).toEqual(priced)
        }
    )

    test.each(["pga", "priority-fee"] as const)(
        "%s refuses to bid without a network gas price",
        (policy) => {
            expect(() => bid(policy, { networkGasPrice: undefined })).toThrow(
                /network gas price/
            )
        }
    )

    // A fee-ordered chain whose fetch fails still passes zeros, so undefined
    // here can only mean the gate skipped it — on a policy that never consults
    // it. Re-pricing on that absence would resubmit against no evidence.
    test("an absent price is not treated as the network having fallen to zero", () => {
        expect(
            isBidNoLongerViable({
                policy: "priority-fee",
                bid: { maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI },
                networkGasPrice: undefined,
                networkBaseFee: BASE_FEE
            })
        ).toBe(false)
    })
})

describe("resolveOrderingPolicy", () => {
    test("falls back to the chainType default", () => {
        expect(resolveOrderingPolicy({ chainType: "arbitrum" })).toBe("fcfs")
        expect(resolveOrderingPolicy({ chainType: "default" })).toBe(
            "priority-fee"
        )
    })

    test("an explicit policy wins over the chainType default", () => {
        expect(
            resolveOrderingPolicy({
                chainType: "arbitrum",
                orderingPolicy: "pga"
            })
        ).toBe("pga")
    })
})

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

describe("isBidNoLongerViable", () => {
    const viable = (policy: OrderingPolicy, o: Record<string, unknown> = {}) =>
        isBidNoLongerViable({
            policy,
            bid: {
                maxFeePerGas: BASE_FEE * 5n,
                maxPriorityFeePerGas: BASE_FEE * 5n
            },
            networkGasPrice: {
                maxFeePerGas: 100n * GWEI,
                maxPriorityFeePerGas: 100n * GWEI
            },
            networkBaseFee: BASE_FEE,
            ...o
        })

    test("arrival-ordered: a healthy bid is not re-priced just for lagging the network price", () => {
        // The live bug this fixes. An fcfs bid of baseFee x 5 is nowhere near
        // the network gas price, but the network price orders nothing, so the
        // bundle was never at risk. Re-pricing it here would resubmit the same
        // nonce and leave two copies competing.
        expect(viable("fcfs")).toBe(false)
        expect(viable("timeboost")).toBe(false)
    })

    test("arrival-ordered: a bid that no longer clears the base fee is re-priced", () => {
        // The failure that does matter: below the base fee the sequencer
        // rejects the transaction outright rather than sequencing it late.
        expect(viable("fcfs", { networkBaseFee: BASE_FEE * 6n })).toBe(true)
    })

    test("mempool: falling behind the network price still triggers a re-price", () => {
        expect(viable("priority-fee")).toBe(true)
    })

    test("mempool: re-prices when only one of the two fees lags", () => {
        // Guards the || in the fee-ordered branch: either field falling behind
        // is enough, and requiring both would let a stale bid sit.
        expect(
            viable("priority-fee", {
                bid: {
                    maxFeePerGas: 1n,
                    maxPriorityFeePerGas: 100n * GWEI
                }
            })
        ).toBe(true)
        expect(
            viable("priority-fee", {
                bid: {
                    maxFeePerGas: 100n * GWEI,
                    maxPriorityFeePerGas: 1n
                }
            })
        ).toBe(true)
    })

    test("mempool: a competitive bid is left alone", () => {
        expect(
            viable("priority-fee", {
                networkGasPrice: {
                    maxFeePerGas: 0n,
                    maxPriorityFeePerGas: 0n
                }
            })
        ).toBe(false)
    })

    test("pga: fees order again, so the network price is authoritative", () => {
        expect(viable("pga")).toBe(true)
        expect(
            viable("pga", {
                networkGasPrice: {
                    maxFeePerGas: 0n,
                    maxPriorityFeePerGas: 0n
                }
            })
        ).toBe(false)
    })
})

describe("early inclusion checks are safe to run immediately after submit", () => {
    // The early check reuses handleBlock, whose not_found branch can re-price a
    // bundle. That is only safe because a bundle we just built and submitted is
    // never itself considered non-viable — otherwise the check would resubmit
    // the transaction it had just sent. Pin the round trip for every policy.
    const policies: OrderingPolicy[] = [
        "priority-fee",
        "fcfs",
        "timeboost",
        "pga"
    ]

    for (const policy of policies) {
        test(`${policy}: a freshly built bid is not already stale`, () => {
            for (const baseFee of [1n, BASE_FEE, GWEI, 50n * GWEI]) {
                for (const tip of [0n, GWEI / 100n, GWEI]) {
                    const networkGasPrice = {
                        maxFeePerGas: (baseFee * 120n) / 100n + tip,
                        maxPriorityFeePerGas: tip
                    }
                    const bid = getBundleGasPrice({
                        policy,
                        submissionAttempts: 0,
                        networkGasPrice,
                        networkBaseFee: baseFee,
                        totalBeneficiaryFees: 10n * GWEI,
                        bundleGasUsed: 1_000_000n,
                        config
                    })

                    expect(
                        isBidNoLongerViable({
                            policy,
                            bid,
                            networkGasPrice,
                            networkBaseFee: baseFee
                        }),
                        `${policy} baseFee=${baseFee} tip=${tip} -> ${JSON.stringify(
                            {
                                maxFeePerGas: String(bid.maxFeePerGas),
                                maxPriorityFeePerGas: String(
                                    bid.maxPriorityFeePerGas
                                )
                            }
                        )}`
                    ).toBe(false)
                }
            }
        })
    }
})
