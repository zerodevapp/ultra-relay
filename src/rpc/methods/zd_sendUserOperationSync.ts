import {
    type OpEventType,
    RpcError,
    SyncUserOpErrors,
    type UserOperationReceipt,
    ValidationErrors,
    zdSendUserOperationSyncSchema
} from "@alto/types"
import type { Hex } from "viem"
import { createMethodHandler } from "../createMethodHandler"
import type { RpcHandler } from "../rpcHandler"
import { submitUserOperation } from "./eth_sendUserOperation"

const METHOD = "zd_sendUserOperationSync"

// Events after which the op will not change state again on its own.
const INCLUDED_EVENTS = new Set<OpEventType["eventType"]>([
    "included_onchain",
    "execution_reverted_onchain",
    "frontran_onchain"
])
const DROPPED_EVENTS = new Set<OpEventType["eventType"]>([
    "dropped",
    "failed_onchain"
])

type Outcome =
    | { kind: "included" }
    | { kind: "dropped"; event: OpEventType }
    | { kind: "receipt"; receipt: UserOperationReceipt }
    | { kind: "timeout" }

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener("abort", () => {
            clearTimeout(timer)
            resolve()
        })
    })

// With horizontal scaling another instance may bundle the op, and its events
// never reach this process, so the receipt has to be looked up as well.
const pollReceipt = async (
    rpcHandler: RpcHandler,
    userOpHash: Hex,
    signal: AbortSignal
): Promise<Outcome> => {
    const interval = Math.max(1_000, rpcHandler.config.blockTime)
    while (!signal.aborted) {
        await sleep(interval, signal)
        if (signal.aborted) {
            break
        }
        const receipt = await rpcHandler.bundleManager
            .getUserOpReceipt(userOpHash)
            .catch(() => null)
        if (receipt) {
            return { kind: "receipt", receipt }
        }
    }
    return { kind: "timeout" }
}

export const zdSendUserOperationSyncHandler = createMethodHandler({
    method: METHOD,
    schema: zdSendUserOperationSyncSchema,
    handler: async ({ rpcHandler, params, apiVersion }) => {
        const { config } = rpcHandler
        if (!config.enableSyncUseropEndpoint) {
            throw new RpcError(
                `${METHOD} endpoint is not enabled`,
                ValidationErrors.InvalidRequest
            )
        }

        const [userOp, entryPoint, options] = params
        const timeoutMs = Math.min(
            options?.timeoutMs ?? config.syncUseropDefaultTimeoutMs,
            config.syncUseropMaxTimeoutMs
        )

        let settled: Promise<Outcome> | undefined
        let unwatch = () => {}
        const abort = new AbortController()

        try {
            const userOpHash = await submitUserOperation({
                rpcHandler,
                userOp,
                entryPoint,
                apiVersion,
                method: METHOD,
                onUserOpHash: (hash) => {
                    settled = new Promise((resolve) => {
                        unwatch = rpcHandler.eventManager.watchUserOp(
                            hash,
                            (event) => {
                                if (INCLUDED_EVENTS.has(event.eventType)) {
                                    resolve({ kind: "included" })
                                } else if (
                                    DROPPED_EVENTS.has(event.eventType)
                                ) {
                                    resolve({ kind: "dropped", event })
                                }
                            }
                        )
                    })
                }
            })

            const waits: Promise<Outcome>[] = [
                sleep(timeoutMs, abort.signal).then(() => ({
                    kind: "timeout" as const
                }))
            ]
            if (settled) {
                waits.push(settled)
            }
            if (config.enableHorizontalScaling) {
                waits.push(pollReceipt(rpcHandler, userOpHash, abort.signal))
            }
            const outcome = await Promise.race(waits)

            if (outcome.kind === "receipt") {
                return outcome.receipt
            }
            if (outcome.kind === "included") {
                // The bundle manager caches the receipt before it emits the
                // inclusion event, so this is a cache read.
                const receipt =
                    await rpcHandler.bundleManager.getUserOpReceipt(userOpHash)
                if (receipt) {
                    return receipt
                }
            }
            if (outcome.kind === "dropped") {
                const { event } = outcome
                const reason =
                    "data" in event && "reason" in event.data
                        ? event.data.reason
                        : undefined
                throw new RpcError(
                    `userOp ${event.eventType}${reason ? `: ${reason}` : ""}`,
                    SyncUserOpErrors.Dropped,
                    { userOpHash, reason: reason ?? event.eventType }
                )
            }

            rpcHandler.logger.info(
                { userOpHash, timeoutMs },
                `${METHOD} returned before inclusion`
            )
            throw new RpcError(
                "userOp not included before timeout",
                SyncUserOpErrors.Timeout,
                { userOpHash }
            )
        } finally {
            abort.abort()
            unwatch()
        }
    }
})
