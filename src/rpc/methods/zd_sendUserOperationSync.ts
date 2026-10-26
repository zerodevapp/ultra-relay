import {
    RpcError,
    SyncUserOpErrors,
    ValidationErrors,
    zdSendUserOperationSyncSchema
} from "@alto/types"
import { waitForUserOpSettlement } from "../../executor/userOpSettlement"
import { createMethodHandler } from "../createMethodHandler"
import { submitUserOperation } from "./eth_sendUserOperation"

export const zdSendUserOperationSyncHandler = createMethodHandler({
    method: "zd_sendUserOperationSync",
    schema: zdSendUserOperationSyncSchema,
    handler: async ({ rpcHandler, params, apiVersion }) => {
        const { config } = rpcHandler
        if (!config.enableSyncUseropEndpoint) {
            throw new RpcError(
                "zd_sendUserOperationSync endpoint is not enabled",
                ValidationErrors.InvalidRequest
            )
        }

        const [userOp, entryPoint, options] = params
        const userOpHash = await submitUserOperation({
            rpcHandler,
            userOp,
            entryPoint,
            apiVersion,
            method: "zd_sendUserOperationSync"
        })

        const settlement = await waitForUserOpSettlement({
            userOpHash,
            timeoutMs: Math.min(
                options?.timeoutMs ?? config.syncUseropDefaultTimeoutMs,
                config.syncUseropMaxTimeoutMs
            ),
            pollIntervalMs: Math.max(1_000, config.blockTime),
            eventManager: rpcHandler.eventManager,
            monitor: rpcHandler.monitor,
            bundleManager: rpcHandler.bundleManager
        })
        rpcHandler.metrics.syncUserOperations
            .labels({ outcome: settlement.kind })
            .inc()

        switch (settlement.kind) {
            case "receipt":
                return settlement.receipt
            case "dropped":
                throw new RpcError(
                    `userOp dropped: ${settlement.reason}`,
                    SyncUserOpErrors.Dropped,
                    { userOpHash, reason: settlement.reason }
                )
            case "timeout":
                throw new RpcError(
                    "userOp not included before timeout",
                    SyncUserOpErrors.Timeout,
                    { userOpHash }
                )
        }
    }
})
