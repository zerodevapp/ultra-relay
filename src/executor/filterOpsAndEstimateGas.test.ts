import type { UserOpInfo, UserOperationBundle } from "@alto/types"
import pino from "pino"
import {
    type Address,
    type Hex,
    encodeAbiParameters,
    encodeErrorResult
} from "viem"
import { entryPoint07Abi } from "viem/account-abstraction"
import { describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../createConfig"
import { filterOpsAndEstimateGas } from "./filterOpsAndEstimateGas"
import { getEthCallSender } from "./senderManager"

const EXECUTOR = "0x1111111111111111111111111111111111111111" as Address
const OTHER_EXECUTOR = "0x2222222222222222222222222222222222222222" as Address
const ENTRYPOINT = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address
const SIMULATION = "0x3333333333333333333333333333333333333333" as Address
const UTILITY = "0x4444444444444444444444444444444444444444" as Address
const USER_OP_HASH = `0x${"ab".repeat(32)}` as Hex

const userOpInfo = {
    userOpHash: USER_OP_HASH,
    userOp: {
        sender: "0x5555555555555555555555555555555555555555",
        nonce: 0n,
        initCode: "0x",
        callData: "0x",
        callGasLimit: 100_000n,
        verificationGasLimit: 100_000n,
        preVerificationGas: 50_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        paymasterAndData: "0x",
        signature: "0x"
    }
} as unknown as UserOpInfo

const bundle: UserOperationBundle = {
    entryPoint: ENTRYPOINT,
    version: "0.6",
    userOps: [userOpInfo],
    submissionAttempts: 0
}

const encodeResult = (rejected: { userOpHash: Hex; revertReason: Hex }[]) =>
    encodeAbiParameters(
        [
            {
                name: "result",
                type: "tuple",
                components: [
                    { name: "gasUsed", type: "uint256" },
                    { name: "balanceChange", type: "uint256" },
                    {
                        name: "rejectedUserOps",
                        type: "tuple[]",
                        components: [
                            { name: "userOpHash", type: "bytes32" },
                            { name: "revertReason", type: "bytes" }
                        ]
                    }
                ]
            }
        ],
        [{ gasUsed: 200_000n, balanceChange: 1n, rejectedUserOps: rejected }]
    )

const makeConfig = (call: (args: { account?: Address }) => unknown) =>
    ({
        executorPrivateKeys: [
            { address: EXECUTOR },
            { address: OTHER_EXECUTOR }
        ],
        pimlicoSimulationContract: SIMULATION,
        utilityWalletAddress: UTILITY,
        fixedGasLimitForEstimation: 10_000_000n,
        codeOverrideSupport: false,
        chainType: "default",
        rpcGasEstimate: false,
        publicClient: { call: vi.fn(call) }
    }) as unknown as AltoConfig

const run = (config: AltoConfig) =>
    filterOpsAndEstimateGas({
        userOpBundle: bundle,
        config,
        logger: pino({ level: "silent" }),
        networkBaseFee: 1n
    })

describe("filterOpsAndEstimateGas simulation sender", () => {
    it("simulates from the first executor key", async () => {
        const config = makeConfig(async () => ({ data: encodeResult([]) }))

        await run(config)

        expect(config.publicClient.call).toHaveBeenCalledWith(
            expect.objectContaining({ account: EXECUTOR })
        )
    })

    it("rejects a userOp that fails only when tx.origin is the executor, before any send", async () => {
        const revertReason = encodeErrorResult({
            abi: entryPoint07Abi,
            errorName: "FailedOpWithRevert",
            args: [0n, "AA33 reverted", "0x"]
        })
        const config = makeConfig(async (args) => ({
            data: encodeResult(
                args.account === EXECUTOR
                    ? [{ userOpHash: USER_OP_HASH, revertReason }]
                    : []
            )
        }))

        const result = await run(config)

        expect(result.status).toBe("all_ops_rejected")
        expect(result.rejectedUserOps[0].userOpHash).toBe(USER_OP_HASH)
        expect(result.rejectedUserOps[0].reason).toContain("AA33")
    })

    it("returns undefined sender when no executor keys are configured", () => {
        const config = { executorPrivateKeys: [] } as unknown as AltoConfig

        expect(getEthCallSender({ config })).toBeUndefined()
    })
})
