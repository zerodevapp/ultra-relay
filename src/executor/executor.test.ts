import { type Server, createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { AltoConfig } from "@alto/cli"
import type { EventManager } from "@alto/handlers"
import type { Logger } from "@alto/utils"
import { createPublicClient, createWalletClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { customTransport } from "../cli/customTransport"
import { Executor } from "./executor"

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
