import {
    type Address,
    type ApiVersion,
    type ReferencedCodeHashes,
    RpcError,
    type UserOperation,
    ValidationErrors,
    sendUserOperationSchema
} from "@alto/types"
import type * as validation from "@alto/types"
import {
    calcExecutionPvgComponent,
    calcL2PvgComponent,
    getAAError,
    getSerializedHandleOpsTx,
    scaleBigIntByPercent,
    timed
} from "@alto/utils"
import { size, type Hex } from "viem"
import { getBundleCaps } from "../../executor/bundleCaps"
import { calculateAA95GasFloor } from "../../executor/utils"
import { getNonceKeyAndSequence, getUserOpHash } from "../../utils/userop"
import { createMethodHandler } from "../createMethodHandler"
import type { RpcHandler } from "../rpcHandler"

const validatePvg = async (
    apiVersion: ApiVersion,
    rpcHandler: RpcHandler,
    userOp: UserOperation,
    entryPoint: Address,
    boost = false
): Promise<[boolean, string]> => {
    // PVG validation is skipped for v1
    if (apiVersion === "v1" || boost) {
        return [true, ""]
    }

    const executionGasComponent = calcExecutionPvgComponent({
        userOp,
        supportsEip7623: rpcHandler.config.supportsEip7623,
        config: rpcHandler.config
    })
    const l2GasComponent = await calcL2PvgComponent({
        config: rpcHandler.config,
        userOp,
        entryPoint,
        gasPriceManager: rpcHandler.gasPriceManager,
        validate: true
    })
    const requiredPvg = executionGasComponent + l2GasComponent

    if (requiredPvg > userOp.preVerificationGas) {
        return [
            false,
            `preVerificationGas is not enough, required: ${requiredPvg}, got: ${userOp.preVerificationGas}`
        ]
    }

    return [true, ""]
}

const getUserOpValidationResult = async (
    rpcHandler: RpcHandler,
    userOp: UserOperation,
    entryPoint: Address
): Promise<{
    queuedUserOps: UserOperation[]
    validationResult: validation.ValidationResult & {
        storageMap: validation.StorageMap
        referencedContracts?: ReferencedCodeHashes
    }
}> => {
    const queuedUserOps: UserOperation[] =
        await rpcHandler.mempool.getQueuedOutstandingUserOps({
            userOp,
            entryPoint
        })
    const validationResult = await rpcHandler.validator.validateUserOp({
        userOp,
        queuedUserOps,
        entryPoint
    })

    return {
        queuedUserOps,
        validationResult
    }
}

