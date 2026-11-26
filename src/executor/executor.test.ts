import { type Server, createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { AltoConfig } from "@alto/cli"
import type { EventManager } from "@alto/handlers"
import type { Logger } from "@alto/utils"
import {
    ContractFunctionExecutionError,
    HttpRequestError,
    InsufficientFundsError,
    LimitExceededRpcError,
    RpcRequestError,
    TimeoutError,
    TransactionExecutionError,
    UnknownRpcError,
    createPublicClient,
    createWalletClient
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from "vitest"
import { customTransport } from "../cli/customTransport"
import { Executor } from "./executor"
import { filterOpsAndEstimateGas } from "./filterOpsAndEstimateGas"

vi.mock("./filterOpsAndEstimateGas", () => ({
    filterOpsAndEstimateGas: vi.fn()
}))

vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

describe("Executor.sendHandleOpsTransaction", () => {
    let server: Server
    let baseUrl: string
    const methods: string[] = []

    beforeAll(async () => {
        server = createServer((req, res) => {
            let raw = ""
            req.on("data", (chunk) => {
                raw += chunk
            })
            req.on("end", () => {
                const { id, method } = JSON.parse(raw)
                methods.push(method)
                const result =
                    method === "eth_sendRawTransaction"
                        ? `0x${"ab".repeat(32)}`
                        : undefined
                res.writeHead(200, { "content-type": "application/json" })
                res.end(
                    JSON.stringify(
                        result
                            ? { jsonrpc: "2.0", id, result }
                            : {
                                  jsonrpc: "2.0",
                                  id,
                                  error: { code: -32601, message: "no" }
                              }
                    )
                )
            })
        })
        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve)
        })
        const { port } = server.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve())
        })
    })

    it("sends a fully prepared bundle with only eth_sendRawTransaction", async () => {
        const logger = {
            isLevelEnabled: () => false,
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            child: () => logger
        } as unknown as Logger
        const transport = customTransport(baseUrl, { logger, retryCount: 0 })
        const publicClient = createPublicClient({ chain: foundry, transport })
        const walletClient = createWalletClient({ chain: foundry, transport })
        const account = privateKeyToAccount(
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        )

        const executor = new Executor({
            config: {
                getLogger: () => logger,
                executorGasMultiplier: 100n,
                gasLimitRoundingMultiple: 1n,
                sendHandleOpsRetryCount: 1,
                transactionUnderpricedMultiplier: 150n,
                privateEndpointSubmissionAttempts: 0,
                walletClients: { public: walletClient },
                publicClient
            } as unknown as AltoConfig,
            eventManager: {} as EventManager
        })

        await executor.sendHandleOpsTransaction({
            txParam: {
                account,
                entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
                gas: 500_000n,
                nonce: 0,
                userOps: [
                    {
                        userOp: {
                            sender: "0x1111111111111111111111111111111111111111",
                            nonce: 0n,
                            initCode: "0x",
                            callData: "0x",
                            callGasLimit: 100_000n,
                            verificationGasLimit: 100_000n,
                            preVerificationGas: 100_000n,
                            maxPriorityFeePerGas: 1n,
                            maxFeePerGas: 1n,
                            paymasterAndData: "0x",
                            signature: "0x"
                        },
                        userOpHash: `0x${"11".repeat(32)}`,
                        addedToMempool: Date.now(),
                        submissionAttempts: 0
                    }
                ]
            },
            gasOpts: {
                type: "eip1559",
                maxFeePerGas: 2n,
                maxPriorityFeePerGas: 1n
            },
            childLogger: logger,
            submissionAttempts: 0
        })

        expect(methods).toEqual(["eth_sendRawTransaction"])
    })
})

const getBundleGasPrice = Executor.prototype.getBundleGasPrice

const call = (submissionAttempts: number, arbitrumPriorityFeePerGas = 0n) =>
    getBundleGasPrice.call(
        {
            config: {
                chainType: "arbitrum",
                arbitrumGasBidMultiplier: 5n,
                arbitrumPriorityFeePerGas,
                bundlerInitialCommission: 0n,
                resubmitMultiplierCeiling: 0n,
                legacyTransactions: false
            }
        } as unknown as Executor,
        {
            bundle: { submissionAttempts } as never,
            networkGasPrice: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
            networkBaseFee: 20_000_000n, // 0.02 gwei
            totalBeneficiaryFees: 0n,
            bundleGasUsed: 0n
        }
    )

