import type { Address, ApiVersion, UserOperation } from "@alto/types"
import { calcExecutionPvgComponent, calcL2PvgComponent } from "@alto/utils"
import { toHex } from "viem"
import type { RpcHandler } from "../rpcHandler"

const OBSERVATION_INTERVAL_MS = 1_000
const observations = new WeakMap<
    RpcHandler,
    { inFlight: boolean; nextSampleAt: number }
>()

async function getRequiredPvg(
    rpcHandler: RpcHandler,
    userOp: UserOperation,
    entryPoint: Address
): Promise<bigint> {
    const executionGas = calcExecutionPvgComponent({
        userOp,
        supportsEip7623: rpcHandler.config.supportsEip7623,
        config: rpcHandler.config
    })
    const l2Gas = await calcL2PvgComponent({
        config: rpcHandler.config,
        userOp,
        entryPoint,
        gasPriceManager: rpcHandler.gasPriceManager,
        validate: true
    })
    return executionGas + l2Gas
}

function observePvg(
    apiVersion: ApiVersion,
    rpcHandler: RpcHandler,
    userOp: UserOperation,
    entryPoint: Address
): void {
    const now = performance.now()
    const state = observations.get(rpcHandler)
    if (state && (state.inFlight || now < state.nextSampleAt)) {
        return
    }
    const sample = {
        inFlight: true,
        nextSampleAt: now + OBSERVATION_INTERVAL_MS
    }
    observations.set(rpcHandler, sample)
    const fields = {
        apiVersion,
        entryPoint,
        sender: userOp.sender,
        declaredPvg: toHex(userOp.preVerificationGas)
    }
    // At most one in-flight sample per handler, starting at most once a
    // second. Observation never waits on a fee oracle in the request path.
    void getRequiredPvg(rpcHandler, userOp, entryPoint)
        .then((requiredPvg) => {
            rpcHandler.logger.info(
                {
                    ...fields,
                    requiredPvg: toHex(requiredPvg),
                    wouldReject: requiredPvg > userOp.preVerificationGas
                },
                "boost pvg check"
            )
        })
        .catch((error: unknown) => {
            rpcHandler.logger.error(
                {
                    ...fields,
                    calculationError:
                        error instanceof Error ? error.message : String(error)
                },
                "boost pvg check failed"
            )
        })
        .finally(() => {
            sample.inFlight = false
        })
}

export async function validatePvg(
    apiVersion: ApiVersion,
    rpcHandler: RpcHandler,
    userOp: UserOperation,
    entryPoint: Address,
    boost = false
): Promise<[boolean, string]> {
    if (boost && !rpcHandler.config.enforceBoostPvg) {
        if (rpcHandler.config.observeBoostPvg) {
            observePvg(apiVersion, rpcHandler, userOp, entryPoint)
        }
        return [true, ""]
    }
    // Retain legacy v1 behavior for non-boosted userOperations only.
    // Enabled boosted enforcement must cover both API versions/endpoints.
    if (apiVersion === "v1" && !boost) {
        return [true, ""]
    }
    const requiredPvg = await getRequiredPvg(rpcHandler, userOp, entryPoint)
    if (requiredPvg > userOp.preVerificationGas) {
        return [
            false,
            `preVerificationGas is not enough, required: ${requiredPvg}, got: ${userOp.preVerificationGas}`
        ]
    }
    return [true, ""]
}
