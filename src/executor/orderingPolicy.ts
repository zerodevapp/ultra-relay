import type { GasPriceParameters } from "@alto/types"
import { maxBigInt, minBigInt, scaleBigIntByPercent } from "@alto/utils"

// How a chain's sequencer decides which transactions go first. This is
// deliberately separate from `chainType`: the same chain can change ordering
// policy without changing chain (Arbitrum One is moving from Timeboost to PGA),
// and two chains on the same stack can order differently (Arbitrum One runs
// Timeboost today while Orbit chains default to first-come-first-served).
export type OrderingPolicy =
    // Public mempool. The bid determines inclusion order, and replacing a
    // pending transaction requires clearing the node's replacement rule.
    | "priority-fee"
    // Arrival order. Fees are ignored for ordering and the sender pays the base
    // fee regardless of what it bids.
    | "fcfs"
    // Arrival order, plus a 200ms delay applied to every transaction that does
    // not arrive through the express lane. Bids still do not affect ordering.
    | "timeboost"
    // Priority gas auction. The sequencer ranks a round's transactions by
    // effective tip, and that tip is charged. Arbitrum One, once ArbOS
    // `collectTips` is enabled.
    | "pga"

// How the sequencer ranks transactions.
export type OrderingCapabilities = {
    // Does the bid influence inclusion order? When false there is no reason to
    // fetch a network gas price at all — the value cannot change any outcome —
    // and "our bid is below the network price" is not a reason to resubmit.
    feesAffectOrdering: boolean
    // Is a priority fee actually collected? When false, bidding high is free
    // headroom against base-fee movement. When true, the same headroom is money.
    priorityFeeIsCharged: boolean
}

// What happens to a transaction that is already pending.
export type ReplacementCapabilities = {
    // Can a pending transaction be replaced by resubmitting the same nonce with
    // a higher bid? False on every Arbitrum-stack policy: the sequencer queue is
    // not a mempool and has no replace-by-fee. Resubmitting a nonce there leaves
    // *two* copies competing, and the loser occupies a queue slot until it fails
    // the nonce check or times out.
    supportsReplaceByFee: boolean
}

// What `eth_sendRawTransaction` means on this chain.
export type SubmissionCapabilities = {
    // Does the submit call return only once the transaction has been sequenced
    // into a block? True across the Arbitrum stack, false on a standard mempool
    // chain where submission returns on acceptance. When true the receipt exists
    // the moment submit returns, so inclusion can be confirmed directly instead
    // of by waiting for a block watcher to notice.
    submitBlocksUntilSequenced: boolean
}

// Three independent concerns, resolved from one table because they happen to
// co-vary across every policy we support today. The types are declared
// separately so that splitting them later — when some chain breaks the
// correlation — is a mechanical change to this lookup rather than to callers.
export type SequencerBehaviour = OrderingCapabilities &
    ReplacementCapabilities &
    SubmissionCapabilities

// `satisfies` rather than a `: Record<...>` annotation, which would widen every
// flag to `boolean` and leave the policy families below deriving to `never`.
// `satisfies` checks the table just as the annotation did while keeping each
// flag's literal type. `as const` adds nothing to that — it is here only to
// make the table readonly.
const BEHAVIOUR = {
    "priority-fee": {
        feesAffectOrdering: true,
        priorityFeeIsCharged: true,
        supportsReplaceByFee: true,
        submitBlocksUntilSequenced: false
    },
    fcfs: {
        feesAffectOrdering: false,
        priorityFeeIsCharged: false,
        supportsReplaceByFee: false,
        submitBlocksUntilSequenced: true
    },
    timeboost: {
        feesAffectOrdering: false,
        priorityFeeIsCharged: false,
        supportsReplaceByFee: false,
        submitBlocksUntilSequenced: true
    },
    pga: {
        feesAffectOrdering: true,
        priorityFeeIsCharged: true,
        supportsReplaceByFee: false,
        submitBlocksUntilSequenced: true
    }
} as const satisfies Record<OrderingPolicy, SequencerBehaviour>

// The two policy families, read off the table rather than declared next to it.
// Declaring them separately would state `feesAffectOrdering` twice and let a
// policy be fee-ordered in one place and arrival-ordered in the other; derived,
// that is not expressible. Adding a policy to the table puts it in a family
// automatically.
type PoliciesWhereFeesOrder<Ordered extends boolean> = {
    [P in OrderingPolicy]: (typeof BEHAVIOUR)[P]["feesAffectOrdering"] extends Ordered
        ? P
        : never
}[OrderingPolicy]

// The bid competes for position, so it is priced against a network gas price
// and that price has to be fetched.
export type FeeOrderedPolicy = PoliciesWhereFeesOrder<true>

// The bid does not compete for position, so nothing prices against a network
// gas price and none is fetched.
export type ArrivalOrderedPolicy = PoliciesWhereFeesOrder<false>

