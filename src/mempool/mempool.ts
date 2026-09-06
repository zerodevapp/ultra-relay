import type { EventManager } from "@alto/handlers"
import type { MempoolStore } from "@alto/store"
import {
    type Address,
    EntryPointV06Abi,
    EntryPointV07Abi,
    type EntryPointVersion,
    type InterfaceValidator,
    type ReferencedCodeHashes,
    type RejectedUserOp,
    RpcError,
    type StorageMap,
    type UserOpInfo,
    type UserOperation,
    type UserOperationBundle,
    ValidationErrors,
    type ValidationResult
} from "@alto/types"
import type { Logger, Metrics } from "@alto/utils"
import {
    getAAError,
    getAddressFromInitCodeOrPaymasterAndData,
    getSerializedHandleOpsTx,
    getUserOpHash,
    isVersion06,
    isVersion07,
    isVersion08,
    minBigInt,
    scaleBigIntByPercent,
    timed
} from "@alto/utils"
import { trace } from "@opentelemetry/api"
import { Semaphore } from "async-mutex"
import { type Hex, getAddress, getContract, size } from "viem"
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts"
import type { AltoConfig } from "../createConfig"
import { bundleByteThreshold, getBundleCaps } from "../executor/bundleCaps"
import { calculateAA95GasFloor } from "../executor/utils"
import {
    classifyOperationFailure,
    publicOperationReason,
    scheduleInfrastructureRetry
} from "../utils/operationFailure"
import type { Monitor } from "./monitoring"
import {
    type InterfaceReputationManager,
    ReputationStatuses
} from "./reputationManager"

type BundleAccumulator = {
    paymasterDeposit: { [paymaster: string]: bigint }
    stakedEntityCount: { [addr: string]: number }
    knownEntities: {
        sender: Set<`0x${string}`>
        paymasters: Set<`0x${string}`>
        factories: Set<`0x${string}`>
    }
    senders: Set<string>
    storageMap: StorageMap
}

type SkipDecision = BundleAccumulator & {
    skip: boolean
    removeOutstanding?: boolean
}

export type ValidationOutcome =
    | { ok: true; result: ValidationResult & { storageMap: StorageMap } }
    | { ok: false; error: unknown }

type Candidate = {
    userOpInfo: UserOpInfo
    reentered: boolean
    queuedUserOps?: UserOperation[]
    outcome?: Promise<ValidationOutcome>
}

export class Mempool {
    private config: AltoConfig
    private metrics: Metrics
    private monitor: Monitor
    private reputationManager: InterfaceReputationManager
    public store: MempoolStore
    private throttledEntityBundleCount: number
    private logger: Logger
    private validator: InterfaceValidator
    private eventManager: EventManager
    private validationSemaphore: Semaphore

    constructor({
        config,
        metrics,
        monitor,
        reputationManager,
        validator,
        store,
        eventManager
    }: {
        config: AltoConfig
        metrics: Metrics
        monitor: Monitor
        reputationManager: InterfaceReputationManager
        validator: InterfaceValidator
        store: MempoolStore
        eventManager: EventManager
    }) {
        this.metrics = metrics
        this.store = store
        this.config = config
        this.reputationManager = reputationManager
        this.monitor = monitor
        this.validator = validator
        this.logger = config.getLogger(
            { module: "mempool" },
            {
                level: config.logLevel
            }
        )
        this.throttledEntityBundleCount = 4 // we don't have any config for this as of now
        this.eventManager = eventManager
        this.validationSemaphore = new Semaphore(
            Math.max(1, config.bundleValidationConcurrency ?? 1)
        )
    }

    // === Methods for handling changing userOp state === //

    async markUserOpsAsSubmitted({
        userOps,
        entryPoint,
        transactionHash
    }: {
        userOps: UserOpInfo[]
        entryPoint: Address
        transactionHash: Hex
    }) {
        await Promise.all(
            userOps.map(async (userOpInfo) => {
                const { userOpHash } = userOpInfo
                await this.store.removeProcessing({ entryPoint, userOpHash })
                userOpInfo.submittedAt ??= Date.now()
                await this.store.addSubmitted({ entryPoint, userOpInfo })
                await this.monitor.setUserOpStatus(userOpHash, {
                    status: "submitted",
                    transactionHash
                })
            })
        )

        this.metrics.userOperationsSubmitted
            .labels({ status: "success" })
            .inc(userOps.length)
    }

