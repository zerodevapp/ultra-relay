import {
    http,
    type Address,
    type Hex,
    createClient,
    createPublicClient,
    parseEventLogs,
    rpcSchema,
    zeroAddress
} from "viem"
import {
    type EntryPointVersion,
    type RpcUserOperation,
    type UserOperation,
    type UserOperationReceipt,
    entryPoint07Abi,
    formatUserOperationRequest
} from "viem/account-abstraction"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { beforeEach, describe, expect, inject, test } from "vitest"
import { getEntryPointAddress } from "../src/utils/entrypoint.js"
import {
    beforeEachCleanUp,
    getAnvilWalletClient,
    getSimple7702AccountImplementationAddress,
    getSmartAccountClient,
    sendBundleNow,
    setBundlingMode
} from "../src/utils/index.js"

type SubmissionMethod = "boost_sendUserOperation" | "eth_sendUserOperation"
type SubmissionSchema = [
    {
        Method: SubmissionMethod
        Parameters: [RpcUserOperation, Address]
        ReturnType: Hex
    }
]

// Deployment code for a counter that increments storage slot zero on each call.
const COUNTER_BYTECODE: Hex = "0x600a600c600039600a6000f360005460010160005500"
const REQUIRE_PVG_ENFORCEMENT = process.env.E2E_REQUIRE_PVG_ENFORCEMENT === "1"

