import type { GasPriceManager } from "@alto/handlers"
import { type UserOperation07, pimlicoSimulationsAbi } from "@alto/types"
import {
    type Hex,
    createPublicClient,
    custom,
    decodeFunctionData,
    encodeErrorResult,
    encodeFunctionResult,
    parseAbi
} from "viem"
import { entryPoint07Address } from "viem/account-abstraction"
import { type Mock, describe, expect, test, vi } from "vitest"
import type { AltoConfig } from "../../createConfig"
import { GasEstimator07 } from "./gasEstimations07"
import { BinarySearchResultType } from "./types"

// Importing GasEstimator07 reaches utils/logger, which builds a Logtail
// transport at module load when BETTER_STACK_TOKEN is set.
vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

type SilentLogger = {
    trace: Mock
    debug: Mock
    info: Mock
    warn: Mock
    error: Mock
    fatal: Mock
    child: () => SilentLogger
}

const silentLogger: SilentLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => silentLogger
}

const TRANSFER_FROM_FAILED = encodeErrorResult({
    abi: parseAbi(["error Error(string)"]),
    errorName: "Error",
    args: ["TRANSFER_FROM_FAILED"]
})

const userOp07: UserOperation07 = {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: 0n,
    factory: null,
    factoryData: null,
    callData: "0xdeadbeef",
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature: "0x"
}

// One binary-search result as the simulation contract returns it.
const bsResult = ({
    gasUsed,
    success,
    returnData
}: {
    gasUsed: bigint
    success: boolean
    returnData: Hex
}) => ({
    resultType: BinarySearchResultType.Success,
    successData: { gasUsed, success, returnData },
    outOfGasData: { optimalGas: 0n, minGas: 0n, maxGas: 0n }
})

const simulationResult = {
    preOpGas: 100_000n,
    paid: 200_000n,
    accountValidationData: 0n,
    paymasterValidationData: 0n,
    paymasterVerificationGasLimit: 0n,
    paymasterPostOpGasLimit: 0n,
    targetSuccess: true,
    targetResult: "0x" as Hex
}

const verificationGasSearch = bsResult({
    gasUsed: 50_000n,
    success: true,
    returnData: "0x"
})

const paymasterVerificationGasSearch = bsResult({
    gasUsed: 0n,
    success: false,
    returnData: "0x"
})

// Keyed by simulation-contract function name. The split-mode entries are
// unused when splitSimulationCalls is false, and vice versa.
const defaultResponses: Record<string, unknown> = {
    simulateAndEstimateGas: {
        simulationResult,
        verificationGasLimit: verificationGasSearch,
        paymasterVerificationGasLimit: paymasterVerificationGasSearch
    },
    simulateHandleOp: simulationResult,
    binarySearchVerificationGas: verificationGasSearch,
    binarySearchPaymasterVerificationGas: paymasterVerificationGasSearch
}

// Answers each eth_call by decoding which simulation-contract function was
// called and ABI-encoding the canned response for it.
const makeEstimator = ({
    responses,
    splitSimulationCalls
}: {
    responses: Partial<Record<string, unknown>>
    splitSimulationCalls: boolean
}): GasEstimator07 => {
    const allResponses = { ...defaultResponses, ...responses }

    const publicClient = createPublicClient({
        transport: custom({
            request: ({ method, params }) => {
                if (method !== "eth_call") {
                    throw new Error(`Unexpected RPC method ${method}`)
                }
                const [{ data }] = params as [{ data: Hex }]
                const { functionName } = decodeFunctionData({
                    abi: pimlicoSimulationsAbi,
                    data
                })
                if (!(functionName in allResponses)) {
                    throw new Error(`No fake response for ${functionName}`)
                }
                return Promise.resolve(
                    encodeFunctionResult({
                        abi: pimlicoSimulationsAbi,
                        functionName,
                        result: allResponses[functionName]
                    } as unknown as Parameters<typeof encodeFunctionResult>[0])
                )
            }
        })
    })

    const config = {
        getLogger: () => silentLogger,
        logLevel: "silent",
        publicClient,
        pimlicoSimulationContract: "0x4bf0F8aa0456Fdd98aebd56825a6b5A5397495d9",
        entrypointSimulationContractV7:
            "0x5069F06D5728aA9bDAD69C42AbfD8C1D62f8A6E9",
        binarySearchToleranceDelta: 10_000n,
        binarySearchGasAllowance: 30_000_000n,
        binarySearchMaxRetries: 3,
        fixedGasLimitForEstimation: undefined,
        splitSimulationCalls,
        codeOverrideSupport: false,
        balanceOverride: false
    } as unknown as AltoConfig

    return new GasEstimator07(config, {} as unknown as GasPriceManager)
}

