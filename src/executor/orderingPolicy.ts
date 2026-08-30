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

const BEHAVIOUR: Record<OrderingPolicy, SequencerBehaviour> = {
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
}

// Consumers, so that a declared-but-unread capability is not mistaken for a
// behaviour that is already handled:
//   feesAffectOrdering          - read by `isBidNoLongerViable`, which decides
//                                 the resubmission trigger in
//                                 `potentiallyResubmitBundle`. Should also gate
//                                 the `preBundle.networkGasPrice` fetch, since
//                                 the value cannot change any outcome when
//                                 false — not yet done.
//   priorityFeeIsCharged        - implicit in the bid functions below.
//   supportsReplaceByFee        - not yet consumed. Resubmission still bumps and
//                                 resends the same nonce on every policy. Fixing
//                                 that needs a strategy decision (wait out the
//                                 original, or cancel and replace under a fresh
//                                 nonce), so it is deliberately deferred.
//   submitBlocksUntilSequenced  - not yet consumed. Should decide whether
//                                 inclusion is confirmed by fetching the receipt
//                                 immediately after submit, or by waiting for the
//                                 block watcher.
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

// Has an already-submitted bundle's bid stopped being good enough to rely on?
// A true result is a reason to re-price and resubmit; it is deliberately
// separate from the stuck-timeout check, which is about time rather than price.
export function isBidNoLongerViable({
    policy,
    bid,
    networkGasPrice,
    networkBaseFee
}: {
    policy: OrderingPolicy
    bid: GasPriceParameters
    networkGasPrice: GasPriceParameters
    networkBaseFee: bigint
}): boolean {
    if (getSequencerBehaviour(policy).feesAffectOrdering) {
        // Fees determine position, so falling behind the network price means
        // losing it and the bundle should be re-priced to compete.
        return (
            bid.maxFeePerGas < networkGasPrice.maxFeePerGas ||
            bid.maxPriorityFeePerGas < networkGasPrice.maxPriorityFeePerGas
        )
    }

    // Arrival-ordered: the network gas price has no bearing on inclusion, so
    // comparing against it re-prices bundles that were never at risk. The one
    // fee-related failure that matters here is the bid falling below the base
    // fee, where the sequencer rejects the transaction outright rather than
    // sequencing it late.
    return bid.maxFeePerGas < networkBaseFee
}

type BidInputs = {
    policy: OrderingPolicy
    submissionAttempts: number
    networkGasPrice: GasPriceParameters
    networkBaseFee: bigint
    totalBeneficiaryFees: bigint
    bundleGasUsed: bigint
    config: {
        bundlerInitialCommission: bigint
        resubmitMultiplierCeiling: bigint
        arbitrumGasBidMultiplier: bigint
        legacyTransactions: boolean
    }
}

export function getBundleGasPrice(inputs: BidInputs): GasPriceParameters {
    switch (inputs.policy) {
        case "fcfs":
        case "timeboost":
            return arrivalOrderedBid(inputs)
        case "pga":
            return priorityAuctionBid(inputs)
        default:
            return mempoolBid(inputs)
    }
}

// Fees do not order, so the only job of the bid is to stay above the base fee
// for as long as the transaction is pending. The multiplier is headroom against
// base-fee movement, not a competitive bid — it costs nothing because the sender
// pays the base fee either way.
function arrivalOrderedBid({
    submissionAttempts,
    networkBaseFee,
    config
}: BidInputs): GasPriceParameters {
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
function priorityAuctionBid({
    submissionAttempts,
    networkGasPrice,
    networkBaseFee,
    config
}: BidInputs): GasPriceParameters {
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

function mempoolBid({
    submissionAttempts,
    networkGasPrice,
    networkBaseFee,
    totalBeneficiaryFees,
    bundleGasUsed,
    config
}: BidInputs): GasPriceParameters {
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
