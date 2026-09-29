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
    keccak256
} from "viem"
import { parseAccount } from "viem/accounts"

type SyncWalletClient = WalletClient<Transport, Chain, Account | undefined>

// viem's own sendTransactionSync throws on a receipt timeout without the hash, so
// this prepares and signs the same way it does and keeps the hash for that case.
// eth_sendRawTransactionSync returns the receipt at inclusion instead of
// eth_sendRawTransaction returning a hash the caller then has to poll for.
async function sendTransactionSync(
    client: SyncWalletClient,
    request: SendTransactionParameters<Chain, Account | undefined>
): Promise<{ transactionHash: Hex; timedOut: boolean }> {
    const account_ = request.account ?? client.account
    const account = account_ ? parseAccount(account_) : undefined
    if (account?.type !== "local") {
        throw new Error("sync submission requires a local executor account")
    }
    const prepared = await client.prepareTransactionRequest({
        ...request,
        account
    })
    // Signed with the account directly, as viem's sendTransaction does:
    // client.signTransaction would first spend an eth_chainId round trip.
    const serializedTransaction = await account.signTransaction(
        prepared as TransactionSerializable,
        {
            serializer: client.chain.serializers?.transaction
        }
    )

    // A timeout means the node accepted the transaction but it wasn't included in
    // time, so it is on its way on chain. Throwing here would make the bundle look
    // failed and requeue its userOps while the original lands untracked, so return
    // the locally computed hash and let the block watcher treat it as pending, the
    // same state the async path leaves a bundle in.
    try {
        const receipt = await client.sendRawTransactionSync({
            serializedTransaction
        })
        return { transactionHash: receipt.transactionHash, timedOut: false }
    } catch (e) {
        if (!isSyncTimeout(e)) {
            throw e
        }
        return {
            transactionHash: keccak256(serializedTransaction),
            timedOut: true
        }
    }
}

type ErrorNode = {
    name?: string
    code?: unknown
    message?: string
    details?: string
}

const walkError = (e: unknown, match: (node: ErrorNode) => boolean) =>
    e instanceof BaseError &&
    e.walk((node) => match(node as ErrorNode)) !== null

// EIP-7966 reports a receipt wait that ran out with code 4 ("added to the mempool
// but wasn't processed in time"); nodes that predate the final code say so in the
// message. viem's own TimeoutError means the client gave up waiting, which is just
// as ambiguous about whether the node accepted the transaction.
const SYNC_TIMEOUT = /timeout|timed out|wasn't processed|not processed in time/i

const isSyncTimeout = (e: unknown) =>
    walkError(
        e,
        (node) =>
            node.code === 4 ||
            node.name === "TimeoutError" ||
            SYNC_TIMEOUT.test(`${node.message} ${node.details}`)
    )

// Same try-then-latch viem's own sendTransaction uses for wallet_sendTransaction:
// the first real send is the probe, and an endpoint that lacks the method costs one
// extra round trip per process. Keyed by client uid because the private and public
// wallet clients are different nodes.
const syncUnsupported = new Set<string>()

export const isSyncSubmissionSupported = (client: { uid: string }) =>
    !syncUnsupported.has(client.uid)

// Name and code both, because some providers answer an unknown method with an
// error viem never wrapped. Not InvalidInputRpcError: viem maps every -32000 to it,
// and nodes also use -32000 for underpriced and nonce-too-low. The message match is
// for Alchemy, which reports the method as unavailable per network with -32600
// ("eth_sendRawTransactionSync is not available on the ETH_MAINNET"), and is keyed
// on the method name so no other -32600 can latch the arm off.
const METHOD_UNAVAILABLE =
    /eth_sendRawTransactionSync.{0,20}(not available|not supported|does not exist)/i

const isMethodNotFound = (e: unknown) =>
    walkError(
        e,
        (node) =>
            node.name === "MethodNotFoundRpcError" ||
            node.name === "MethodNotSupportedRpcError" ||
            node.code === -32601 ||
            node.code === -32004 ||
            METHOD_UNAVAILABLE.test(`${node.message} ${node.details}`)
    )

export async function sendTransactionSyncOrFallback(
    client: SyncWalletClient,
    request: SendTransactionParameters<Chain, Account | undefined>,
    logger: Logger
): Promise<Hex> {
    if (!isSyncSubmissionSupported(client)) {
        return await client.sendTransaction(request)
    }
    try {
        const { transactionHash, timedOut } = await sendTransactionSync(
            client,
            request
        )
        if (timedOut) {
            logger.warn(
                { chainId: client.chain.id, txHash: transactionHash },
                "eth_sendRawTransactionSync timed out before inclusion, tracking the transaction as pending"
            )
        }
        return transactionHash
    } catch (e) {
        if (!isMethodNotFound(e)) {
            throw e
        }
        syncUnsupported.add(client.uid)
        logger.warn(
            { chainId: client.chain.id },
            "eth_sendRawTransactionSync unsupported, falling back to eth_sendRawTransaction"
        )
        return await client.sendTransaction(request)
    }
}