    async resubmitUserOps({
        userOps,
        entryPoint,
        reason
    }: {
        userOps: UserOpInfo[]
        entryPoint: Address
        reason: string
    }) {
        await Promise.all(
            userOps.map(async (userOpInfo) => {
                const { userOpHash, userOp } = userOpInfo
                if (
                    reason === "filterops_infrastructure" &&
                    !scheduleInfrastructureRetry(userOpInfo)
                ) {
                    await this.dropUserOps(entryPoint, [
                        {
                            ...userOpInfo,
                            reason: "Bundle simulation infrastructure retries exhausted"
                        }
                    ])
                    return
                }
                this.logger.warn(
                    {
                        userOpHash,
                        reason
                    },
                    `resubmitting userOp ${userOpHash} back to outstanding mempool: ${reason}`
                )
                await this.store.removeProcessing({ entryPoint, userOpHash })
                await this.store.removeSubmitted({ entryPoint, userOpHash })
                // Keep the original receivedAt so the inclusion log's totalMs
                // spans the op's whole life across retries; validationMs is
                // suppressed for reentered records (the record's addedToMempool
                // is restamped, so that delta would span the prior cycle).
                const [success, failureReason] = await this.add(
                    userOp,
                    entryPoint,
                    {
                        receivedAt: userOpInfo.receivedAt,
                        reentry: true,
                        infrastructureRetries: userOpInfo.infrastructureRetries,
                        retryAfter: userOpInfo.retryAfter,
                        submissionAttempts: userOpInfo.submissionAttempts,
                        referencedContracts: userOpInfo.referencedContracts,
                        storageMap: userOpInfo.storageMap
                    }
                )

                if (!success) {
                    this.logger.error(
                        { userOpHash, failureReason },
                        `failed to re-add userOp ${userOpHash} during resubmission, dropping it`
                    )
                    const rejectedUserOp = {
                        ...userOpInfo,
                        reason: failureReason
                    }
                    await this.dropUserOps(entryPoint, [rejectedUserOp])
                }
            })
        )

        this.metrics.userOperationsResubmitted.inc(userOps.length)
    }

    async dropUserOps(entryPoint: Address, rejectedUserOps: RejectedUserOp[]) {
        await Promise.all(
            rejectedUserOps.map(async (rejectedUserOp) => {
                const { userOpHash } = rejectedUserOp
                const reason = publicOperationReason(rejectedUserOp.reason)
                await this.store.removeProcessing({ entryPoint, userOpHash })
                await this.store.removeSubmitted({ entryPoint, userOpHash })
                this.eventManager.emitDropped(
                    userOpHash,
                    reason,
                    getAAError(reason)
                )
                await this.monitor.setUserOpStatus(userOpHash, {
                    status: "rejected",
                    reason,
                    transactionHash: null
                })
                this.logger.warn(
                    {
                        userOpHash,
                        reason
                    },
                    `userOp ${userOpHash} dropped from mempool: ${reason}`
                )
            })
        )
    }

    async removeProcessingUserOps({
        userOps,
        entryPoint
    }: {
        userOps: UserOpInfo[]
        entryPoint: Address
    }) {
        await Promise.all(
            userOps.map(async ({ userOpHash }) => {
                await this.store.removeProcessing({ entryPoint, userOpHash })
            })
        )
    }

    async removeSubmittedUserOps({
        userOps,
        entryPoint
    }: {
        userOps: UserOpInfo[]
        entryPoint: Address
    }) {
        await Promise.all(
            userOps.map(async ({ userOpHash }) => {
                await this.store.removeSubmitted({ entryPoint, userOpHash })
            })
        )
    }

    // === Methods for dropping mempool entries === //

    async dumpOutstanding(entryPoint: Address): Promise<UserOpInfo[]> {
        return await this.store.dumpOutstanding(entryPoint)
    }

    async dumpProcessing(entryPoint: Address): Promise<UserOpInfo[]> {
        return await this.store.dumpProcessing(entryPoint)
    }

    async dumpSubmittedOps(entryPoint: Address): Promise<UserOpInfo[]> {
        return await this.store.dumpSubmitted(entryPoint)
    }

    // === Methods for entity management === //

    async checkEntityMultipleRoleViolation(
        entryPoint: Address,
        op: UserOperation
    ) {
        if (!this.config.safeMode) {
            return Promise.resolve()
        }

        const knownEntities = await this.getKnownEntities(entryPoint)

        if (
            knownEntities.paymasters.has(op.sender) ||
            knownEntities.factories.has(op.sender)
        ) {
            throw new RpcError(
                `The sender address "${op.sender}" is used as a different entity in another UserOperation currently in mempool`,
                ValidationErrors.OpcodeValidation
            )
        }

        let paymaster: Address | null = null
        let factory: Address | null = null

        if (isVersion06(op)) {
            paymaster = getAddressFromInitCodeOrPaymasterAndData(
                op.paymasterAndData
            )

            factory = getAddressFromInitCodeOrPaymasterAndData(op.initCode)
        }

        if (isVersion07(op)) {
            paymaster = op.paymaster
            factory = op.factory
        }

        if (paymaster && knownEntities.sender.has(paymaster)) {
            throw new RpcError(
                `A Paymaster at ${paymaster} in this UserOperation is used as a sender entity in another UserOperation currently in mempool.`,
                ValidationErrors.OpcodeValidation
            )
        }
        if (factory && knownEntities.sender.has(factory)) {
            throw new RpcError(
                `A Factory at ${factory} in this UserOperation is used as a sender entity in another UserOperation currently in mempool.`,
                ValidationErrors.OpcodeValidation
            )
        }
        return Promise.resolve()
    }

    async getKnownEntities(entryPoint: Address): Promise<{
        sender: Set<Address>
        paymasters: Set<Address>
        factories: Set<Address>
    }> {
        // TODO: this won't work with redis
        const allOps = await this.store.dumpOutstanding(entryPoint)

        const entities: {
            sender: Set<Address>
            paymasters: Set<Address>
            factories: Set<Address>
        } = {
            sender: new Set(),
            paymasters: new Set(),
            factories: new Set()
        }

        for (const userOpInfo of allOps) {
            const { userOp } = userOpInfo
            entities.sender.add(userOp.sender)

            const isUserOpV06 = isVersion06(userOp)

            const paymaster = isUserOpV06
                ? getAddressFromInitCodeOrPaymasterAndData(
                      userOp.paymasterAndData
                  )
                : userOp.paymaster

            if (paymaster) {
                entities.paymasters.add(paymaster)
            }

            const factory = isUserOpV06
                ? getAddressFromInitCodeOrPaymasterAndData(userOp.initCode)
                : userOp.factory

            if (factory) {
                entities.factories.add(factory)
            }
        }

        return entities
    }

