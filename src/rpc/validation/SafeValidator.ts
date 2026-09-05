import type { SenderManager } from "@alto/executor"
import type { GasPriceManager } from "@alto/handlers"
import type {
    InterfaceValidator,
    UserOperation06,
    UserOperation07,
    ValidationResult,
    ValidationResult06,
    ValidationResult07
} from "@alto/types"
import {
    type Address,
    CodeHashGetterAbi,
    CodeHashGetterBytecode,
    EntryPointV06Abi,
    type ReferencedCodeHashes,
    RpcError,
    type StakeInfo,
    type StorageMap,
    type UserOperation,
    ValidationErrors,
    pimlicoSimulationsAbi
} from "@alto/types"
import type { Metrics } from "@alto/utils"
import {
    getAddressFromInitCodeOrPaymasterAndData,
    getAuthorizationStateOverrides,
    isVersion06,
    isVersion08,
    jsonStringifyWithBigint,
    toPackedUserOp
} from "@alto/utils"
import {
    type ExecutionRevertedError,
    type Hex,
    type PublicClient,
    createPublicClient,
    decodeErrorResult,
    encodeDeployData,
    encodeFunctionData,
    http,
    zeroAddress
} from "viem"
import type { AltoConfig } from "../../createConfig"
import {
    type BundlerTracerResult,
    type ExitInfo,
    bundlerCollectorTracer
} from "./BundlerCollectorTracerV07"
import { tracerResultParserV06 } from "./TracerResultParserV06"
import { bundlerCollectorTracer as bundlerCollectorTracerV06 } from "./BundlerCollectorTracerV06"
import { tracerResultParserV07 } from "./TracerResultParserV07"
import { UnsafeValidator } from "./UnsafeValidator"
import { debug_traceCall } from "./tracer"