// Consumers, so that a declared-but-unread capability is not mistaken for a
// behaviour that is already handled:
//   feesAffectOrdering          - read by `isBidNoLongerViable`, which decides
//                                 the resubmission trigger in
//                                 `potentiallyResubmitBundle`, and by
//                                 `needsNetworkGasPrice`, which gates the gas
//                                 price fetch on both the bundling and the
//                                 re-pricing paths.
//   priorityFeeIsCharged        - implicit in the bid functions below.
//   supportsReplaceByFee        - not yet consumed. Resubmission still bumps and
//                                 resends the same nonce on every policy. Fixing
//                                 that needs a strategy decision (wait out the
//                                 original, or cancel and replace under a fresh
//                                 nonce), so it is deliberately deferred.
//   submitBlocksUntilSequenced  - read by `earlyInclusionChecksEnabled`, which
//                                 decides whether inclusion is polled for
//                                 immediately after submit or left to the block
//                                 watcher. Only worth polling where the receipt
//                                 can already exist when submit returns.
export function getSequencerBehaviour(
    policy: OrderingPolicy
): SequencerBehaviour {
    return BEHAVIOUR[policy]
}

// Chains whose ordering policy we know. Everything else keeps the historical
// behaviour of pricing against the network gas price.
export function defaultOrderingPolicy(chainType: string): OrderingPolicy {
    return chainType === "arbitrum" ? "fcfs" : "priority-fee"
}

export function resolveOrderingPolicy(config: {
    orderingPolicy?: OrderingPolicy
    chainType: string
}): OrderingPolicy {
    return config.orderingPolicy ?? defaultOrderingPolicy(config.chainType)
}

// Is the network gas price worth an RPC call under this policy? Only where the
// bid competes for position: elsewhere no bid, resubmission trigger, or gas
// decision reads it, so fetching it buys nothing and costs a round trip on the
// bundling path.
//
// This is the single point where the runtime capability table and the static
// split between the two policy families are asserted to agree. Narrowing here
// is what lets `BundlePricing` be built without a cast and read without a
// guard, so the agreement is pinned by a test rather than trusted.
export function needsNetworkGasPrice(
    policy: OrderingPolicy
): policy is FeeOrderedPolicy {
    return getSequencerBehaviour(policy).feesAffectOrdering
}

// What a bundle is priced against. The network gas price is present exactly
// when the policy prices against one, so "fees order but no price was fetched"
// cannot be constructed — no optional to thread, no guard to forget, and no
// runtime check that the fetch decision and the bid agree.
type ArrivalOrderedPricing = {
    policy: ArrivalOrderedPolicy
    networkBaseFee: bigint
}

type FeeOrderedPricing = {
    policy: FeeOrderedPolicy
    networkBaseFee: bigint
    networkGasPrice: GasPriceParameters
}

export type BundlePricing = ArrivalOrderedPricing | FeeOrderedPricing

// The network gas price, where one was fetched. Only for reporting: no pricing
// decision reads this, since each one narrows on the policy instead.
export function reportedNetworkGasPrice(
    pricing: BundlePricing
): GasPriceParameters | undefined {
    return "networkGasPrice" in pricing ? pricing.networkGasPrice : undefined
}

// Pricing that can never judge a bid stale, for when the fetch fails. Zeros
// leave `isBidNoLongerViable` false and the bundle to the stuck-timeout check,
// which is how a failed fetch has always been treated.
export function unpricedFallback(policy: OrderingPolicy): BundlePricing {
    if (needsNetworkGasPrice(policy)) {
        return {
            policy,
            networkBaseFee: 0n,
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
        }
    }

    return { policy, networkBaseFee: 0n }
}

// Has an already-submitted bundle's bid stopped being good enough to rely on?
// A true result is a reason to re-price and resubmit; it is deliberately
// separate from the stuck-timeout check, which is about time rather than price.
export function isBidNoLongerViable({
    pricing,
    bid
}: {
    pricing: BundlePricing
    bid: GasPriceParameters
}): boolean {
    if ("networkGasPrice" in pricing) {
        // Fees determine position, so falling behind the network price means
        // losing it and the bundle should be re-priced to compete.
        return (
            bid.maxFeePerGas < pricing.networkGasPrice.maxFeePerGas ||
            bid.maxPriorityFeePerGas <
                pricing.networkGasPrice.maxPriorityFeePerGas
        )
    }

    // Arrival-ordered: the network gas price has no bearing on inclusion, so
    // comparing against it re-prices bundles that were never at risk. The one
    // fee-related failure that matters here is the bid falling below the base
    // fee, where the sequencer rejects the transaction outright rather than
    // sequencing it late.
    return bid.maxFeePerGas < pricing.networkBaseFee
}

type BidInputs = {
    pricing: BundlePricing
    submissionAttempts: number
    totalBeneficiaryFees: bigint
    bundleGasUsed: bigint
    config: {
        bundlerInitialCommission: bigint
        resubmitMultiplierCeiling: bigint
        arbitrumGasBidMultiplier: bigint
        legacyTransactions: boolean
    }
}

