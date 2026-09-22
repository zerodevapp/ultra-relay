import type { UserOperationReceipt } from "@alto/types"
import type { Logger } from "pino"
import type { Hex, PublicClient } from "viem"
import type { SubmittedBundleInfo } from "../types/mempool"
import { parseUserOpReceipt } from "../utils/userop"

// The exact object publicClient.getTransactionReceipt resolves to, so the
// receipt can be handed to cost accounting without a second fetch.
export type BundleTransactionReceipt = Awaited<
    ReturnType<PublicClient["getTransactionReceipt"]>
>

export type BundleIncluded = {
    status: "included"
    userOpReceipts: Record<Hex, UserOperationReceipt>
    transactionHash: Hex
    blockNumber: bigint
    receipt: BundleTransactionReceipt
}

export type BundleReverted = {
    status: "reverted"
    blockNumber: bigint
    transactionHash: Hex
    receipt: BundleTransactionReceipt
}

export type BundleNotFound = {
    status: "not_found"
}

export type BundleStatus<
    status extends "included" | "reverted" | "not_found" =
        | "included"
        | "reverted"
        | "not_found"
> =
    | (status extends "included" ? BundleIncluded : never)
    | (status extends "reverted" ? BundleReverted : never)
    | (status extends "not_found" ? BundleNotFound : never)

// Return the status of the bundling transaction.
export const getBundleStatus = async ({
    publicClient,
    submittedBundle
}: {
    submittedBundle: SubmittedBundleInfo
    publicClient: PublicClient
    logger: Logger
}): Promise<BundleStatus> => {
    const {
        transactionHash: currentHash,
        previousTransactionHashes: previousHashes,
        bundle
    } = submittedBundle

    const receipts = await Promise.all(
        [currentHash, ...previousHashes].map((hash) =>
            publicClient.getTransactionReceipt({ hash }).catch(() => undefined)
        )
    )

    const included = receipts.find((receipt) => receipt?.status === "success")

    // If any of the txs are included.
    if (included) {
        const { userOps } = bundle
        const { blockNumber, transactionHash } = included
        const userOpDetails: Record<Hex, UserOperationReceipt> = {}

        for (const { userOpHash } of userOps) {
            userOpDetails[userOpHash] = parseUserOpReceipt(userOpHash, included)
        }

        return {
            status: "included",
            userOpReceipts: userOpDetails,
            transactionHash,
            blockNumber,
            receipt: included
        }
    }

    const reverted = receipts.find((receipt) => receipt?.status === "reverted")

    // If any of the txs reverted.
    if (reverted) {
        const { blockNumber, transactionHash } = reverted
        return {
            status: "reverted",
            blockNumber,
            transactionHash,
            receipt: reverted
        }
    }

    // If none of the receipts are included or reverted, return not_found.
    return { status: "not_found" }
}
