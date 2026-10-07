import type { Logger } from "@alto/utils"
import {
    type Account,
    BaseError,
    type Chain,
    type Hex,
    type SendTransactionParameters,
    type TransactionSerializable,
    type Transport,
    type WalletClient,
    keccak256,
    shouldThrow
} from "viem"
import { parseAccount } from "viem/accounts"
import { getTransactionError } from "viem/utils"
import type { BundleTransactionReceipt } from "./getBundleStatus"

// EIP-7966 code 4: the node accepted the tx but did not include it in time.
export const isSyncTimeout = (e: unknown) =>
    e instanceof BaseError &&
    e.walk((node) => (node as { code?: unknown }).code === 4) !== null

// A timed-out tx was accepted; resending it to the next transport would fail.
export const syncShouldThrow = (e: Error) => shouldThrow(e) || isSyncTimeout(e)

// Half the wallet transport's 10 s HTTP timeout, so the node times the call
// out (code 4) before the client does. Geth holds it 20 s by default; Nitro
// ignores it and answers once the tx is in a block. Anvil rejects the param.
const SYNC_TIMEOUT_MS = 5_000

export type SentTransaction = {
    transactionHash: Hex
    receipt?: BundleTransactionReceipt
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
        const receipt = await walletClient.sendRawTransactionSync({
            serializedTransaction,
            timeout: SYNC_TIMEOUT_MS,
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