describe("GasEstimator07.simulateHandleOp07 call-gas revert flag", () => {
    test.each([false, true])(
        "returns failed -32521 with the revert bytes when only the call-gas search sees a revert (split=%s)",
        async (splitSimulationCalls) => {
            const estimator = makeEstimator({
                responses: {
                    binarySearchCallGas: bsResult({
                        gasUsed: 0n,
                        success: false,
                        returnData: TRANSFER_FROM_FAILED
                    })
                },
                splitSimulationCalls
            })

            const result = await estimator.simulateHandleOp07({
                entryPoint: entryPoint07Address,
                userOp: userOp07,
                queuedUserOps: [],
                userStateOverrides: {}
            })

            expect(result).toEqual({
                result: "failed",
                data: TRANSFER_FROM_FAILED,
                code: -32521
            })
        }
    )

    test.each([false, true])(
        "returns failed with data 0x when the call reverts with empty revert bytes (split=%s)",
        async (splitSimulationCalls) => {
            const estimator = makeEstimator({
                responses: {
                    binarySearchCallGas: bsResult({
                        gasUsed: 0n,
                        success: false,
                        returnData: "0x"
                    })
                },
                splitSimulationCalls
            })

            const result = await estimator.simulateHandleOp07({
                entryPoint: entryPoint07Address,
                userOp: userOp07,
                queuedUserOps: [],
                userStateOverrides: {}
            })

            expect(result).toEqual({
                result: "failed",
                data: "0x",
                code: -32521
            })
        }
    )

    test("keeps the searched callGasLimit when the call succeeds", async () => {
        const estimator = makeEstimator({
            responses: {
                binarySearchCallGas: bsResult({
                    gasUsed: 126_186n,
                    success: true,
                    returnData: "0x"
                })
            },
            splitSimulationCalls: false
        })

        const result = await estimator.simulateHandleOp07({
            entryPoint: entryPoint07Address,
            userOp: userOp07,
            queuedUserOps: [],
            userStateOverrides: {}
        })

        expect(result.result).toBe("execution")
        expect(result.result === "execution" && result.data.callGasLimit).toBe(
            126_186n
        )
    })

    test.each([false, true])(
        "empty callData: success=false is not an error and callGasLimit is 0 (split=%s)",
        async (splitSimulationCalls) => {
            const estimator = makeEstimator({
                responses: {
                    binarySearchCallGas: bsResult({
                        gasUsed: 0n,
                        success: false,
                        returnData: "0x"
                    })
                },
                splitSimulationCalls
            })

            const result = await estimator.simulateHandleOp07({
                entryPoint: entryPoint07Address,
                userOp: { ...userOp07, callData: "0x" },
                queuedUserOps: [],
                userStateOverrides: {}
            })

            expect(result.result).toBe("execution")
            expect(
                result.result === "execution" && result.data.callGasLimit
            ).toBe(0n)
        }
    )
})

// A verification search that runs out of gas in simulateAndEstimateGas is
// retried as its own binarySearchVerificationGas eth_call.
const verificationOutOfGas = {
    resultType: BinarySearchResultType.OutOfGas,
    successData: { gasUsed: 0n, success: false, returnData: "0x" as Hex },
    outOfGasData: {
        optimalGas: 1_000_000n,
        minGas: 50_000n,
        maxGas: 2_000_000n
    }
}