describe.each(["0.6", "0.7", "0.8"] as const)(
    "boosted accounting EntryPoint %s",
    (entryPointVersion: EntryPointVersion) => {
        const anvilRpc = inject("anvilRpc")
        const altoRpc = inject("altoRpc")
        const entryPoint = getEntryPointAddress(entryPointVersion)
        const publicClient = createPublicClient({
            transport: http(anvilRpc),
            chain: foundry,
            pollingInterval: 100
        })
        let counter: Address

        beforeEach(async () => {
            await beforeEachCleanUp({ anvilRpc, altoRpc })
            const wallet = getAnvilWalletClient({ addressIndex: 0, anvilRpc })
            const hash = await wallet.sendTransaction({
                data: COUNTER_BYTECODE
            })
            const receipt = await publicClient.waitForTransactionReceipt({
                hash
            })
            expect(receipt.status).toBe("success")
            if (!receipt.contractAddress) {
                throw new Error("Counter not deployed")
            }
            counter = receipt.contractAddress
        })

        async function makeAccount(use7702: boolean) {
            const privateKey = generatePrivateKey()
            const client = await getSmartAccountClient({
                entryPointVersion,
                anvilRpc,
                altoRpc,
                use7702,
                fundAccount: false,
                privateKey
            })
            const authorization = use7702
                ? await privateKeyToAccount(privateKey).signAuthorization({
                      chainId: foundry.id,
                      nonce: 0,
                      contractAddress:
                          getSimple7702AccountImplementationAddress(
                              entryPointVersion
                          )
                  })
                : undefined
            return { client, authorization }
        }

        async function assertUnfunded(sender: Address) {
            expect(await publicClient.getBalance({ address: sender })).toBe(0n)
            expect(
                await publicClient.readContract({
                    address: entryPoint,
                    abi: entryPoint07Abi,
                    functionName: "balanceOf",
                    args: [sender]
                })
            ).toBe(0n)
        }

        async function prepare(
            { client, authorization }: Awaited<ReturnType<typeof makeAccount>>,
            data: Hex = "0x"
        ) {
            await assertUnfunded(client.account.address)
            // The helper chooses the account version at runtime; narrow the
            // SDK's cross-version preparation union to its userOperation type.
            const userOp = (await client.prepareUserOperation({
                calls: [{ to: counter, data, value: 0n }],
                maxFeePerGas: 0n,
                maxPriorityFeePerGas: 0n,
                ...(authorization ? { authorization } : {})
            })) as UserOperation
            expect(userOp.preVerificationGas).toBeGreaterThan(0n)
            expect(userOp.verificationGasLimit).toBeGreaterThan(0n)
            expect(userOp.callGasLimit).toBeGreaterThan(0n)
            userOp.signature = await client.account.signUserOperation(userOp)
            return userOp
        }

        function submit(
            userOp: UserOperation,
            method: SubmissionMethod,
            apiVersion = "v1"
        ) {
            const submitClient = createClient({
                transport: http(`${altoRpc}/${apiVersion}/rpc`),
                rpcSchema: rpcSchema<SubmissionSchema>()
            })
            const request = formatUserOperationRequest(userOp)
            expect(BigInt(request.maxFeePerGas)).toBe(0n)
            expect(BigInt(request.maxPriorityFeePerGas)).toBe(0n)
            expect(
                "paymaster" in request ? request.paymaster : undefined
            ).toBeUndefined()
            expect(
                "paymasterAndData" in request ? request.paymasterAndData : "0x"
            ).toBe("0x")
            return submitClient.request({
                method,
                params: [request, entryPoint]
            })
        }

        async function assertReceipts(
            receipts: UserOperationReceipt[],
            requireCoverage = true
        ) {
            const hash = receipts[0].receipt.transactionHash
            expect(
                new Set(receipts.map((r) => r.receipt.transactionHash)).size
            ).toBe(1)
            const transaction = await publicClient.getTransactionReceipt({
                hash
            })
            expect(transaction.status).toBe("success")
            expect(transaction.effectiveGasPrice).toBeGreaterThan(0n)
            const events = parseEventLogs({
                abi: entryPoint07Abi,
                eventName: "UserOperationEvent",
                logs: transaction.logs.filter(
                    (log) =>
                        log.address.toLowerCase() === entryPoint.toLowerCase()
                )
            })
            expect(events).toHaveLength(receipts.length)
            for (const receipt of receipts) {
                const event = events.find(
                    (event) => event.args.userOpHash === receipt.userOpHash
                )
                expect(event).toBeDefined()
                expect(receipt.success).toBe(true)
                expect(receipt.actualGasCost).toBe(0n)
                expect(receipt.actualGasUsed).toBe(event?.args.actualGasUsed)
                expect(receipt.actualGasCost).toBe(event?.args.actualGasCost)
                expect(event?.args.paymaster).toBe(zeroAddress)
                expect(receipt.receipt.gasUsed).toBe(transaction.gasUsed)
                expect(receipt.receipt.effectiveGasPrice).toBe(
                    transaction.effectiveGasPrice
                )
                expect(receipt.receipt.blockHash).toBe(transaction.blockHash)
                await assertUnfunded(receipt.sender)
            }
            // Anvil has no additional rollup fees. Count the transaction once,
            // not once per nested receipt. This is a gas-coverage check, not an
            // assertion that EntryPoint accounting equals measured tx gas.
            const reportedGas = receipts.reduce(
                (sum, receipt) => sum + receipt.actualGasUsed,
                0n
            )
            const measuredCost =
                transaction.gasUsed * transaction.effectiveGasPrice
            const reportedCost = reportedGas * transaction.effectiveGasPrice
            if (requireCoverage) {
                expect(reportedCost).toBeGreaterThanOrEqual(measuredCost)
            }
            return { measuredCost, reportedCost }
        }

        for (const use7702 of [false, true]) {
            for (const method of [
                "boost_sendUserOperation",
                "eth_sendUserOperation"
            ] as const) {
                test(`${method}: unfunded ${use7702 ? "7702" : "4337"} execution and receipt fidelity`, async () => {
                    const account = await makeAccount(use7702)
                    const userOp = await prepare(account)
                    const hash = await submit(userOp, method)
                    const receipt =
                        await account.client.waitForUserOperationReceipt({
                            hash
                        })
                    await assertReceipts([receipt])
                    expect(
                        BigInt(
                            (await publicClient.getStorageAt({
                                address: counter,
                                slot: "0x0"
                            })) ?? "0x0"
                        )
                    ).toBe(1n)
                    if (use7702) {
                        const implementation =
                            getSimple7702AccountImplementationAddress(
                                entryPointVersion
                            )
                        expect(
                            (
                                await publicClient.getCode({
                                    address: account.client.account.address
                                })
                            )?.toLowerCase()
                        ).toBe(
                            `0xef0100${implementation.slice(2)}`.toLowerCase()
                        )
                        const next = await prepare({
                            ...account,
                            authorization: undefined
                        })
                        const nextHash = await submit(next, method)
                        await assertReceipts([
                            await account.client.waitForUserOperationReceipt({
                                hash: nextHash
                            })
                        ])
                        expect(
                            BigInt(
                                (await publicClient.getStorageAt({
                                    address: counter,
                                    slot: "0x0"
                                })) ?? "0x0"
                            )
                        ).toBe(2n)
                    }
                })

                test.each(["v1", "v2"])(
                    `${method}: ${REQUIRE_PVG_ENFORCEMENT ? "strict PVG rejection" : "zero PVG exposes overhead shortfall"} for ${use7702 ? "7702" : "4337"} (%s)`,
                    async (apiVersion) => {
                        const account = await makeAccount(use7702)
                        const userOp = await prepare(account)
                        userOp.preVerificationGas = 0n
                        userOp.signature =
                            await account.client.account.signUserOperation(
                                userOp
                            )
                        if (REQUIRE_PVG_ENFORCEMENT) {
                            await expect(
                                submit(userOp, method, apiVersion)
                            ).rejects.toThrow(
                                "preVerificationGas is not enough"
                            )
                            return
                        }
                        // Characterize the current compatibility behavior.
                        // The strict command above is the future admission gate;
                        // a passing characterization does not certify coverage.
                        const hash = await submit(userOp, method, apiVersion)
                        const receipt =
                            await account.client.waitForUserOperationReceipt({
                                hash
                            })
                        const { reportedCost, measuredCost } =
                            await assertReceipts([receipt], false)
                        expect(reportedCost).toBeLessThan(measuredCost)
                    }
                )
            }
        }

        test("mixed boosted bundle reconciles shared transaction once", async () => {
            const accounts = await Promise.all([
                makeAccount(false),
                makeAccount(true)
            ])
            const userOps = await Promise.all(
                accounts.map((account) => prepare(account))
            )
            await setBundlingMode({ altoRpc, mode: "manual" })
            const hashes = await Promise.all(
                userOps.map((userOp) =>
                    submit(userOp, "boost_sendUserOperation")
                )
            )
            await sendBundleNow({ altoRpc })
            const receipts = await Promise.all(
                accounts.map((account, index) =>
                    account.client.waitForUserOperationReceipt({
                        hash: hashes[index]
                    })
                )
            )
            await assertReceipts(receipts)
            expect(
                BigInt(
                    (await publicClient.getStorageAt({
                        address: counter,
                        slot: "0x0"
                    })) ?? "0x0"
                )
            ).toBe(2n)
        })

        test.each([false, true])(
            "large calldata retains gas coverage (7702: %s)",
            async (use7702) => {
                const account = await makeAccount(use7702)
                const userOp = await prepare(account, `0x${"ff".repeat(4096)}`)
                const hash = await submit(userOp, "eth_sendUserOperation", "v2")
                await assertReceipts([
                    await account.client.waitForUserOperationReceipt({ hash })
                ])
                expect(
                    BigInt(
                        (await publicClient.getStorageAt({
                            address: counter,
                            slot: "0x0"
                        })) ?? "0x0"
                    )
                ).toBe(1n)
            }
        )
    }
)
