import type { Logger } from "@alto/utils"
import {
    type Account,
    BaseError,
    type Chain,
    type Hex,
    type SendTransactionParameters,
    type TransactionReceipt,
    type TransactionSerializable,
    type Transport,
    type WalletClient,
    keccak256,
    shouldThrow
} from "viem"
import { parseAccount } from "viem/accounts"
import { getTransactionError } from "viem/utils"

// EIP-7966 code 4: the node accepted the tx but did not include it in time.
const isSyncTimeout = (e: unknown) =>
    e instanceof BaseError &&
    e.walk((node) => (node as { code?: unknown }).code === 4) !== null

// Stops the private fallback transport: a timed-out tx was accepted, so the
// next transport would fail it as a duplicate.
export const syncShouldThrow = (e: Error) => shouldThrow(e) || isSyncTimeout(e)

export type SentTransaction = {
    transactionHash: Hex
    receipt?: TransactionReceipt
}

// Signs locally so a node timeout still yields the hash to track as pending.
export async function sendTransactionSync({
    walletClient,
    request,
    logger
}: {
    walletClient: WalletClient<Transport, Chain, Account | undefined>
    request: SendTransactionParameters<Chain, Account | undefined>
    logger: Logger
}): Promise<SentTransaction> {
    const account_ = request.account ?? walletClient.account
    const account = account_ && parseAccount(account_)
    if (account?.type !== "local") {
        throw new Error("sync submission requires a local executor account")
    }
    const prepared = await walletClient.prepareTransactionRequest({
        ...request,
        account
    })
    const serializedTransaction = await account.signTransaction(
        prepared as TransactionSerializable,
        { serializer: walletClient.chain.serializers?.transaction }
    )

    try {
        // No timeout param: live Arbitrum rejects it, and geth's 20 s default
        // fits the transport's 25 s timeout for this method.
        const receipt = await walletClient.sendRawTransactionSync({
            serializedTransaction,
            throwOnReceiptRevert: false
        })
        return { transactionHash: receipt.transactionHash, receipt }
    } catch (e) {
        if (!isSyncTimeout(e)) {
            throw getTransactionError(e as BaseError, {
                ...request,
                account,
                chain: walletClient.chain
            })
        }
        const transactionHash = keccak256(serializedTransaction)
        logger.warn(
            { txHash: transactionHash },
            "eth_sendRawTransactionSync timed out before inclusion, tracking the transaction as pending"
        )
        return { transactionHash }
    }
}