    // === Methods for adding userOps / creating bundles === //

    async add(
        userOp: UserOperation,
        entryPoint: Address,
        {
            referencedContracts,
            storageMap,
            receivedAt,
            reentry,
            infrastructureRetries,
            retryAfter,
            submissionAttempts = 0
        }: {
            referencedContracts?: ReferencedCodeHashes
            storageMap?: StorageMap
            receivedAt?: number
            reentry?: boolean
            infrastructureRetries?: number
            retryAfter?: number
            submissionAttempts?: number
        } = {}
    ): Promise<[boolean, string]> {
        const userOpHash = await getUserOpHash({
            userOp,
            entryPointAddress: entryPoint,
            chainId: this.config.chainId,
            publicClient: this.config.publicClient
        })

        // Check if the exact same userOperation is already in the mempool.
        if (await this.store.isInMempool({ userOpHash, entryPoint })) {
            return [false, "Already known"]
        }

        // Check if there is a conflicting userOp already being processed
        const validation = await this.store.validateSubmittedOrProcessing({
            entryPoint,
            userOp
        })

        if (!validation.valid) {
            return [false, validation.reason]
        }

        // Check if there is a userOp we can replace
        const conflicting = await this.store.popConflictingOustanding({
            entryPoint,
            userOp
        })

        if (conflicting) {
            const { userOpInfo, reason } = conflicting
            const conflictingUserOp = userOpInfo.userOp

            const hasHigherPriorityFee =
                userOp.maxPriorityFeePerGas >=
                scaleBigIntByPercent(
                    conflictingUserOp.maxPriorityFeePerGas,
                    110n
                )

            const hasHigherMaxFee =
                userOp.maxFeePerGas >=
                scaleBigIntByPercent(conflictingUserOp.maxFeePerGas, 110n)

            const hasHigherFees = hasHigherPriorityFee && hasHigherMaxFee

            if (!hasHigherFees) {
                const message =
                    reason === "conflicting_deployment"
                        ? "AA10 sender already constructed: A conflicting userOperation with initCode for this sender is already in the mempool"
                        : "AA25 invalid account nonce: User operation already present in mempool"

                // Re-add to outstanding as it wasn't replaced
                conflicting.userOpInfo.reentered = true
                await this.store.addOutstanding({
                    entryPoint,
                    userOpInfo: conflicting.userOpInfo
                })

                return [false, `${message}, bump the gas price by minimum 10%`]
            }

            this.logger.info(
                {
                    event: "userOpReplaced",
                    reason: "Higher gas fees",
                    replacedUserOpHash: userOpInfo.userOpHash,
                    newUserOpHash: userOpHash,
                    sender: userOp.sender,
                    oldFees: {
                        maxFeePerGas: conflictingUserOp.maxFeePerGas.toString(),
                        maxPriorityFeePerGas:
                            conflictingUserOp.maxPriorityFeePerGas.toString()
                    },
                    newFees: {
                        maxFeePerGas: userOp.maxFeePerGas.toString(),
                        maxPriorityFeePerGas:
                            userOp.maxPriorityFeePerGas.toString()
                    }
                },
                `userOp ${userOpInfo.userOpHash} replaced by ${userOpHash} (higher gas fees)`
            )

            await this.reputationManager.replaceUserOpSeenStatus(
                conflictingUserOp,
                entryPoint
            )
        }

        if (reentry) {
            // Processing removed this operation from entity occupancy. Restore
            // occupancy without counting an infrastructure retry as a new sighting.
            this.reputationManager.increaseUserOpCount(userOp)
        } else {
            await this.reputationManager.increaseUserOpSeenStatus(
                userOp,
                entryPoint
            )
        }

        await this.store.addOutstanding({
            entryPoint,
            userOpInfo: {
                userOp,
                userOpHash,
                referencedContracts,
                storageMap,
                receivedAt,
                addedToMempool: Date.now(),
                submissionAttempts,
                infrastructureRetries,
                retryAfter,
                ...(reentry ? { reentered: true } : {})
            }
        })

        await this.monitor.setUserOpStatus(userOpHash, {
            status: "not_submitted",
            transactionHash: null
        })

        this.eventManager.emitAddedToMempool(userOpHash)
        return [true, ""]
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <explanation>
    // The three phases of the bundle-time check. shouldSkip composes them for
    // the serial loop; processConcurrent runs phase two for several candidates
    // at once and replays phases one and three strictly in pop order, so every
    // decision and accumulator effect is the one the serial loop would make.

    private preValidationSkip({
        userOpInfo,
        stakedEntityCount,
        senders,
        entryPoint
    }: {
        userOpInfo: UserOpInfo
        stakedEntityCount: { [addr: string]: number }
        senders: Set<string>
        entryPoint: Address
    }): { skip: false } | { skip: true; removeOutstanding?: boolean } {
        const { userOp, userOpHash } = userOpInfo
        const isUserOpV06 = isVersion06(userOp)

        const paymaster = isUserOpV06
            ? getAddressFromInitCodeOrPaymasterAndData(userOp.paymasterAndData)
            : userOp.paymaster
        const factory = isUserOpV06
            ? getAddressFromInitCodeOrPaymasterAndData(userOp.initCode)
            : userOp.factory
        const paymasterStatus = this.reputationManager.getStatus(
            entryPoint,
            paymaster
        )
        const factoryStatus = this.reputationManager.getStatus(
            entryPoint,
            factory
        )

        if (
            paymasterStatus === ReputationStatuses.banned ||
            factoryStatus === ReputationStatuses.banned
        ) {
            this.logger.warn(
                {
                    event: "userOpSkipped",
                    reason: "Entity banned",
                    userOpHash: userOpHash,
                    sender: userOp.sender,
                    paymaster: paymaster,
                    factory: factory,
                    paymasterStatus: paymasterStatus.toString(),
                    factoryStatus: factoryStatus.toString()
                },
                `Skipping userOp ${userOpHash}: associated entity is banned.`
            )
            return { skip: true, removeOutstanding: true }
        }

        if (
            paymasterStatus === ReputationStatuses.throttled &&
            paymaster &&
            stakedEntityCount[paymaster] >= this.throttledEntityBundleCount
        ) {
            this.logger.info(
                {
                    event: "userOpSkipped",
                    reason: "Paymaster throttled",
                    userOpHash: userOpHash,
                    sender: userOp.sender,
                    paymaster: paymaster
                },
                `Skipping userOp ${userOpHash}: paymaster is throttled.`
            )
            return { skip: true }
        }

        if (
            factoryStatus === ReputationStatuses.throttled &&
            factory &&
            stakedEntityCount[factory] >= this.throttledEntityBundleCount
        ) {
            this.logger.info(
                {
                    event: "userOpSkipped",
                    reason: "Factory throttled",
                    userOpHash: userOpHash,
                    sender: userOp.sender,
                    factory: factory
                },
                `Skipping userOp ${userOpHash}: factory is throttled.`
            )
            return { skip: true }
        }

        if (
            senders.has(userOp.sender) &&
            this.config.enforceUniqueSendersPerBundle
        ) {
            this.logger.trace(
                {
                    sender: userOp.sender,
                    userOpHash
                },
                "Sender skipped because already included in bundle"
            )
            return { skip: true }
        }

        return { skip: false }
    }

    // Never rejects; the failure is part of the outcome so a concurrent
    // caller can decide about it later, in order.
    async runValidation({
        userOpInfo,
        queuedUserOps,
        entryPoint
    }: {
        userOpInfo: UserOpInfo
        queuedUserOps?: UserOperation[]
        entryPoint: Address
    }): Promise<ValidationOutcome> {
        const {
            userOp,
            userOpHash,
            referencedContracts,
            storageMap: cachedStorageMap
        } = userOpInfo
        try {
            let queued = queuedUserOps ?? []
            if (queuedUserOps === undefined && !isVersion06(userOp)) {
                queued = await this.getQueuedOutstandingUserOps({
                    userOp,
                    entryPoint
                })
            }
            const result = await timed(
                this.logger,
                "shouldSkip.validate",
                { userOpHash, cachedStorageMap: Boolean(cachedStorageMap) },
                () =>
                    this.validator.validateUserOp({
                        userOp,
                        queuedUserOps: queued,
                        entryPoint,
                        referencedContracts,
                        storageMap: cachedStorageMap
                    })
            )
            return { ok: true, result }
        } catch (error) {
            return { ok: false, error }
        }
    }

    private async postValidationSkip({
        userOpInfo,
        outcome,
        paymasterDeposit,
        stakedEntityCount,
        knownEntities,
        senders,
        storageMap,
        entryPoint
    }: BundleAccumulator & {
        userOpInfo: UserOpInfo
        outcome: ValidationOutcome
        entryPoint: Address
    }): Promise<SkipDecision> {
        const { userOp, userOpHash } = userOpInfo
        const isUserOpV06 = isVersion06(userOp)
        const paymaster = isUserOpV06
            ? getAddressFromInitCodeOrPaymasterAndData(userOp.paymasterAndData)
            : userOp.paymaster
        const factory = isUserOpV06
            ? getAddressFromInitCodeOrPaymasterAndData(userOp.initCode)
            : userOp.factory
        const accumulator = {
            paymasterDeposit,
            stakedEntityCount,
            knownEntities,
            senders,
            storageMap
        }

        if (!outcome.ok) {
            const failure = classifyOperationFailure(outcome.error)
            this.logger.warn(
                { userOpHash, ...failure },
                "Bundle-time validation failed"
            )
            const retry =
                failure.retryable && scheduleInfrastructureRetry(userOpInfo)
            if (!failure.retryable) {
                try {
                    await this.reputationManager.decreaseUserOpSeenStatus(
                        userOp,
                        entryPoint,
                        failure.reason
                    )
                } catch {
                    // A reputation backend outage must not suppress the terminal
                    // operation status after deterministic validation failure.
                    this.logger.error(
                        { userOpHash },
                        "Failed to update rejection reputation"
                    )
                }
            }
            if (!retry) {
                this.reputationManager.decreaseUserOpCount(userOp)
                await this.dropUserOps(entryPoint, [
                    {
                        ...userOpInfo,
                        reason: failure.retryable
                            ? `${failure.reason}; infrastructure retries exhausted`
                            : failure.reason
                    }
                ])
            }
            return { skip: true, removeOutstanding: !retry, ...accumulator }
        }

        const validationResult = outcome.result

        for (const storageAddress of Object.keys(validationResult.storageMap)) {
            const address = getAddress(storageAddress)

            if (
                address !== userOp.sender &&
                knownEntities.sender.has(address)
            ) {
                this.logger.trace(
                    {
                        storageAddress,
                        userOpHash
                    },
                    "Storage address skipped"
                )
                return { skip: true, ...accumulator }
            }
        }

        if (paymaster) {
            if (paymasterDeposit[paymaster] === undefined) {
                const entryPointContract = getContract({
                    abi: isUserOpV06 ? EntryPointV06Abi : EntryPointV07Abi,
                    address: entryPoint,
                    client: {
                        public: this.config.publicClient
                    }
                })
                paymasterDeposit[paymaster] =
                    await entryPointContract.read.balanceOf([paymaster])
            }
            if (
                paymasterDeposit[paymaster] <
                validationResult.returnInfo.prefund
            ) {
                this.logger.trace(
                    {
                        paymaster,
                        userOpHash
                    },
                    "Paymaster skipped because of insufficient balance left to sponsor all user ops in the bundle"
                )
                return { skip: true, ...accumulator }
            }
            stakedEntityCount[paymaster] =
                (stakedEntityCount[paymaster] ?? 0) + 1
            paymasterDeposit[paymaster] -= validationResult.returnInfo.prefund
        }

        if (factory) {
            stakedEntityCount[factory] = (stakedEntityCount[factory] ?? 0) + 1
        }

        senders.add(userOp.sender)

        return { skip: false, ...accumulator }
    }

    async shouldSkip({
        userOpInfo,
        paymasterDeposit,
        stakedEntityCount,
        knownEntities,
        senders,
        storageMap,
        entryPoint
    }: BundleAccumulator & {
        userOpInfo: UserOpInfo
        entryPoint: Address
    }): Promise<SkipDecision> {
        const accumulator = {
            paymasterDeposit,
            stakedEntityCount,
            knownEntities,
            senders,
            storageMap
        }
        if (!this.config.safeMode) {
            return { skip: false, ...accumulator }
        }

        const pre = this.preValidationSkip({
            userOpInfo,
            stakedEntityCount,
            senders,
            entryPoint
        })
        if (pre.skip) {
            return { ...pre, ...accumulator }
        }

        const outcome = await this.runValidation({ userOpInfo, entryPoint })
        return this.postValidationSkip({
            userOpInfo,
            outcome,
            entryPoint,
            ...accumulator
        })
    }

    // Concurrent variant of process(): pops up to `bundleValidationConcurrency`
    // candidates, starts their traces together under one semaphore, then
    // replays the decisions in pop order against the live accumulator. Any
    // candidate the replay does not consume goes back to its queue position.
    private async processConcurrent({
        maxGasLimit,
        entryPoint,
        minOpsPerBundle,
        maxBundleCount,
        concurrency
    }: {
        maxGasLimit: bigint
        entryPoint: Address
        minOpsPerBundle: number
        maxBundleCount?: number
        concurrency: number
    }): Promise<UserOperationBundle[]> {
        const firstOp = await this.store.peekOutstanding(entryPoint)
        if (!firstOp) {
            return []
        }

        const bundles: UserOperationBundle[] = []
        const seenOps = new Set<string>()
        const deferred: UserOpInfo[] = []
        let breakLoop = false
        const stats = { popped: 0, traced: 0, discarded: 0, batches: 0 }

        let version: EntryPointVersion
        if (isVersion08(firstOp.userOp, entryPoint)) {
            version = "0.8"
        } else if (isVersion07(firstOp.userOp)) {
            version = "0.7"
        } else {
            version = "0.6"
        }
        const caps = getBundleCaps(this.config)
        const gasCeiling = minBigInt(maxGasLimit, caps.gasCap)
        const byteThreshold = bundleByteThreshold(caps.byteCap)
        const beneficiary =
            this.config.utilityPrivateKey?.address ||
            privateKeyToAddress(generatePrivateKey())

        const projection = (
            userOps: UserOperation[],
            gasUsed: bigint,
            eip7702Overhead: bigint
        ) => ({
            projectedGas: scaleBigIntByPercent(gasUsed + eip7702Overhead, 105n),
            projectedBytes: size(
                getSerializedHandleOpsTx({
                    userOps,
                    entryPoint,
                    chainId: this.config.chainId,
                    removeZeros: false
                })
            )
        })

        while (await this.store.peekOutstanding(entryPoint)) {
            if (maxBundleCount && bundles.length >= maxBundleCount) {
                break
            }
            if (breakLoop) {
                break
            }

            const currentBundle: UserOperationBundle = {
                entryPoint,
                version,
                userOps: [],
                submissionAttempts: 0
            }
            let gasUsed = 0n
            let eip7702Overhead = 0n
            let accumulator: BundleAccumulator = {
                paymasterDeposit: {},
                stakedEntityCount: {},
                senders: new Set<string>(),
                knownEntities: await this.getKnownEntities(entryPoint),
                storageMap: {}
            }
            let bundleClosed = false

            while (
                !bundleClosed &&
                !breakLoop &&
                (await this.store.peekOutstanding(entryPoint))
            ) {
                // Phase A: sequential pops, speculative traces.
                const batch: Candidate[] = []
                let speculativeGas = gasUsed
                let speculativeOverhead = eip7702Overhead
                const speculativeOps = currentBundle.userOps.map(
                    (info) => info.userOp
                )
                while (
                    batch.length < concurrency &&
                    (await this.store.peekOutstanding(entryPoint))
                ) {
                    const userOpInfo =
                        await this.store.popOutstanding(entryPoint)
                    if (!userOpInfo) {
                        break
                    }
                    stats.popped++

                    if (seenOps.has(userOpInfo.userOpHash)) {
                        // Serial re-adds this op and ends the tick when it
                        // reaches it. Decide that in phase B, after every
                        // earlier candidate, exactly where serial would.
                        batch.push({ userOpInfo, reentered: true })
                        break
                    }
                    seenOps.add(userOpInfo.userOpHash)

                    if ((userOpInfo.retryAfter ?? 0) > Date.now()) {
                        deferred.push(userOpInfo)
                        continue
                    }

                    const candidate: Candidate = {
                        userOpInfo,
                        reentered: false
                    }
                    if (this.config.safeMode) {
                        // Inputs captured at pop time, as the serial loop sees them.
                        if (isVersion06(userOpInfo.userOp)) {
                            candidate.queuedUserOps = []
                        } else {
                            try {
                                candidate.queuedUserOps =
                                    await this.getQueuedOutstandingUserOps({
                                        userOp: userOpInfo.userOp,
                                        entryPoint
                                    })
                            } catch (error) {
                                candidate.outcome = Promise.resolve({
                                    ok: false,
                                    error
                                })
                            }
                        }
                        // The hint can only turn from proceed into skip as the
                        // accumulator grows, never the other way, so a skip here
                        // is final and a proceed may still be overruled.
                        const hint = this.preValidationSkip({
                            userOpInfo,
                            stakedEntityCount: accumulator.stakedEntityCount,
                            senders: accumulator.senders,
                            entryPoint
                        })
                        if (!hint.skip && !candidate.outcome) {
                            stats.traced++
                            candidate.outcome =
                                this.validationSemaphore.runExclusive(() =>
                                    this.runValidation({
                                        userOpInfo,
                                        queuedUserOps: candidate.queuedUserOps,
                                        entryPoint
                                    })
                                )
                        }
                    }
                    batch.push(candidate)

                    speculativeGas += calculateAA95GasFloor({
                        userOps: [userOpInfo.userOp],
                        beneficiary
                    })
                    if (userOpInfo.userOp.eip7702Auth) {
                        speculativeOverhead += 40_000n
                    }
                    speculativeOps.push(userOpInfo.userOp)
                    const speculative = projection(
                        speculativeOps,
                        speculativeGas,
                        speculativeOverhead
                    )
                    if (
                        speculative.projectedGas > gasCeiling ||
                        speculative.projectedBytes > byteThreshold
                    ) {
                        break
                    }
                }
                stats.batches++

                // Phase B: serial replay in pop order.
                for (let index = 0; index < batch.length; index++) {
                    const candidate = batch[index]
                    const { userOpInfo } = candidate
                    const leftovers = batch.slice(index + 1)

                    if (candidate.reentered) {
                        breakLoop = true
                        userOpInfo.reentered = true
                        await this.store.addOutstanding({
                            entryPoint,
                            userOpInfo
                        })
                        break
                    }

                    const decision = await this.decideCandidate({
                        candidate,
                        accumulator,
                        entryPoint
                    })

                    if (decision.skip) {
                        if (decision.removeOutstanding) {
                            continue
                        }
                        await this.restoreLeftovers({
                            entryPoint,
                            leftovers,
                            seenOps,
                            stats
                        })
                        userOpInfo.reentered = true
                        await this.store.addOutstanding({
                            entryPoint,
                            userOpInfo
                        })
                        break
                    }

                    const { userOp } = userOpInfo
                    const nextGasUsed =
                        gasUsed +
                        calculateAA95GasFloor({
                            userOps: [userOp],
                            beneficiary
                        })
                    const nextOverhead =
                        eip7702Overhead + (userOp.eip7702Auth ? 40_000n : 0n)
                    const { projectedGas, projectedBytes } = projection(
                        [
                            ...currentBundle.userOps.map((info) => info.userOp),
                            userOp
                        ],
                        nextGasUsed,
                        nextOverhead
                    )
                    const exceedsGas = projectedGas > gasCeiling
                    const exceedsBytes = projectedBytes > byteThreshold

                    if (
                        (exceedsGas || exceedsBytes) &&
                        currentBundle.userOps.length >= minOpsPerBundle
                    ) {
                        this.logger.debug(
                            {
                                event: "userOpSkipped",
                                reason: exceedsBytes
                                    ? "Bundle byte size limit exceeded"
                                    : "Bundle gas limit exceeded",
                                userOpHash: userOpInfo.userOpHash,
                                projectedGas: projectedGas.toString(),
                                gasCeiling: gasCeiling.toString(),
                                projectedBytes,
                                byteThreshold
                            },
                            `Skipping userOp ${userOpInfo.userOpHash}, would exceed bundle cap.`
                        )
                        await this.restoreLeftovers({
                            entryPoint,
                            leftovers,
                            seenOps,
                            stats
                        })
                        userOpInfo.reentered = true
                        await this.store.addOutstanding({
                            entryPoint,
                            userOpInfo
                        })
                        bundleClosed = true
                        break
                    }

                    gasUsed = nextGasUsed
                    eip7702Overhead = nextOverhead
                    accumulator = {
                        paymasterDeposit: decision.paymasterDeposit,
                        stakedEntityCount: decision.stakedEntityCount,
                        knownEntities: decision.knownEntities,
                        senders: decision.senders,
                        storageMap: decision.storageMap
                    }
                    this.reputationManager.decreaseUserOpCount(userOp)
                    userOpInfo.processingAt = Date.now()
                    this.store.addProcessing({ entryPoint, userOpInfo })
                    currentBundle.userOps.push(userOpInfo)
                }
            }

            if (currentBundle.userOps.length > 0) {
                bundles.push(currentBundle)
            }
        }

        for (const userOpInfo of deferred) {
            await this.store.addOutstanding({ entryPoint, userOpInfo })
        }

        this.logger.debug(
            { event: "bundleValidationBatch", concurrency, ...stats },
            "concurrent bundle-time validation tick"
        )
        trace.getActiveSpan()?.setAttributes({
            "validation.inflight": concurrency,
            "validation.discarded": stats.discarded
        })

        return bundles
    }

    // Phase one and three for one candidate against the live accumulator. The
    // trace started in phase A is awaited here; if the hint was a false
    // proceed the accumulator says skip and the outcome is discarded.
    private async decideCandidate({
        candidate,
        accumulator,
        entryPoint
    }: {
        candidate: Candidate
        accumulator: BundleAccumulator
        entryPoint: Address
    }): Promise<SkipDecision> {
        const { userOpInfo } = candidate
        if (!this.config.safeMode) {
            return { skip: false, ...accumulator }
        }
        const pre = this.preValidationSkip({
            userOpInfo,
            stakedEntityCount: accumulator.stakedEntityCount,
            senders: accumulator.senders,
            entryPoint
        })
        if (pre.skip) {
            return { ...pre, ...accumulator }
        }
        const outcome = await (candidate.outcome ??
            this.validationSemaphore.runExclusive(() =>
                this.runValidation({
                    userOpInfo,
                    queuedUserOps: candidate.queuedUserOps,
                    entryPoint
                })
            ))
        return this.postValidationSkip({
            userOpInfo,
            outcome,
            entryPoint,
            ...accumulator
        })
    }

    // Candidates popped after a skipped or cap-breaking operation were never
    // considered by the serial loop; put them back in order so the next batch
    // pops exactly what serial would have popped next.
    private async restoreLeftovers({
        entryPoint,
        leftovers,
        seenOps,
        stats
    }: {
        entryPoint: Address
        leftovers: Candidate[]
        seenOps: Set<string>
        stats: { discarded: number }
    }): Promise<void> {
        if (leftovers.length === 0) {
            return
        }
        for (const candidate of leftovers) {
            if (candidate.outcome) {
                stats.discarded++
                candidate.outcome.catch(() => undefined)
            }
            // A reentered candidate stays seen: serial will end the tick when it
            // reaches it again. Everything else is unseen once restored.
            if (!candidate.reentered) {
                seenOps.delete(candidate.userOpInfo.userOpHash)
            }
        }
        await this.store.restoreOutstanding({
            entryPoint,
            userOpInfos: leftovers.map((candidate) => candidate.userOpInfo)
        })
    }

    public async getBundles(
        maxBundleCount?: number
    ): Promise<UserOperationBundle[]> {
        const bundlePromises = this.config.entrypoints.map(
            async (entryPoint) => {
                return await this.process({
                    entryPoint,
                    maxGasLimit: this.config.maxGasPerBundle,
                    minOpsPerBundle: 1,
                    maxBundleCount
                })
            }
        )

        const bundlesNested = await Promise.all(bundlePromises)
        const bundles = bundlesNested.flat()

        return bundles
    }

    // Returns a bundle of userOperations in array format.
    async process({
        maxGasLimit,
        entryPoint,
        minOpsPerBundle,
        maxBundleCount
    }: {
        maxGasLimit: bigint
        entryPoint: Address
        minOpsPerBundle: number
        maxBundleCount?: number
    }): Promise<UserOperationBundle[]> {
        const concurrency = this.config.bundleValidationConcurrency ?? 1
        if (concurrency > 1) {
            return this.processConcurrent({
                maxGasLimit,
                entryPoint,
                minOpsPerBundle,
                maxBundleCount,
                concurrency
            })
        }

        // Check if there are any operations in the store
        const firstOp = await this.store.peekOutstanding(entryPoint)
        if (!firstOp) {
            return []
        }

        // Get EntryPoint version
        const bundles: UserOperationBundle[] = []
        const seenOps = new Set()
        const deferred: UserOpInfo[] = []
        let breakLoop = false

        // Process operations until no more are available or we hit maxBundleCount
        while (await this.store.peekOutstanding(entryPoint)) {
            // If maxBundles is set and we reached the limit, break
            if (maxBundleCount && bundles.length >= maxBundleCount) {
                break
            }

            // Derive version
            let version: EntryPointVersion
            if (isVersion08(firstOp.userOp, entryPoint)) {
                version = "0.8"
            } else if (isVersion07(firstOp.userOp)) {
                version = "0.7"
            } else {
                version = "0.6"
            }

            // Setup for next bundle
            const currentBundle: UserOperationBundle = {
                entryPoint,
                version,
                userOps: [],
                submissionAttempts: 0
            }
            let gasUsed = 0n
            let eip7702Overhead = 0n
            const caps = getBundleCaps(this.config)
            const gasCeiling = minBigInt(maxGasLimit, caps.gasCap)
            const byteThreshold = bundleByteThreshold(caps.byteCap)
            let paymasterDeposit: { [paymaster: string]: bigint } = {}
            let stakedEntityCount: { [addr: string]: number } = {}
            let senders = new Set<string>()
            let knownEntities = await this.getKnownEntities(entryPoint)
            let storageMap: StorageMap = {}

            if (breakLoop) {
                break
            }

            // Keep adding ops to current bundle
            while (await this.store.peekOutstanding(entryPoint)) {
                const userOpInfo = await this.store.popOutstanding(entryPoint)
                if (!userOpInfo) {
                    break
                }

                if (seenOps.has(userOpInfo.userOpHash)) {
                    breakLoop = true
                    userOpInfo.reentered = true
                    await this.store.addOutstanding({
                        entryPoint,
                        userOpInfo
                    })
                    break
                }

                seenOps.add(userOpInfo.userOpHash)

                // An operation in infrastructure backoff must not return to the
                // head of the queue: with distinct fees it would be popped again
                // immediately, trip the reentry guard and end the tick for every
                // other operation. Hold it aside and restore it after the tick.
                if ((userOpInfo.retryAfter ?? 0) > Date.now()) {
                    deferred.push(userOpInfo)
                    continue
                }

                const { userOp } = userOpInfo

                // Check if we should skip this operation
                const skipResult = await this.shouldSkip({
                    userOpInfo,
                    paymasterDeposit,
                    stakedEntityCount,
                    knownEntities,
                    senders,
                    storageMap,
                    entryPoint
                })

                if (skipResult.skip) {
                    // Re-add to outstanding
                    if (!skipResult.removeOutstanding) {
                        userOpInfo.reentered = true
                        await this.store.addOutstanding({
                            entryPoint,
                            userOpInfo
                        })
                    }
                    continue
                }

                const beneficiary =
                    this.config.utilityPrivateKey?.address ||
                    privateKeyToAddress(generatePrivateKey())

                gasUsed += calculateAA95GasFloor({
                    userOps: [userOp],
                    beneficiary
                })
                if (userOp.eip7702Auth) {
                    eip7702Overhead += 40_000n
                }

                // Project the ACTUAL submitted tx gas (executor scales the floor
                // by 105%), not the raw floor, so the budget matches what the
                // node sees against the per-tx gas cap.
                const projectedGas = scaleBigIntByPercent(
                    gasUsed + eip7702Overhead,
                    105n
                )

                // Project the serialized tx byte size if this op is added.
                // O(n^2): re-serializes the growing candidate bundle per op.
                // Bounded by bundle size (gas cap keeps n small) and runs once
                // per bundling tick; switch to a running per-op size delta if
                // packing latency ever shows up in profiles.
                const candidateUserOps = [
                    ...currentBundle.userOps.map((info) => info.userOp),
                    userOp
                ]
                const projectedBytes = size(
                    getSerializedHandleOpsTx({
                        userOps: candidateUserOps,
                        entryPoint,
                        chainId: this.config.chainId,
                        removeZeros: false
                    })
                )

                const exceedsGas = projectedGas > gasCeiling
                const exceedsBytes = projectedBytes > byteThreshold

                // Only break once we have at least minOpsPerBundle ops; a lone
                // over-cap op is handled at ingress (rejected on proven-cap
                // chains) or by the executor (dropped on a ground-truth node
                // rejection) rather than black-holed here.
                if (
                    (exceedsGas || exceedsBytes) &&
                    currentBundle.userOps.length >= minOpsPerBundle
                ) {
                    this.logger.debug(
                        {
                            event: "userOpSkipped",
                            reason: exceedsBytes
                                ? "Bundle byte size limit exceeded"
                                : "Bundle gas limit exceeded",
                            userOpHash: userOpInfo.userOpHash,
                            projectedGas: projectedGas.toString(),
                            gasCeiling: gasCeiling.toString(),
                            projectedBytes,
                            byteThreshold
                        },
                        `Skipping userOp ${userOpInfo.userOpHash}, would exceed bundle cap.`
                    )

                    // Put the operation back in the store
                    userOpInfo.reentered = true
                    await this.store.addOutstanding({ entryPoint, userOpInfo })
                    break
                }

                // Update state based on skip result
                paymasterDeposit = skipResult.paymasterDeposit
                stakedEntityCount = skipResult.stakedEntityCount
                knownEntities = skipResult.knownEntities
                senders = skipResult.senders
                storageMap = skipResult.storageMap

                this.reputationManager.decreaseUserOpCount(userOp)
                userOpInfo.processingAt = Date.now()
                this.store.addProcessing({ entryPoint, userOpInfo })

                // Add op to current bundle
                currentBundle.userOps.push(userOpInfo)
            }

            if (currentBundle.userOps.length > 0) {
                bundles.push(currentBundle)
            }
        }

        for (const userOpInfo of deferred) {
            await this.store.addOutstanding({ entryPoint, userOpInfo })
        }

        return bundles
    }

    clear(): void {
        for (const entryPoint of this.config.entrypoints) {
            this.store.clearOutstanding(entryPoint)
        }
    }

    public async getQueuedOutstandingUserOps(args: {
        userOp: UserOperation
        entryPoint: Address
    }) {
        return await this.store.getQueuedOutstandingUserOps(args)
    }
}