const callGasSearch = bsResult({
    gasUsed: 126_186n,
    success: true,
    returnData: "0x"
})

describe("GasEstimator07 verification search revert flag", () => {
    test("split mode: verification search revert returns failed -32521", async () => {
        const estimator = makeEstimator({
            responses: {
                binarySearchVerificationGas: bsResult({
                    gasUsed: 0n,
                    success: false,
                    returnData: TRANSFER_FROM_FAILED
                }),
                binarySearchCallGas: callGasSearch
            },
            splitSimulationCalls: true
        })

        const result = await estimator.simulateHandleOp07({
            entryPoint: entryPoint07Address,
            userOp: userOp07,
            queuedUserOps: [],
            userStateOverrides: {}
        })

        expect(result).toEqual({
            result: "failed",
            data: TRANSFER_FROM_FAILED,
            code: -32521
        })
    })

    test("non-split OutOfGas retry: verification search revert returns failed -32521", async () => {
        const estimator = makeEstimator({
            responses: {
                simulateAndEstimateGas: {
                    simulationResult,
                    verificationGasLimit: verificationOutOfGas,
                    paymasterVerificationGasLimit:
                        paymasterVerificationGasSearch
                },
                binarySearchVerificationGas: bsResult({
                    gasUsed: 0n,
                    success: false,
                    returnData: TRANSFER_FROM_FAILED
                }),
                binarySearchCallGas: callGasSearch
            },
            splitSimulationCalls: false
        })

        const result = await estimator.simulateHandleOp07({
            entryPoint: entryPoint07Address,
            userOp: userOp07,
            queuedUserOps: [],
            userStateOverrides: {}
        })

        expect(result).toEqual({
            result: "failed",
            data: TRANSFER_FROM_FAILED,
            code: -32521
        })
    })

    test("non-split OutOfGas retry that succeeds keeps the retried verification gas", async () => {
        const estimator = makeEstimator({
            responses: {
                simulateAndEstimateGas: {
                    simulationResult,
                    verificationGasLimit: verificationOutOfGas,
                    paymasterVerificationGasLimit:
                        paymasterVerificationGasSearch
                },
                binarySearchVerificationGas: bsResult({
                    gasUsed: 1_200_000n,
                    success: true,
                    returnData: "0x"
                }),
                binarySearchCallGas: callGasSearch
            },
            splitSimulationCalls: false
        })

        const result = await estimator.simulateHandleOp07({
            entryPoint: entryPoint07Address,
            userOp: userOp07,
            queuedUserOps: [],
            userStateOverrides: {}
        })

        expect(result.result).toBe("execution")
        expect(
            result.result === "execution" && result.data.verificationGasLimit
        ).toBe(1_200_000n)
    })

    test.each([false, true])(
        "split mode: paymaster search success=false is not an error (paymaster present=%s)",
        async (withPaymaster) => {
            const userOp: UserOperation07 = withPaymaster
                ? {
                      ...userOp07,
                      paymaster: "0x1111111111111111111111111111111111111111",
                      paymasterVerificationGasLimit: 0n,
                      paymasterPostOpGasLimit: 0n,
                      paymasterData: "0x"
                  }
                : userOp07
            const estimator = makeEstimator({
                responses: {
                    binarySearchPaymasterVerificationGas: bsResult({
                        gasUsed: 0n,
                        success: false,
                        returnData: "0x"
                    }),
                    binarySearchCallGas: callGasSearch
                },
                splitSimulationCalls: true
            })

            const result = await estimator.simulateHandleOp07({
                entryPoint: entryPoint07Address,
                userOp,
                queuedUserOps: [],
                userStateOverrides: {}
            })

            expect(result.result).toBe("execution")
        }
    )
})