export async function addToMempoolIfValid({
    rpcHandler,
    userOp,
    entryPoint,
    apiVersion,
    boost = false
}: {
    rpcHandler: RpcHandler
    userOp: UserOperation
    entryPoint: Address
    apiVersion: ApiVersion
    boost?: boolean
}): Promise<{ userOpHash: Hex; result: "added" | "queued" }> {
    rpcHandler.ensureEntryPointIsSupported(entryPoint)

    const logCtx = { sender: userOp.sender, apiVersion, boost }

    // Compute the hash first so cap-check rejections can be properly attributed.
    // getUserOpHash is sync for v06/v07 and a cheap contract-read for v08, so
    // this adds negligible latency before the expensive parallel block below.
    const userOpHash = await timed(
        rpcHandler.logger,
        "getUserOpHash",
        logCtx,
        () =>
            getUserOpHash({
                userOp,
                entryPointAddress: entryPoint,
                chainId: rpcHandler.config.chainId,
                publicClient: rpcHandler.config.publicClient
            })
    )

    // Per-transaction bundle-cap validation: an op that alone exceeds this
    // chain's per-tx gas or calldata-size cap can never be included in any
    // bundle, so reject it here instead of letting it black-hole in the mempool.
    // Must run before the parallel validation block (which runs on-chain
    // simulation) so that oversized ops are rejected before simulation fires.
    //
    // Only enforced when the caps are PROVEN hard limits for this chain
    // (doc-verified map entry). On an unlisted chain the caps are a
    // conservative guess and rejecting against a guess can reject a valid
    // userOp -- there the node is the judge: the op is accepted, sent alone if
    // needed, and only dropped on a ground-truth node rejection (executor).
    // Bytes are checked against the RAW hard cap (no safety margin): the
    // margin exists for multi-op packing estimates, and applying it here
    // would reject ops in the [90%, 100%) band that the node accepts.
    const { gasCap, byteCap, proven } = getBundleCaps(rpcHandler.config)
    if (proven) {
        const singleOpGas = scaleBigIntByPercent(
            calculateAA95GasFloor({
                userOps: [userOp],
                beneficiary: rpcHandler.config.utilityWalletAddress
            }) + (userOp.eip7702Auth ? 40_000n : 0n),
            105n
        )
        if (singleOpGas > gasCap) {
            const reason = `userOperation exceeds the per-transaction gas cap for this chain (cap: ${gasCap}, required: ~${singleOpGas})`
            rpcHandler.eventManager.emitFailedValidation(userOpHash, reason)
            throw new RpcError(reason, ValidationErrors.InvalidFields)
        }
        const singleOpBytes = size(
            getSerializedHandleOpsTx({
                userOps: [userOp],
                entryPoint,
                chainId: rpcHandler.config.chainId,
                removeZeros: false
            })
        )
        if (singleOpBytes > byteCap) {
            const reason = `userOperation exceeds the per-transaction calldata size cap for this chain (cap: ${byteCap} bytes, size: ${singleOpBytes} bytes)`
            rpcHandler.eventManager.emitFailedValidation(userOpHash, reason)
            throw new RpcError(reason, ValidationErrors.InvalidFields)
        }
    }

    // Execute remaining async operations in parallel. Each step is timed
    // individually so the slowest can be identified from logs (wall-clock
    // latency = slowest step, not the sum).
    const [
        { queuedUserOps, validationResult },
        currentNonceSeq,
        [pvgSuccess, pvgErrorReason],
        [preMempoolSuccess, preMempoolError],
        [validEip7702Auth, validEip7702AuthError]
    ] = await Promise.all([
        timed(rpcHandler.logger, "getUserOpValidationResult", logCtx, () =>
            getUserOpValidationResult(rpcHandler, userOp, entryPoint)
        ),
        timed(rpcHandler.logger, "getNonceSeq", logCtx, () =>
            rpcHandler.getNonceSeq(userOp, entryPoint)
        ),
        timed(rpcHandler.logger, "validatePvg", logCtx, () =>
            validatePvg(apiVersion, rpcHandler, userOp, entryPoint, boost)
        ),
        timed(rpcHandler.logger, "preMempoolChecks", logCtx, () =>
            rpcHandler.preMempoolChecks(userOp, apiVersion, boost)
        ),
        timed(rpcHandler.logger, "validateEip7702Auth", logCtx, () =>
            rpcHandler.validateEip7702Auth({
                userOp,
                validateSender: true
            })
        )
    ])

    // Validate eip7702Auth
    if (!validEip7702Auth) {
        rpcHandler.eventManager.emitFailedValidation(
            userOpHash,
            validEip7702AuthError
        )
        throw new RpcError(
            validEip7702AuthError,
            ValidationErrors.InvalidFields
        )
    }

    // Pre mempool validation
    if (!preMempoolSuccess) {
        rpcHandler.eventManager.emitFailedValidation(
            userOpHash,
            preMempoolError
        )
        throw new RpcError(preMempoolError, ValidationErrors.InvalidFields)
    }

    // PreVerificationGas validation
    if (!pvgSuccess) {
        rpcHandler.eventManager.emitFailedValidation(userOpHash, pvgErrorReason)
        throw new RpcError(pvgErrorReason, ValidationErrors.SimulateValidation)
    }

    // Nonce validation
    const [, userOpNonceSeq] = getNonceKeyAndSequence(userOp.nonce)
    if (userOpNonceSeq < currentNonceSeq) {
        const reason =
            "UserOperation failed validation with reason: AA25 invalid account nonce"
        rpcHandler.eventManager.emitFailedValidation(userOpHash, reason, "AA25")
        throw new RpcError(reason, ValidationErrors.InvalidFields)
    }

    if (userOpNonceSeq > currentNonceSeq + 10n) {
        const reason =
            "UserOperation failed validaiton with reason: AA25 invalid account nonce"
        rpcHandler.eventManager.emitFailedValidation(userOpHash, reason, "AA25")
        throw new RpcError(reason, ValidationErrors.InvalidFields)
    }

    if (userOpNonceSeq > currentNonceSeq + BigInt(queuedUserOps.length)) {
        rpcHandler.mempool.add(userOp, entryPoint)
        rpcHandler.eventManager.emitQueued(userOpHash)
        return { result: "queued", userOpHash }
    }

    // userOp validation
    if (rpcHandler.config.dangerousSkipUserOperationValidation) {
        const [isMempoolAddSuccess, mempoolAddError] =
            await rpcHandler.mempool.add(userOp, entryPoint)

        if (!isMempoolAddSuccess) {
            rpcHandler.eventManager.emitFailedValidation(
                userOpHash,
                mempoolAddError,
                getAAError(mempoolAddError)
            )
            throw new RpcError(mempoolAddError, ValidationErrors.InvalidFields)
        }
        return { result: "added", userOpHash }
    }

    // ERC-7562 scope rule validation
    rpcHandler.reputationManager.checkReputation(
        userOp,
        entryPoint,
        validationResult
    )

    await rpcHandler.mempool.checkEntityMultipleRoleViolation(
        entryPoint,
        userOp
    )

    // Finally, add to mempool
    const [isMempoolAddSuccess, mempoolAddError] = await rpcHandler.mempool.add(
        userOp,
        entryPoint,
        validationResult.referencedContracts
    )

    if (!isMempoolAddSuccess) {
        rpcHandler.eventManager.emitFailedValidation(
            userOpHash,
            mempoolAddError,
            getAAError(mempoolAddError)
        )
        throw new RpcError(mempoolAddError, ValidationErrors.InvalidFields)
    }

    return { result: "added", userOpHash }
}

