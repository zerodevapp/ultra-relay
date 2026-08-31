import type { GasPriceParameters } from "@alto/types"
import { describe, expect, test, vi } from "vitest"
import {
    type ArrivalOrderedPolicy,
    type BundlePricing,
    type FeeOrderedPolicy,
    type OrderingPolicy,
    buildBundlePricing,
    defaultOrderingPolicy,
    getBundleGasPrice,
    getSequencerBehaviour,
    isBidNoLongerViable,
    reportedNetworkGasPrice,
    resolveOrderingPolicy,
    unpricedFallback
} from "./orderingPolicy"

const GWEI = 1_000_000_000n
const BASE_FEE = GWEI / 50n // 0.02 gwei, Arbitrum One's resting base fee

const config = {
    bundlerInitialCommission: 10n,
    resubmitMultiplierCeiling: 1000n,
    arbitrumGasBidMultiplier: 5n,
    legacyTransactions: false
}

// Assembles the pricing for a policy so the cases below can stay flat. Which
// shape gets built is the production decision itself, taken by the same
// predicate the bundler uses.
const pricingFor = (
    policy: OrderingPolicy,
    {
        networkGasPrice = {
            maxFeePerGas: 2n * GWEI,
            maxPriorityFeePerGas: GWEI
        },
        networkBaseFee = BASE_FEE
    }: {
        networkGasPrice?: GasPriceParameters
        networkBaseFee?: bigint
    } = {}
): BundlePricing =>
    policy === "fcfs" || policy === "timeboost"
        ? { policy, networkBaseFee }
        : { policy, networkBaseFee, networkGasPrice }

const bid = (
    policy: OrderingPolicy,
    overrides: {
        submissionAttempts?: number
        networkGasPrice?: GasPriceParameters
        networkBaseFee?: bigint
    } = {}
) =>
    getBundleGasPrice({
        pricing: pricingFor(policy, overrides),
        submissionAttempts: overrides.submissionAttempts ?? 0,
        totalBeneficiaryFees: 10n * GWEI,
        bundleGasUsed: 1_000_000n,
        config
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

describe("sorting a policy into its family", () => {
    const fetchers = () => ({
        baseFee: vi.fn(() => 7n),
        gasPrice: vi.fn(() => ({
            maxFeePerGas: 2n * GWEI,
            maxPriorityFeePerGas: GWEI
        }))
    })

    // The guarantee the switch buys: the gas price fetcher is not merely
    // ignored for an arrival-ordered policy, it is never called. That is what
    // makes the saved round trip structural rather than a caller's discipline.
    test.each(["fcfs", "timeboost"] as const)(
        "%s never calls the gas price fetcher",
        async (policy) => {
            const fetch = fetchers()

            await expect(buildBundlePricing(policy, fetch)).resolves.toEqual({
                policy,
                networkBaseFee: 7n
            })
            expect(fetch.gasPrice).not.toHaveBeenCalled()
            expect(fetch.baseFee).toHaveBeenCalledTimes(1)
        }
    )

    test.each(["pga", "priority-fee"] as const)(
        "%s fetches both and carries the price",
        async (policy) => {
            const fetch = fetchers()

            await expect(buildBundlePricing(policy, fetch)).resolves.toEqual({
                policy,
                networkBaseFee: 7n,
                networkGasPrice: {
                    maxFeePerGas: 2n * GWEI,
                    maxPriorityFeePerGas: GWEI
                }
            })
            expect(fetch.gasPrice).toHaveBeenCalledTimes(1)
        }
    )

    // The families are derived from the capability table, so they cannot drift
    // from it. What they can do is derive to something useless — `never`, or a
    // family with the wrong members — if the condition or the annotation on the
    // table changes, and that would compile while silently voiding every
    // narrowing below. Checked by tsc over this file, not at runtime.
    test("the derived families are exactly the table's two halves", () => {
        type Exact<A, B> = [A] extends [B]
            ? [B] extends [A]
                ? true
                : false
            : false
        const feeOrdered: Exact<FeeOrderedPolicy, "priority-fee" | "pga"> = true
        const arrival: Exact<ArrivalOrderedPolicy, "fcfs" | "timeboost"> = true

        expect([feeOrdered, arrival]).toEqual([true, true])
    })

    test.each(["fcfs", "timeboost"] as const)(
        "%s carries no network gas price to report",
        (policy) => {
            expect(reportedNetworkGasPrice(pricingFor(policy))).toBeUndefined()
        }
    )

    test.each(["pga", "priority-fee"] as const)(
        "%s reports the price it was built with",
        (policy) => {
            expect(reportedNetworkGasPrice(pricingFor(policy))).toEqual({
                maxFeePerGas: 2n * GWEI,
                maxPriorityFeePerGas: GWEI
            })
        }
    )

    // What a failed fetch degrades to. Zeros can never make a bid look stale,
    // so the bundle is left to the stuck-timeout check instead of being
    // re-priced against a number we never actually read.
    test.each(["fcfs", "timeboost", "pga", "priority-fee"] as const)(
        "%s: an unpriced fallback never judges a bid stale",
        async (policy) => {
            // Zero, not merely small: the fallback must be unable to judge
            // any bid stale, and only a zero base fee makes that true for
            // every bid rather than for comfortably-priced ones.
            for (const bid of [
                { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
                { maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI }
            ]) {
                expect(
                    isBidNoLongerViable({
                        pricing: await unpricedFallback(policy),
                        bid
                    })
                ).toBe(false)
            }
        }
    )
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
            pricing: pricingFor("priority-fee"),
            submissionAttempts: 0,
            totalBeneficiaryFees: 10n * GWEI,
            bundleGasUsed: 1_000_000n,
            config: { ...config, legacyTransactions: true }
        })
        expect(result.maxFeePerGas).toBe(result.maxPriorityFeePerGas)
    })
})

describe("isBidNoLongerViable", () => {
    const viable = (
        policy: OrderingPolicy,
        o: {
            bid?: GasPriceParameters
            networkGasPrice?: GasPriceParameters
            networkBaseFee?: bigint
        } = {}
    ) =>
        isBidNoLongerViable({
            pricing: pricingFor(policy, {
                networkGasPrice: o.networkGasPrice ?? {
                    maxFeePerGas: 100n * GWEI,
                    maxPriorityFeePerGas: 100n * GWEI
                },
                networkBaseFee: o.networkBaseFee ?? BASE_FEE
            }),
            bid: o.bid ?? {
                maxFeePerGas: BASE_FEE * 5n,
                maxPriorityFeePerGas: BASE_FEE * 5n
            }
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
                    // One pricing, used to build the bid and then to judge
                    // it: the round trip is the invariant.
                    const pricing = pricingFor(policy, {
                        networkGasPrice: {
                            maxFeePerGas: (baseFee * 120n) / 100n + tip,
                            maxPriorityFeePerGas: tip
                        },
                        networkBaseFee: baseFee
                    })
                    const bid = getBundleGasPrice({
                        pricing,
                        submissionAttempts: 0,
                        totalBeneficiaryFees: 10n * GWEI,
                        bundleGasUsed: 1_000_000n,
                        config
                    })

                    expect(
                        isBidNoLongerViable({ pricing, bid }),
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
