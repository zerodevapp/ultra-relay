import type { GasPriceParameters } from "@alto/types"
import { describe, expect, test, vi } from "vitest"
import {
    type BundlePricing,
    type OrderingPolicy,
    buildBundlePricing,
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
// Goes through the production builder rather than assembling the union here,
// so these fixtures are the shapes the bundler actually produces and the family
// split stays stated in exactly one place.
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
): Promise<BundlePricing> =>
    buildBundlePricing(policy, {
        baseFee: () => networkBaseFee,
        gasPrice: () => networkGasPrice
    })

const bid = async (
    policy: OrderingPolicy,
    overrides: {
        submissionAttempts?: number
        networkGasPrice?: GasPriceParameters
        networkBaseFee?: bigint
        arbitrumGasBidMultiplier?: bigint
    } = {}
) =>
    getBundleGasPrice({
        pricing: await pricingFor(policy, overrides),
        submissionAttempts: overrides.submissionAttempts ?? 0,
        totalBeneficiaryFees: 10n * GWEI,
        bundleGasUsed: 1_000_000n,
        config: {
            ...config,
            arbitrumGasBidMultiplier:
                overrides.arbitrumGasBidMultiplier ??
                config.arbitrumGasBidMultiplier
        }
    })

// The sequencer's ranking key. Getting this wrong is silent: the transaction is
// still valid and still included, it just pays a tip nobody chose.
const effectiveTip = (
    { maxFeePerGas, maxPriorityFeePerGas }: Awaited<ReturnType<typeof bid>>,
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

    test.each(["fcfs", "timeboost"] as const)(
        "%s carries no network gas price to report",
        async (policy) => {
            expect(
                reportedNetworkGasPrice(await pricingFor(policy))
            ).toBeUndefined()
        }
    )

    test.each(["pga", "priority-fee"] as const)(
        "%s reports the price it was built with",
        async (policy) => {
            expect(reportedNetworkGasPrice(await pricingFor(policy))).toEqual({
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

const ALL_POLICIES = ["priority-fee", "fcfs", "timeboost", "pga"] as const

describe("priorityFeeIsCharged", () => {
    // arbitrumGasBidMultiplier is headroom against base-fee movement. Where the
    // priority fee is not charged, bidding that headroom as tip is free. Where
    // it is charged the same headroom is money, so it must not reach the tip —
    // which is the trap the pga bid was written to avoid, stated as a rule that
    // holds for every charged policy rather than a regression against one.
    //
    // Only the charged direction is asserted. That an uncharged policy's tip
    // does scale with the multiplier is true of today's arrival bid but is a
    // consequence of it, not a rule worth pinning.
    const charged = ALL_POLICIES.filter(
        (policy) => getSequencerBehaviour(policy).priorityFeeIsCharged
    )

    // Pins the scope of the check below, not the table for its own sake.
    // Marking a policy as uncharged silently stops the invariant applying to
    // it, which is how a bid that quietly pays a tip nobody chose would get
    // through. Whether a chain really charges tips is a fact about that chain
    // that no test can settle, so this is the tripwire for changing the claim.
    test("the invariant covers every policy that charges a tip", () => {
        expect(charged).toEqual(["priority-fee", "pga"])
    })

    test.each(charged)(
        "%s: the multiplier is headroom and never reaches the tip",
        async (policy) => {
            const networkGasPrice = {
                maxFeePerGas: 2n * GWEI,
                maxPriorityFeePerGas: GWEI / 100n
            }

            const tips = []
            for (const arbitrumGasBidMultiplier of [1n, 5n, 50n]) {
                const result = await bid(policy, {
                    networkGasPrice,
                    arbitrumGasBidMultiplier
                })
                tips.push(String(effectiveTip(result, BASE_FEE)))
            }

            expect(new Set(tips).size).toBe(1)
        }
    )
})

describe("resolveOrderingPolicy", () => {
    test("falls back to the chainType default", async () => {
        expect(resolveOrderingPolicy({ chainType: "arbitrum" })).toBe("fcfs")
        expect(resolveOrderingPolicy({ chainType: "default" })).toBe(
            "priority-fee"
        )
        // An unrecognised chain keeps the historical mempool behaviour.
        expect(resolveOrderingPolicy({ chainType: "op-stack" })).toBe(
            "priority-fee"
        )
    })

    test("an explicit policy wins over the chainType default", async () => {
        expect(
            resolveOrderingPolicy({
                chainType: "arbitrum",
                orderingPolicy: "pga"
            })
        ).toBe("pga")
    })
})

describe("arrival-ordered policies (fcfs, timeboost)", () => {
    test("bid is base fee times the multiplier, both fields equal", async () => {
        const result = await bid("fcfs")
        expect(result.maxFeePerGas).toBe(BASE_FEE * 5n)
        expect(result.maxPriorityFeePerGas).toBe(BASE_FEE * 5n)
    })

    test("timeboost bids identically to fcfs — fees order in neither", async () => {
        expect(await bid("timeboost")).toStrictEqual(await bid("fcfs"))
    })

    test("resubmission widens base-fee headroom by 20% per attempt", async () => {
        expect(
            (await bid("fcfs", { submissionAttempts: 1 })).maxFeePerGas
        ).toBe(((BASE_FEE * 120n) / 100n) * 5n)
    })

    test("ignores the network gas price entirely", async () => {
        const withTip = await bid("fcfs", {
            networkGasPrice: {
                maxFeePerGas: 999n * GWEI,
                maxPriorityFeePerGas: 999n * GWEI
            }
        })
        expect(withTip).toStrictEqual(await bid("fcfs"))
    })
})

describe("pga", () => {
    test("bids the suggested tip, not a base-fee multiple", async () => {
        const result = await bid("pga", {
            networkGasPrice: {
                maxFeePerGas: 0n,
                maxPriorityFeePerGas: GWEI / 100n
            }
        })
        expect(result.maxPriorityFeePerGas).toBe(GWEI / 100n)
        expect(effectiveTip(result, BASE_FEE)).toBe(GWEI / 100n)
    })

    test("regression: equal fields would bid (multiplier - 1) x base fee", async () => {
        // What the pre-PGA Arbitrum branch produces. Kept as an explicit
        // counter-example: it is a valid transaction that silently pays
        // 4 x baseFee once tips are collected.
        const arrivalBid = await bid("fcfs")
        expect(effectiveTip(arrivalBid, BASE_FEE)).toBe(BASE_FEE * 4n)

        // The pga branch must not do that.
        const pgaBid = await bid("pga", {
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
        })
        expect(effectiveTip(pgaBid, BASE_FEE)).toBe(0n)
    })

    test("intended tip survives a base fee rise, rather than decaying", async () => {
        const tip = GWEI / 100n
        const result = await bid("pga", {
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

    test("a tip larger than the headroom is still bid in full", async () => {
        // Headroom scales with base fee, so on a cheap chain a meaningful tip
        // can exceed it. maxFeePerGas must still cover baseFee + tip.
        const tip = BASE_FEE * 100n
        const result = await bid("pga", {
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: tip }
        })
        expect(effectiveTip(result, BASE_FEE)).toBe(tip)
    })

    test("resubmission raises the tip, not just the headroom", async () => {
        const tip = GWEI / 100n
        const first = await bid("pga", {
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: tip }
        })
        const retry = await bid("pga", {
            submissionAttempts: 1,
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: tip }
        })
        expect(retry.maxPriorityFeePerGas).toBeGreaterThan(
            first.maxPriorityFeePerGas
        )
    })
})

describe("priority-fee (public mempool)", () => {
    test("resubmission clears the 1.10 replacement floor at every attempt", async () => {
        let previous = (await bid("priority-fee")).maxFeePerGas
        for (let attempt = 1; attempt <= 8; attempt++) {
            const next = (
                await bid("priority-fee", {
                    submissionAttempts: attempt
                })
            ).maxFeePerGas
            expect(next * 100n).toBeGreaterThanOrEqual(previous * 110n)
            previous = next
        }
    })

    test("legacy chains collapse to a single gas price", async () => {
        const result = getBundleGasPrice({
            pricing: await pricingFor("priority-fee"),
            submissionAttempts: 0,
            totalBeneficiaryFees: 10n * GWEI,
            bundleGasUsed: 1_000_000n,
            config: { ...config, legacyTransactions: true }
        })
        expect(result.maxFeePerGas).toBe(result.maxPriorityFeePerGas)
    })
})

describe("isBidNoLongerViable", () => {
    const viable = async (
        policy: OrderingPolicy,
        o: {
            bid?: GasPriceParameters
            networkGasPrice?: GasPriceParameters
            networkBaseFee?: bigint
        } = {}
    ) =>
        isBidNoLongerViable({
            pricing: await pricingFor(policy, {
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

    test("arrival-ordered: a healthy bid is not re-priced just for lagging the network price", async () => {
        // The live bug this fixes. An fcfs bid of baseFee x 5 is nowhere near
        // the network gas price, but the network price orders nothing, so the
        // bundle was never at risk. Re-pricing it here would resubmit the same
        // nonce and leave two copies competing.
        expect(await viable("fcfs")).toBe(false)
        expect(await viable("timeboost")).toBe(false)
    })

    test("arrival-ordered: a bid that no longer clears the base fee is re-priced", async () => {
        // The failure that does matter: below the base fee the sequencer
        // rejects the transaction outright rather than sequencing it late.
        expect(await viable("fcfs", { networkBaseFee: BASE_FEE * 6n })).toBe(
            true
        )
    })

    test("mempool: falling behind the network price still triggers a re-price", async () => {
        expect(await viable("priority-fee")).toBe(true)
    })

    test("mempool: re-prices when only one of the two fees lags", async () => {
        // Guards the || in the fee-ordered branch: either field falling behind
        // is enough, and requiring both would let a stale bid sit.
        expect(
            await viable("priority-fee", {
                bid: {
                    maxFeePerGas: 1n,
                    maxPriorityFeePerGas: 100n * GWEI
                }
            })
        ).toBe(true)
        expect(
            await viable("priority-fee", {
                bid: {
                    maxFeePerGas: 100n * GWEI,
                    maxPriorityFeePerGas: 1n
                }
            })
        ).toBe(true)
    })

    test("mempool: a competitive bid is left alone", async () => {
        expect(
            await viable("priority-fee", {
                networkGasPrice: {
                    maxFeePerGas: 0n,
                    maxPriorityFeePerGas: 0n
                }
            })
        ).toBe(false)
    })

    test("pga: fees order again, so the network price is authoritative", async () => {
        expect(await viable("pga")).toBe(true)
        expect(
            await viable("pga", {
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
        test(`${policy}: a freshly built bid is not already stale`, async () => {
            for (const baseFee of [1n, BASE_FEE, GWEI, 50n * GWEI]) {
                for (const tip of [0n, GWEI / 100n, GWEI]) {
                    // One pricing, used to build the bid and then to judge
                    // it: the round trip is the invariant.
                    const pricing = await pricingFor(policy, {
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