export class SafeValidator
    extends UnsafeValidator
    implements InterfaceValidator
{
    // Tracing may run against a dedicated node so its CPU cost never competes
    // with the node that serves estimation, receipts and bundle submission.
    private traceClient: PublicClient

    // The sender manager is accepted for constructor compatibility; validation
    // no longer borrows executor wallets.
    constructor({
        config,
        senderManager: _senderManager,
        metrics,
        gasPriceManager
    }: {
        config: AltoConfig
        senderManager: SenderManager
        metrics: Metrics
        gasPriceManager: GasPriceManager
    }) {
        super({
            config,
            metrics,
            gasPriceManager
        })
        this.traceClient = config.validationRpcUrl
            ? createPublicClient({
                  chain: config.publicClient.chain,
                  transport: http(config.validationRpcUrl, { timeout: 20_000 })
              })
            : config.publicClient
    }

    // A dedicated validation node may lag the sequencer by a block; a userOp
    // that depends on very recent state (fresh deployment, nonce) can fail
    // there and pass on the primary node. Retry once on the primary before
    // rejecting, so the dedicated node only ever removes load, never accuracy.
    private async withPrimaryFallback<T>(
        onTraceClient: () => Promise<T>,
        onClient: (client: PublicClient) => Promise<T>
    ): Promise<T> {
        if (this.traceClient === this.config.publicClient) return onTraceClient()
        try {
            return await onTraceClient()
        } catch (error) {
            this.logger.warn(
                { error: error instanceof Error ? error.message : String(error) },
                "validation failed on the validation node; retrying on the primary node"
            )
            return onClient(this.config.publicClient)
        }
    }

    private traceOptions() {
        return this.config.tracerTimeout
            ? { timeout: this.config.tracerTimeout }
            : {}
    }

    async validateUserOp(args: {
        userOp: UserOperation
        queuedUserOps: UserOperation[]
        entryPoint: Address
        referencedContracts?: ReferencedCodeHashes
        storageMap?: StorageMap
    }): Promise<
        ValidationResult & {
            storageMap: StorageMap
            referencedContracts?: ReferencedCodeHashes
        }
    > {
        const { userOp, queuedUserOps, entryPoint, referencedContracts, storageMap } =
            args
        try {
            const validationResult = isVersion06(userOp)
                ? await this.getValidationResultV06({
                      userOp: userOp as UserOperation06,
                      entryPoint,
                      codeHashes: referencedContracts,
                      storageMap
                  })
                : await this.getValidationResultV07({
                      userOp: userOp as UserOperation07,
                      queuedUserOps: queuedUserOps as UserOperation07[],
                      entryPoint,
                      codeHashes: referencedContracts,
                      storageMap
                  })

            this.metrics.userOperationsValidationSuccess.inc()

            return validationResult
        } catch (e) {
            this.metrics.userOperationsValidationFailure.inc()
            throw e
        }
    }

    async getCodeHashes(addresses: string[]): Promise<ReferencedCodeHashes> {
        const deployData = encodeDeployData({
            abi: CodeHashGetterAbi,
            bytecode: CodeHashGetterBytecode,
            args: [addresses]
        })

        // The deploy simulation only needs some sender; borrowing an executor
        // wallet here made every validation wait behind in-flight bundles.
        let hash = ""

        try {
            await this.config.publicClient.call({
                account: this.config.utilityWalletAddress,
                data: deployData
            })
        } catch (e) {
            const error = e as ExecutionRevertedError
            // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
            hash = (error.walk() as any).data
        }

        return {
            hash,
            addresses
        }
    }

    async getValidationResultV07(args: {
        userOp: UserOperation07
        queuedUserOps: UserOperation[]
        entryPoint: Address
        codeHashes?: ReferencedCodeHashes
        storageMap?: StorageMap
    }): Promise<
        ValidationResult07 & {
            storageMap: StorageMap
            referencedContracts?: ReferencedCodeHashes
        }
    > {
        const {
            userOp,
            queuedUserOps,
            entryPoint,
            codeHashes,
            storageMap: cachedStorageMap
        } = args
        if (codeHashes && codeHashes.addresses.length > 0) {
            const { hash } = await this.getCodeHashes(codeHashes.addresses)
            if (hash !== codeHashes.hash) {
                throw new RpcError(
                    "code hashes mismatch",
                    ValidationErrors.OpcodeValidation
                )
            }
            if (cachedStorageMap && !this.config.revalidationTracer) {
                // Explicit benchmark-only mode. Unchanged bytecode is not a
                // proof that storage access or validation state is unchanged;
                // production defaults to a fresh tracer run below.
                const res = await super.getValidationResultV07({
                    userOp,
                    queuedUserOps: queuedUserOps as UserOperation07[],
                    entryPoint
                })
                return {
                    ...res,
                    referencedContracts: codeHashes,
                    storageMap: cachedStorageMap
                }
            }
        }

        const [res, tracerResult] = await this.withPrimaryFallback(() =>
            this.getValidationResultWithTracerV07(
                userOp,
                queuedUserOps as UserOperation07[],
                entryPoint
            ), (client) =>
            this.getValidationResultWithTracerV07(
                userOp,
                queuedUserOps as UserOperation07[],
                entryPoint,
                client
            )
        )

        const [contractAddresses, storageMap] = tracerResultParserV07(
            userOp,
            tracerResult,
            res,
            entryPoint.toLowerCase() as Address
        )

        const referencedContracts: ReferencedCodeHashes =
            codeHashes || (await this.getCodeHashes(contractAddresses))

        // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
        if ((res as any) === "0x") {
            throw new Error(
                "simulateValidation reverted with no revert string!"
            )
        }

        if (res.returnInfo.accountSigFailed) {
            throw new RpcError(
                "Invalid UserOp signature",
                ValidationErrors.InvalidSignature
            )
        }

        if (res.returnInfo.paymasterSigFailed) {
            throw new RpcError(
                "Invalid UserOp paymasterData",
                ValidationErrors.InvalidSignature
            )
        }

        return {
            ...res,
            referencedContracts,
            storageMap
        }
    }

    async getValidationResultV06(args: {
        userOp: UserOperation06
        entryPoint: Address
        codeHashes?: ReferencedCodeHashes
        storageMap?: StorageMap
    }): Promise<
        ValidationResult06 & {
            referencedContracts?: ReferencedCodeHashes
            storageMap: StorageMap
        }
    > {
        const { userOp, entryPoint, codeHashes, storageMap: cachedStorageMap } =
            args
        if (codeHashes && codeHashes.addresses.length > 0) {
            const { hash } = await this.getCodeHashes(codeHashes.addresses)
            if (hash !== codeHashes.hash) {
                throw new RpcError(
                    "code hashes mismatch",
                    ValidationErrors.OpcodeValidation
                )
            }
            if (cachedStorageMap && !this.config.revalidationTracer) {
                const res = await super.getValidationResultV06({
                    userOp,
                    entryPoint
                })
                return {
                    ...res,
                    referencedContracts: codeHashes,
                    storageMap: cachedStorageMap
                }
            }
        }

        const [res, tracerResult] = await this.withPrimaryFallback(
            () => this.getValidationResultWithTracerV06(userOp, entryPoint),
            (client) =>
                this.getValidationResultWithTracerV06(userOp, entryPoint, client)
        )

        const [contractAddresses, storageMap] = tracerResultParserV06(
            userOp,
            tracerResult,
            res,
            entryPoint.toLowerCase() as Address
        )

        const referencedContracts: ReferencedCodeHashes =
            codeHashes || (await this.getCodeHashes(contractAddresses))

        // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
        if ((res as any) === "0x") {
            throw new Error(
                "simulateValidation reverted with no revert string!"
            )
        }
        const validationResult = {
            ...res,
            referencedContracts,
            storageMap
        }

        if (validationResult.returnInfo.sigFailed) {
            throw new RpcError(
                "Invalid UserOp signature or paymaster signature",
                ValidationErrors.InvalidSignature
            )
        }

        const now = Date.now() / 1000

        this.logger.debug({
            validAfter: validationResult.returnInfo.validAfter,
            validUntil: validationResult.returnInfo.validUntil,
            now: now
        })

        if (validationResult.returnInfo.validAfter > now - 5) {
            throw new RpcError(
                "User operation is not valid yet",
                ValidationErrors.ExpiresShortly
            )
        }

        if (validationResult.returnInfo.validUntil < now + 30) {
            throw new RpcError(
                "expires too soon",
                ValidationErrors.ExpiresShortly
            )
        }

        return validationResult
    }

    async getValidationResultWithTracerV06(
        userOp: UserOperation06,
        entryPoint: Address,
        traceClient: PublicClient = this.traceClient
    ): Promise<[ValidationResult06, BundlerTracerResult]> {
        const stateOverrides = getAuthorizationStateOverrides({
            userOps: [userOp]
        })

        const tracerResult = await debug_traceCall(
            traceClient,
            {
                from: zeroAddress,
                to: entryPoint,
                data: encodeFunctionData({
                    abi: EntryPointV06Abi,
                    functionName: "simulateValidation",
                    args: [userOp]
                })
            },
            {
                tracer: bundlerCollectorTracerV06,
                stateOverrides,
                ...this.traceOptions()
            }
        )

        const lastResult = tracerResult.calls.slice(-1)[0]
        if (lastResult.type !== "REVERT") {
            throw new Error("Invalid response. simulateCall must revert")
        }

        const data = (lastResult as ExitInfo).data
        if (data === "0x") {
            // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
            return [data as any, tracerResult]
        }

        try {
            const { errorName, args: errorArgs } = decodeErrorResult({
                abi: EntryPointV06Abi,
                data
            })

            const errFullName = `${errorName}(${errorArgs.toString()})`
            const errorResult = this.parseErrorResultV06(userOp, {
                errorName,
                errorArgs
            })
            if (!errorName.includes("Result")) {
                // a real error, not a result.
                throw new Error(errFullName)
            }
            // @ts-ignore
            return [errorResult, tracerResult]
            // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
        } catch (e: any) {
            // if already parsed, throw as is
            if (e.code != null) {
                throw e
            }
            throw new RpcError(data)
        }
    }

    parseErrorResultV06(
        userOp: UserOperation06,
        // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
        errorResult: { errorName: string; errorArgs: any }
    ): ValidationResult {
        if (!errorResult?.errorName?.startsWith("ValidationResult")) {
            // parse it as FailedOp
            // if its FailedOp, then we have the paymaster param... otherwise its an Error(string)
            let paymaster = errorResult.errorArgs.paymaster
            if (paymaster === zeroAddress) {
                paymaster = undefined
            }

            // eslint-disable-next-line
            const msg: string =
                errorResult.errorArgs[1] ?? errorResult.toString()

            if (paymaster == null) {
                throw new RpcError(
                    `account validation failed: ${msg}`,
                    ValidationErrors.SimulateValidation
                )
            }
            throw new RpcError(
                `paymaster validation failed: ${msg}`,
                ValidationErrors.SimulatePaymasterValidation,
                {
                    paymaster
                }
            )
        }

        const [
            returnInfo,
            senderInfo,
            factoryInfo,
            paymasterInfo,
            aggregatorInfo // may be missing (exists only SimulationResultWithAggregator)
        ] = errorResult.errorArgs

        // extract address from "data" (first 20 bytes)
        // add it as "addr" member to the "stakeinfo" struct
        // if no address, then return "undefined" instead of struct.
        function fillEntity(data: Hex, info: StakeInfo): StakeInfo | undefined {
            const addr = getAddressFromInitCodeOrPaymasterAndData(data)
            return addr == null
                ? undefined
                : {
                      ...info,
                      addr
                  }
        }

        function fillEntityAggregator(
            data: Hex,
            info: StakeInfo
        ): { aggregator: Address; stakeInfo: StakeInfo } | undefined {
            const addr = getAddressFromInitCodeOrPaymasterAndData(data)
            return addr == null
                ? undefined
                : {
                      aggregator: data,
                      stakeInfo: {
                          ...info,
                          addr
                      }
                  }
        }

        return {
            returnInfo,
            senderInfo: {
                ...senderInfo,
                addr: userOp.sender
            },
            factoryInfo: fillEntity(userOp.initCode, factoryInfo),
            paymasterInfo: fillEntity(userOp.paymasterAndData, paymasterInfo),
            aggregatorInfo: fillEntityAggregator(
                aggregatorInfo?.actualAggregator,
                aggregatorInfo?.stakeInfo
            )
        }
    }

    async getValidationResultWithTracerV07(
        userOp: UserOperation07,
        queuedUserOps: UserOperation07[],
        entryPoint: Address,
        traceClient: PublicClient = this.traceClient
    ): Promise<[ValidationResult07, BundlerTracerResult]> {
        const packedUserOp = toPackedUserOp(userOp)
        const packedQueuedUserOps = queuedUserOps.map((uop) =>
            toPackedUserOp(uop)
        )

        const isV8 = isVersion08(userOp, entryPoint)

        const entryPointSimulationsAddress = isV8
            ? this.config.entrypointSimulationContractV8
            : this.config.entrypointSimulationContractV7

        const pimlicoSimulationsAddress = this.config.pimlicoSimulationContract

        if (!(entryPointSimulationsAddress && pimlicoSimulationsAddress)) {
            throw new Error(
                "Entrypoint simulations contract not found for this version"
            )
        }

        const entryPointSimulationsCallData = encodeFunctionData({
            abi: pimlicoSimulationsAbi,
            functionName: "simulateValidation",
            args: [
                entryPointSimulationsAddress,
                entryPoint,
                packedQueuedUserOps,
                packedUserOp
            ]
        })

        const stateOverrides = getAuthorizationStateOverrides({
            userOps: [userOp]
        })

        const tracerResult = await debug_traceCall(
            traceClient,
            {
                from: zeroAddress,
                to: pimlicoSimulationsAddress,
                data: entryPointSimulationsCallData
            },
            {
                tracer: bundlerCollectorTracer,
                stateOverrides,
                ...this.traceOptions()
            }
        )

        // Serializing the full trace on the hot path is expensive; keep it off
        // unless an operator raises the level.
        this.logger[this.config.tracerResultLogLevel](
            `tracerResult: ${jsonStringifyWithBigint(tracerResult)}`
        )

        const lastResult = tracerResult.calls.slice(-1)[0]
        if (lastResult.type !== "REVERT") {
            throw new Error("Invalid response. simulateCall must revert")
        }
        const resultData = lastResult.data as Hex

        // Decode the validation result from the revert data
        const { errorName, args } = decodeErrorResult({
            abi: pimlicoSimulationsAbi,
            data: resultData
        })

        if (errorName !== "ValidationResult") {
            let errorCode = ValidationErrors.SimulateValidation
            const errorMessage = errorName || "Unknown validation error"

            if (errorMessage.includes("AA24")) {
                errorCode = ValidationErrors.InvalidSignature
            }

            if (errorMessage.includes("AA31")) {
                errorCode = ValidationErrors.PaymasterDepositTooLow
            }

            throw new RpcError(errorMessage, errorCode)
        }

        const validationResult = args[0] as ValidationResult07

        const mergedValidation = this.mergeValidationDataValues(
            validationResult.returnInfo.accountValidationData,
            validationResult.returnInfo.paymasterValidationData
        )

        const res = {
            returnInfo: {
                ...validationResult.returnInfo,
                accountSigFailed: mergedValidation.accountSigFailed,
                paymasterSigFailed: mergedValidation.paymasterSigFailed,
                validUntil: mergedValidation.validUntil,
                validAfter: mergedValidation.validAfter
            },
            senderInfo: {
                ...validationResult.senderInfo,
                addr: userOp.sender
            },
            factoryInfo:
                userOp.factory && validationResult.factoryInfo
                    ? {
                          ...validationResult.factoryInfo,
                          addr: userOp.factory
                      }
                    : undefined,
            paymasterInfo:
                userOp.paymaster && validationResult.paymasterInfo
                    ? {
                          ...validationResult.paymasterInfo,
                          addr: userOp.paymaster
                      }
                    : undefined,
            aggregatorInfo: validationResult.aggregatorInfo,
            storageMap: {}
        }

        // this.validateStorageAccessList(userOp, res, accessList)

        if (res.returnInfo.accountSigFailed) {
            throw new RpcError(
                "Invalid UserOp signature",
                ValidationErrors.InvalidSignature
            )
        }

        if (res.returnInfo.paymasterSigFailed) {
            throw new RpcError(
                "Invalid UserOp paymasterData",
                ValidationErrors.InvalidSignature
            )
        }

        const now = Math.floor(Date.now() / 1000)

        if (res.returnInfo.validAfter > now - 5) {
            throw new RpcError(
                `User operation is not valid yet, validAfter=${res.returnInfo.validAfter}, now=${now}`,
                ValidationErrors.ExpiresShortly
            )
        }

        if (
            res.returnInfo.validUntil == null ||
            res.returnInfo.validUntil < now + 30
        ) {
            throw new RpcError(
                `UserOperation expires too soon, validUntil=${res.returnInfo.validUntil}, now=${now}`,
                ValidationErrors.ExpiresShortly
            )
        }

        return [res, tracerResult]
    }
}
