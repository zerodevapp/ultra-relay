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
    timeout,
    logger
}: {
    walletClient: WalletClient<Transport, Chain, Account | undefined>
    request: SendTransactionParameters<Chain, Account | undefined>
    timeout?: number
    logger: Logger
}): Promise<Hex> {
    const account_ = request.account ?? walletClient.account
    const account = account_ ? parseAccount(account_) : undefined
    if (account?.type !== "local") {
        throw new Error("sync submission requires a local executor account")
    }

    let signedTransaction: Hex | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let expire: (() => void) | undefined
    // Starts at signing, so a timeout never abandons a send still being prepared.
    const expired = new Promise<never>((_, reject) => {
        expire = () =>
            reject(
                new BaseError(
                    `eth_sendRawTransactionSync timed out after ${timeout}ms`
                )
            )
    })
    const recordingAccount: LocalAccount = {
        ...account,
        signTransaction: async (transaction, options) => {
            signedTransaction = await account.signTransaction(
                transaction,
                options
            )
            if (timeout !== undefined) {
                timer = setTimeout(() => expire?.(), timeout)
            }
            return signedTransaction
        }
    }

    try {
        // Nitro rejects viem's numeric `timeout` param (it wants a hex quantity)
        // and anvil rejects both forms, so bound the wait here instead.
        const send = walletClient.sendTransactionSync({
            ...request,
            account: recordingAccount
        })
        send.catch(() => undefined)
        try {
            return (await Promise.race([send, expired])).transactionHash
        } finally {
            clearTimeout(timer)
        }
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