describe("getBundleGasPrice on arbitrum", () => {
    it.each([0n, 1n, 30_000_000n, 200_000_000n])(
        "does not depend on a network quote for configured tip %s",
        (arbitrumPriorityFeePerGas) => {
            const config = {
                chainType: "arbitrum",
                arbitrumGasBidMultiplier: 5n,
                arbitrumPriorityFeePerGas
            }
            for (const submissionAttempts of [0, 1, 7]) {
                const input = {
                    bundle: { submissionAttempts } as never,
                    networkBaseFee: 20_000_000n,
                    totalBeneficiaryFees: 0n,
                    bundleGasUsed: 1n
                }
                const context = { config } as unknown as Executor
                const quoted = getBundleGasPrice.call(context, {
                    ...input,
                    networkGasPrice: {
                        maxFeePerGas: 999_000_000n,
                        maxPriorityFeePerGas: 111_000_000n
                    }
                })
                expect(
                    getBundleGasPrice.call(context, {
                        ...input,
                        networkGasPrice: undefined
                    })
                ).toEqual(quoted)
            }
        }
    )

    it("rejects a missing network quote outside Arbitrum", () => {
        expect(() =>
            getBundleGasPrice.call(
                { config: { chainType: "default" } } as unknown as Executor,
                {
                    bundle: { submissionAttempts: 0 } as never,
                    networkGasPrice: undefined,
                    networkBaseFee: 20_000_000n,
                    totalBeneficiaryFees: 0n,
                    bundleGasUsed: 1n
                }
            )
        ).toThrow("Network gas price is required outside Arbitrum")
    })

    it("bids no priority fee so the bundle pays baseFee", () => {
        expect(call(0)).toEqual({
            maxFeePerGas: 100_000_000n,
            maxPriorityFeePerGas: 0n
        })
    })

    it("raises only maxFee on resubmission", () => {
        expect(call(1)).toEqual({
            maxFeePerGas: 120_000_000n,
            maxPriorityFeePerGas: 0n
        })
    })

    it("bids the configured priority fee", () => {
        expect(call(0, 10_000_000n)).toEqual({
            maxFeePerGas: 100_000_000n,
            maxPriorityFeePerGas: 10_000_000n
        })
    })

    it("scales a configured priority fee on resubmission", () => {
        expect(call(1, 10_000_000n)).toEqual({
            maxFeePerGas: 120_000_000n,
            maxPriorityFeePerGas: 12_000_000n
        })
    })

    it("keeps maxFee above baseFee plus a large configured tip", () => {
        expect(call(0, 200_000_000n)).toEqual({
            maxFeePerGas: 220_000_000n,
            maxPriorityFeePerGas: 200_000_000n
        })
    })
})