export const ethSendUserOperationHandler = createMethodHandler({
    method: "eth_sendUserOperation",
    schema: sendUserOperationSchema,
    handler: async ({ rpcHandler, params, apiVersion }) => {
        const handlerStart = performance.now()
        const [userOp, entryPoint] = params

        const boost =
            userOp.maxFeePerGas === 0n && userOp.maxPriorityFeePerGas === 0n

        rpcHandler.logger.info(
            { sender: userOp.sender, apiVersion, boost, entryPoint },
            "[timing] eth_sendUserOperation received"
        )

        let status: "added" | "queued" | "rejected" = "rejected"
        let resolvedUserOpHash: Hex | undefined
        try {
            const { result, userOpHash } = await addToMempoolIfValid({
                rpcHandler,
                userOp,
                entryPoint,
                apiVersion,
                boost
            })

            status = result
            resolvedUserOpHash = userOpHash

            rpcHandler.eventManager.emitReceived(userOpHash)

            return userOpHash
        } catch (error) {
            status = "rejected"
            throw error
        } finally {
            rpcHandler.metrics.userOperationsReceived
                .labels({
                    status,
                    type: userOp.eip7702Auth ? "7702" : "regular"
                })
                .inc()

            rpcHandler.logger.info(
                {
                    sender: userOp.sender,
                    apiVersion,
                    boost,
                    status,
                    userOpHash: resolvedUserOpHash,
                    ms: Math.round(performance.now() - handlerStart)
                },
                "[timing] eth_sendUserOperation total"
            )
        }
    }
})
