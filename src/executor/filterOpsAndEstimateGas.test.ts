import { BaseError } from "viem"
import { expect, it, vi } from "vitest"
import { filterOpsAndEstimateGas } from "./filterOpsAndEstimateGas"

for (const error of [
    new Error("execution reverted https://node.test/secret"),
    new BaseError("provider signature: secret")
]) {
    it(`classifies a ${error.constructor.name} without exposing the provider body`, async () => {
        const call = vi.fn().mockRejectedValue(error)
        const op = {
            sender: `0x${"11".repeat(20)}`,
            nonce: 0n,
            initCode: "0x",
            callData: "0x",
            callGasLimit: 100000n,
            verificationGasLimit: 100000n,
            preVerificationGas: 100000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            paymasterAndData: "0x",
            signature: "0x"
        }
        const info = {
            userOp: op,
            userOpHash: `0x${"ab".repeat(32)}`,
            addedToMempool: 0,
            submissionAttempts: 0
        }
        const logger = {
            error: vi.fn(),
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn()
        }
        const result = await filterOpsAndEstimateGas({
            userOpBundle: {
                userOps: [info],
                entryPoint: `0x${"22".repeat(20)}`,
                version: "0.6",
                submissionAttempts: 0
            },
            config: {
                publicClient: { call },
                chainType: "default",
                utilityWalletAddress: `0x${"33".repeat(20)}`,
                pimlicoSimulationContract: `0x${"44".repeat(20)}`
            },
            logger,
            networkBaseFee: 1n
        } as any)
        expect(call).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({
            status: "unhandled_error",
            retryable: true,
            rejectedUserOps: [{ reason: "Unclassified infrastructure failure" }]
        })
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret")
    })
}
