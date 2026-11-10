import { formatEther } from "viem"

// The receipt fields the cost calculation reads, declared structurally.
// viem types effectiveGasPrice as a required bigint and does not type the
// chain-specific fields at all, so reading them off a TransactionReceipt
// would need casts. A real TransactionReceipt is assignable to this.
export type TransactionCostFields = {
    gasUsed: bigint
    effectiveGasPrice?: bigint | null
    gasPrice?: bigint | string | null
    l1Fee?: bigint | string | null
}

// Total cost of a bundling transaction in ETH, or undefined when the receipt
// carries no usable gas price. Never writes to the receipt: the same object is
// shared with the bundle status result.
export const computeTransactionCostEth = (
    receipt: TransactionCostFields
): number | undefined => {
    // Post-London receipts carry effectiveGasPrice; some chains only return the
    // legacy gasPrice. viem's formatter converts effectiveGasPrice to a bigint
    // but spreads gasPrice through untouched, so the fallback can still be the
    // raw hex string the node returned.
    const gasPrice = receipt.effectiveGasPrice ?? receipt.gasPrice

    if (gasPrice === undefined || gasPrice === null) {
        return undefined
    }

    const l2GasCostTx = receipt.gasUsed * BigInt(gasPrice.toString())

    // Handle L1 fee if present (for L2 chains like Optimism)
    let l1Fee = 0n
    if (receipt.l1Fee !== undefined && receipt.l1Fee !== null) {
        l1Fee = BigInt(receipt.l1Fee.toString())
    }

    // Convert wei to ETH using viem's formatEther
    return Number(formatEther(l2GasCostTx + l1Fee))
}
