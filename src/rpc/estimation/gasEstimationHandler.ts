import type { UserOperation } from "@alto/types"
import type { StateOverrides, UserOperationV07 } from "@alto/types"
import { deepHexlify, isVersion06 } from "@alto/utils"
import { type Hex, parseEther, toHex } from "viem"
import type { Address } from "viem"
import type { AltoConfig } from "../../createConfig"
import { GasEstimatorV06 } from "./gasEstimationsV06"
import { GasEstimatorV07 } from "./gasEstimationsV07"
import type { SimulateHandleOpResult } from "./types"

function getStateOverrides({
    addSenderBalanceOverride,
    userOperation,
    stateOverrides = {}
}: {
    addSenderBalanceOverride: boolean
    stateOverrides: StateOverrides
    userOperation: UserOperation
}) {
    const result: StateOverrides = { ...stateOverrides }

    if (addSenderBalanceOverride) {
        result[userOperation.sender] = {
            ...deepHexlify(stateOverrides?.[userOperation.sender] || {}),
            balance: toHex(parseEther("1000000"))
        }
    }

    return result
}

export class GasEstimationHandler {
    gasEstimatorV06: GasEstimatorV06
    gasEstimatorV07: GasEstimatorV07

    constructor(config: AltoConfig) {
        this.gasEstimatorV06 = new GasEstimatorV06(config)

        this.gasEstimatorV07 = new GasEstimatorV07(config)
    }

    validateHandleOp({
        userOperation,
        queuedUserOperations,
        entryPoint,
        targetAddress,
        targetCallData,
        stateOverrides = {}
    }: {
        userOperation: UserOperation
        queuedUserOperations: UserOperation[]
        entryPoint: Address
        targetAddress: Address
        targetCallData: Hex
        stateOverrides?: StateOverrides
    }): Promise<SimulateHandleOpResult> {
        const finalStateOverride = getStateOverrides({
            userOperation,
            addSenderBalanceOverride: false,
            stateOverrides
        })
        if (isVersion06(userOperation)) {
            return this.gasEstimatorV06.simulateHandleOpV06({
                userOperation,
                entryPoint,
                targetAddress,
                targetCallData,
                stateOverrides: finalStateOverride
            })
        }

        return this.gasEstimatorV07.validateHandleOpV07({
            userOperation: userOperation as UserOperationV07,
            queuedUserOperations: queuedUserOperations as UserOperationV07[],
            entryPoint,
            stateOverrides: finalStateOverride
        })
    }

    simulateHandleOp({
        userOperation,
        queuedUserOperations,
        entryPoint,
        targetAddress,
        targetCallData,
        stateOverrides = {}
    }: {
        userOperation: UserOperation
        queuedUserOperations: UserOperation[]
        entryPoint: Address
        targetAddress: Address
        targetCallData: Hex
        stateOverrides?: StateOverrides
    }): Promise<SimulateHandleOpResult> {
        const finalStateOverride = getStateOverrides({
            userOperation,
            addSenderBalanceOverride: false,
            stateOverrides
        })
        if (isVersion06(userOperation)) {
            return this.gasEstimatorV06.simulateHandleOpV06({
                userOperation,
                entryPoint,
                targetAddress,
                targetCallData,
                stateOverrides: finalStateOverride
            })
        }

        return this.gasEstimatorV07.simulateHandleOpV07({
            userOperation: userOperation as UserOperationV07,
            queuedUserOperations: queuedUserOperations as UserOperationV07[],
            entryPoint,
            stateOverrides: finalStateOverride
        })
    }
}