describe("Executor.bundle send failure classification", () => {
    const logger = {
        isLevelEnabled: () => false,
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => logger
    } as unknown as Logger
    const userOpInfo = {
        userOp: { sender: "0x1111111111111111111111111111111111111111" },
        userOpHash: `0x${"11".repeat(32)}`,
        addedToMempool: 0,
        submissionAttempts: 0
    }
    const userOpsToBundle = [userOpInfo, { ...userOpInfo, userOpHash: "0x22" }]
    const account = privateKeyToAccount(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    )
    const executionError = (cause: Error) =>
        new TransactionExecutionError(
            cause as never,
            {
                account,
                chain: foundry
            } as never
        )

    const run = async (sendError: unknown) => {
        const executor = new Executor({
            config: {
                getLogger: () => logger,
                chainType: "default",
                legacyTransactions: false,
                bundlerInitialCommission: 0n,
                resubmitMultiplierCeiling: 0n
            } as unknown as AltoConfig,
            eventManager: {} as EventManager
        })
        vi.spyOn(executor, "sendHandleOpsTransaction").mockRejectedValue(
            sendError
        )
        return executor.bundle({
            executor: account,
            userOpBundle: {
                entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
                version: "0.6",
                userOps: userOpsToBundle,
                submissionAttempts: 0
            } as never,
            networkGasPrice: { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n },
            networkBaseFee: 1n,
            nonce: 0
        })
    }

    beforeEach(() => {
        vi.mocked(filterOpsAndEstimateGas).mockResolvedValue({
            status: "success",
            userOpsToBundle,
            rejectedUserOps: [],
            bundleGasUsed: 1n,
            bundleGasLimit: 1n,
            totalBeneficiaryFees: 0n
        } as never)
    })

    const http503 = () =>
        new HttpRequestError({ url: "http://node", status: 503 })
    const http413 = () =>
        new HttpRequestError({ url: "http://node", status: 413 })
    const timeout = () => new TimeoutError({ url: "http://node", body: {} })
    const httpStatus = (status: number) => () =>
        new HttpRequestError({ url: "http://node", status })
    // How viem surfaces a JSON-RPC error body: the RpcRequestError keeps the
    // provider's code, wrapped in a typed error (LimitExceededRpcError for
    // -32005, UnknownRpcError for codes it has no class for).
    const rpcError = (code: number) =>
        new RpcRequestError({
            body: {},
            error: { code, message: "provider error" },
            url: "http://node"
        })

    it.each([
        ["a bare HttpRequestError 429", httpStatus(429)],
        [
            "an execution error wrapping HttpRequestError 429",
            () => executionError(httpStatus(429)())
        ],
        ["a bare HttpRequestError 408", httpStatus(408)],
        [
            "an execution error wrapping JSON-RPC code 429",
            () => executionError(new UnknownRpcError(rpcError(429)))
        ],
        [
            "an execution error wrapping LimitExceededRpcError (-32005)",
            () => executionError(new LimitExceededRpcError(rpcError(-32005)))
        ],
        [
            "an execution error wrapping JSON-RPC code -32007",
            () => executionError(new UnknownRpcError(rpcError(-32007)))
        ]
    ])("returns send_transport_error for a rate limit: %s", async (_, make) => {
        expect(await run(make())).toMatchObject({
            success: false,
            reason: "send_transport_error",
            recoverableOps: userOpsToBundle
        })
    })

    it("keeps generic_error for a JSON-RPC rejection that is not a rate limit", async () => {
        expect(
            await run(executionError(new UnknownRpcError(rpcError(-32000))))
        ).toMatchObject({ reason: "generic_error" })
    })

    it.each([
        [
            "an execution error wrapping HttpRequestError 503",
            () => executionError(http503())
        ],
        [
            "an execution error wrapping TimeoutError",
            () => executionError(timeout())
        ],
        ["a bare HttpRequestError", http503],
        ["a bare TimeoutError", timeout],
        [
            "an HttpRequestError with no status",
            () => new HttpRequestError({ url: "http://node" })
        ]
    ])("returns send_transport_error for %s", async (_, make) => {
        expect(await run(make())).toMatchObject({
            success: false,
            reason: "send_transport_error",
            recoverableOps: userOpsToBundle
        })
    })

    it("keeps generic_error for a contract execution revert", async () => {
        const err = new ContractFunctionExecutionError(
            new Error("execution reverted") as never,
            { abi: [], functionName: "handleOps" } as never
        )
        expect(await run(err)).toMatchObject({ reason: "generic_error" })
    })

    it.each([
        ["a bare HttpRequestError 413", () => http413()],
        [
            "an execution error wrapping HttpRequestError 413",
            () => executionError(http413())
        ]
    ])("keeps generic_error for %s", async (_, make) => {
        expect(await run(make())).toMatchObject({ reason: "generic_error" })
    })

    it("keeps generic_error for an unknown non-viem error", async () => {
        expect(await run(new Error("boom"))).toMatchObject({
            reason: "generic_error"
        })
    })

    it("keeps oversized_bundle for an oversize rejection", async () => {
        expect(
            await run(executionError(new Error("oversized data")))
        ).toMatchObject({ reason: "oversized_bundle" })
    })

    it("keeps insufficient_funds for InsufficientFundsError", async () => {
        expect(
            await run(
                executionError(
                    new InsufficientFundsError({ cause: new Error("x") })
                )
            )
        ).toMatchObject({ reason: "insufficient_funds" })
    })
})
