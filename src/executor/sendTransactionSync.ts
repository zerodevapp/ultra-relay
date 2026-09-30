import type { Logger } from "@alto/utils"
import {
    type Account,
    BaseError,
    type Chain,
    type Hex,
    type LocalAccount,
    type SendTransactionParameters,
    type Transport,
    type WalletClient,
    keccak256,
    shouldThrow
} from "viem"
import { parseAccount } from "viem/accounts"

// EIP-7966 code 4, older nodes' wording, or viem giving up client-side.
const SYNC_TIMEOUT = /timeout|timed out|wasn't processed|not processed in time/i

export const isSyncTimeout = (e: unknown) =>
    e instanceof BaseError &&
    e.walk((node) => {
        const { name, code, message, details } = node as {
            name?: string
            code?: unknown
            message?: string
            details?: string
        }
        return (
            code === 4 ||
            name === "TimeoutError" ||
            SYNC_TIMEOUT.test(`${message} ${details}`)
        )
    }) !== null

// A timed-out tx was accepted; resending it elsewhere fails as a duplicate.
export const syncShouldThrow = (e: Error) => shouldThrow(e) || isSyncTimeout(e)

// viem drops the hash on timeout; record the signed tx so a timeout stays pending.
export async function sendTransactionSync({
    walletClient,
    request,
    logger
}: {
    walletClient: WalletClient<Transport, Chain, Account | undefined>
    request: SendTransactionParameters<Chain, Account | undefined>
    logger: Logger
}): Promise<Hex> {
    const account_ = request.account ?? walletClient.account
    const account = account_ ? parseAccount(account_) : undefined
    if (account?.type !== "local") {
        throw new Error("sync submission requires a local executor account")
    }

    let signedTransaction: Hex | undefined
    const recordingAccount: LocalAccount = {
        ...account,
        signTransaction: async (transaction, options) => {
            signedTransaction = await account.signTransaction(
                transaction,
                options
            )
            return signedTransaction
        }
    }

    try {
        const receipt = await walletClient.sendTransactionSync({
            ...request,
            account: recordingAccount
        })
        return receipt.transactionHash
    } catch (e) {
        // Unsigned means nothing was sent.
        if (!signedTransaction || !isSyncTimeout(e)) {
            throw e
        }
        const transactionHash = keccak256(signedTransaction)
        logger.warn(
            { txHash: transactionHash },
            "eth_sendRawTransactionSync timed out before inclusion, tracking the transaction as pending"
        )
        return transactionHash
    }
}