// Exhaustive over the policy, so adding one without deciding how it bids is a
// compile error rather than a silent fall-through to the mempool bid.
export function getBundleGasPrice(inputs: BidInputs): GasPriceParameters {
    const { pricing } = inputs

    switch (pricing.policy) {
        case "fcfs":
        case "timeboost":
            return arrivalOrderedBid(inputs, pricing)
        case "pga":
            return priorityAuctionBid(inputs, pricing)
        case "priority-fee":
            return mempoolBid(inputs, pricing)
    }
}

// Fees do not order, so the only job of the bid is to stay above the base fee
// for as long as the transaction is pending. The multiplier is headroom against
// base-fee movement, not a competitive bid — it costs nothing because the sender
// pays the base fee either way.
function arrivalOrderedBid(
    { submissionAttempts, config }: BidInputs,
    { networkBaseFee }: ArrivalOrderedPricing
): GasPriceParameters {
    const scaledBaseFee = scaleBigIntByPercent(
        networkBaseFee,
        100n + 20n * BigInt(submissionAttempts)
    )

    const bid = scaledBaseFee * config.arbitrumGasBidMultiplier

    return { maxFeePerGas: bid, maxPriorityFeePerGas: bid }
}

// The sequencer ranks by `min(maxPriorityFeePerGas, maxFeePerGas - baseFee)`,
// so the two fields have distinct jobs and must not be set to the same value:
// doing that bids `(multiplier - 1) x baseFee` by accident, and that tip is
// charged. maxFeePerGas carries the base-fee headroom, maxPriorityFeePerGas
// carries the bid, and the headroom is added on top so a rising base fee cannot
// silently erode the intended tip.
//
// ASSUMPTION: `networkGasPrice.maxPriorityFeePerGas` is a usable suggestion.
// Today `eth_maxPriorityFeePerGas` returns 0 on Arbitrum One and there is no tip
// oracle in nitro — the RPC's premise ("there are no tips in L2") predates PGA
// and has not been revisited. We are assuming it will be fixed before PGA
// activates. If it is not, this bids zero on every bundle and relies on the
// anti-starvation boost, which has no hard bound; the fix is a receipt-derived
// estimator (`effectiveGasPrice - baseFeePerGas` over recent blocks) feeding
// this function instead.
function priorityAuctionBid(
    { submissionAttempts, config }: BidInputs,
    { networkGasPrice, networkBaseFee }: FeeOrderedPricing
): GasPriceParameters {
    const tip = scaleBigIntByPercent(
        networkGasPrice.maxPriorityFeePerGas,
        100n + 20n * BigInt(submissionAttempts)
    )

    const baseFeeHeadroom = networkBaseFee * config.arbitrumGasBidMultiplier

    return {
        maxFeePerGas: baseFeeHeadroom + tip,
        maxPriorityFeePerGas: tip
    }
}

function mempoolBid(
    {
        submissionAttempts,
        totalBeneficiaryFees,
        bundleGasUsed,
        config
    }: BidInputs,
    { networkGasPrice, networkBaseFee }: FeeOrderedPricing
): GasPriceParameters {
    let [networkMaxFeePerGas, networkMaxPriorityFeePerGas] = [
        networkGasPrice.maxFeePerGas,
        networkGasPrice.maxPriorityFeePerGas
    ]

    if (submissionAttempts > 0) {
        // Geometric: keeps retry/prev ratio at 1.20; linear `100+20·N`
        // drops below the 1.10 mempool replacement floor at N=7.
        let multiplier = 100n
        for (let i = 0; i < submissionAttempts; i++) {
            multiplier = (multiplier * 120n) / 100n
        }

        networkMaxFeePerGas = scaleBigIntByPercent(
            networkMaxFeePerGas,
            minBigInt(multiplier, config.resubmitMultiplierCeiling)
        )
        networkMaxPriorityFeePerGas = scaleBigIntByPercent(
            networkMaxPriorityFeePerGas,
            minBigInt(multiplier, config.resubmitMultiplierCeiling)
        )
    }

    // The bundler should place a gasBid that is competetive with the network's
    // gasPrice.
    const breakEvenGasPrice = totalBeneficiaryFees / bundleGasUsed

    // Calculate commission: start at bundlerInitialCommission%, then
    // halve the commission with each resubmission attempt
    const currentCommission =
        config.bundlerInitialCommission / 2n ** BigInt(submissionAttempts)
    const pricingPercent = 100n - currentCommission

    const bundlingGasPrice = scaleBigIntByPercent(
        breakEvenGasPrice,
        pricingPercent
    )

    if (config.legacyTransactions) {
        const gasPrice = maxBigInt(bundlingGasPrice, networkMaxFeePerGas)
        return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }
    }

    const effectiveGasPrice = minBigInt(
        networkMaxFeePerGas,
        networkBaseFee + networkMaxPriorityFeePerGas
    )

    if (bundlingGasPrice > effectiveGasPrice) {
        return {
            maxFeePerGas: bundlingGasPrice,
            maxPriorityFeePerGas: bundlingGasPrice
        }
    }

    return {
        maxFeePerGas: networkMaxFeePerGas,
        maxPriorityFeePerGas: networkMaxPriorityFeePerGas
    }
}
