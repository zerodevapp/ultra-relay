import type { AltoConfig } from "@alto/cli"
import type { UserOperation06, UserOperationBundle } from "@alto/types"
import type { Logger } from "@alto/utils"
import { describe, expect, it, vi } from "vitest"
import { filterOpsAndEstimateGas } from "./filterOpsAndEstimateGas"

vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

const logger = {
    isLevelEnabled: () => false,
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => logger
} as unknown as Logger

const USER_OP: UserOperation06 = {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    callGasLimit: 6_000_000n,
    verificationGasLimit: 350_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    paymasterAndData: "0x",
    signature: "0x"
}

const bundle: UserOperationBundle = {
    entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    version: "0.6",
    submissionAttempts: 0,
    userOps: [
        {
            userOp: USER_OP,
            userOpHash: `0x${"01".repeat(32)}`,
            addedToMempool: 1000,
            submissionAttempts: 0
        }
    ]
}

const makeConfig = () => {
    const call = vi.fn().mockRejectedValue(new Error("rpc down"))
    const config = {
        chainType: "default",
        utilityWalletAddress: "0x2222222222222222222222222222222222222222",
        pimlicoSimulationContract: "0x3333333333333333333333333333333333333333",
        codeOverrideSupport: false,
        rpcGasEstimate: false,
        publicClient: { call, chain: { id: 1 } }
    } as unknown as AltoConfig
    return { config, call }
}

describe("filterOpsAndEstimateGas", () => {
    it("bundles every op without the filterOps eth_call when skipping", async () => {
        const { config, call } = makeConfig()

        const result = await filterOpsAndEstimateGas({
            userOpBundle: bundle,
            config,
            logger,
            networkBaseFee: 1n,
            skipSimulation: true
        })

        expect(call).not.toHaveBeenCalled()
        expect(result.status).toBe("success")
        if (result.status !== "success") return
        expect(result.userOpsToBundle).toEqual(bundle.userOps)
        expect(result.rejectedUserOps).toEqual([])
        // Gas limit comes from the ops' own limits, not the simulation.
        expect(result.bundleGasLimit).toBeGreaterThan(
            USER_OP.callGasLimit + USER_OP.verificationGasLimit
        )
    })

    it("still runs the filterOps eth_call by default", async () => {
        const { config, call } = makeConfig()

        const result = await filterOpsAndEstimateGas({
            userOpBundle: bundle,
            config,
            logger,
            networkBaseFee: 1n
        })

        expect(call).toHaveBeenCalledOnce()
        expect(result.status).toBe("unhandled_error")
    })
})
