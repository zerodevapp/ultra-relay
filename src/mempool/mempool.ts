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
    getNonceKeyAndSequence,
    getSerializedHandleOpsTx,
    getUserOpHash,
    isVersion06,
    isVersion07,
    isVersion08,
    jsonStringifyWithBigint,
    minBigInt,
    scaleBigIntByPercent,
    stampLatest
} from "@alto/utils"
import { type Hex, getAddress, getContract, size, toHex } from "viem"
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts"
import type { AltoConfig } from "../createConfig"
import { bundleByteThreshold, getBundleCaps } from "../executor/bundleCaps"
import { calculateAA95GasFloor } from "../executor/utils"
import type { Monitor } from "./monitoring"
import {
    type InterfaceReputationManager,
    ReputationStatuses
} from "./reputationManager"

// Upstream #617's exact drop reason.
export const MAX_RESUBMITS_REASON = "max resubmits reached"

// The drop reasons we pass around carry revert data, so the metric label is
// reduced to a bounded set: the cap reason, an AAxx code, or "other" (ADR 0006).
export const dropReasonLabel = (reason: string): string =>
    reason === MAX_RESUBMITS_REASON
        ? MAX_RESUBMITS_REASON
        : (getAAError(reason) ?? "other")

// Resubmit reasons that are infrastructure failures: they never count toward
// max-resubmits and never drop a userOp. Every other reason is a counted
// failure. Upstream #617 counts every reason; we exempt our own outages
// because the 100 ms-1 s tick would otherwise drop every queued userOp within
// seconds of an RPC blip (see ADR 0006). Each string must match its call site
// exactly.
export const INFRASTRUCTURE_FAILURE_REASONS: ReadonlySet<string> = new Set([
    // executorManager.ts sendBundleToExecutor, nonce/gas fetch failed
    "Failed to get nonce and gas parameters for bundling",
    // executorManager.ts recoverFailedSend, no wallet acquired
    "wallet_acquisition_failed",
    // Executor.bundle result (send path and replacement)
    "insufficient_funds",
    // executorManager.ts rotateStuckBundle, detach write failed
    "stuck_bundle_detach_failed",
    // Mempool.process, onBundle hand-off threw
    "bundle_handoff_failed",
    // Executor.bundle send catch: a transport failure or rate limit in the
    // cause chain (see isSendTransportError)
    "send_transport_error"
])

// Held userOps make no bundles, so a pass ends at the first successor hold past
// this many, and the finally writes them all back.
// ponytail: a fixed count per pass; a time budget per pass is the upgrade path
// if held slots ever delay bundling noticeably.
const MAX_HELD_USEROPS_PER_PASS = 256

// How long a "not landed" chain-nonce answer (chain sequence below the
// candidate's) holds before the slot is read again.
// ponytail: a fixed age; refreshing on each new block is the upgrade path if
// held userOps wait noticeably longer than their predecessor's block.
const CHAIN_NONCE_CACHE_TTL_MS = 1_000

// How long a "landed" chain-nonce answer (chain sequence at or past the
// candidate's) releases the candidate without a new read. Far longer than one
// pass, so an orphan-held userOp is released on the next pass instead of being
// re-read every pass.
// ponytail: a fixed age rather than reorg-aware invalidation; tying entries to
// a block hash is the upgrade path if reorgs cause AA25 rejections.
const CHAIN_NONCE_LANDED_TTL_MS = 60_000

// Background getNonce reads in flight at once, across all nonce slots.
// ponytail: a fixed count; a multicall batch per pass is the upgrade path if
// held slots outnumber it for long.
const MAX_CONCURRENT_CHAIN_NONCE_READS = 16

// Cached on-chain nonce reads; past this, the oldest entry is evicted.
// ponytail: a fixed count with insertion-order eviction; an LRU is the upgrade
// path if hot slots get evicted while still held.
const MAX_CHAIN_NONCE_CACHE_ENTRIES = 1_024

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
    // Successor hold's on-chain nonce reads, keyed by entry point, sender and
    // nonce key. Kept across passes: the Mempool lives as long as the process.
    private chainNonceCache = new Map<
        string,
        { sequence: bigint; fetchedAt: number }
    >()
    private chainNonceReadsInFlight = new Set<string>()

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
        // allSettled: a failure is rethrown only once every op's writes have
        // settled, so the caller never tracks the bundle while a sibling's
        // submitted write is still in flight.
        const results = await Promise.allSettled(
            userOps.map(async (userOpInfo) => {
                const { userOpHash } = userOpInfo
                await this.store.removeProcessing({ entryPoint, userOpHash })
                // First value wins; see the stamp rule on userOpInfoSchema.
                userOpInfo.submittedAt ??= Date.now()
                await this.store.addSubmitted({ entryPoint, userOpInfo })
                await this.monitor.setUserOpStatus(userOpHash, {
                    status: "submitted",
                    transactionHash
                })
            })
        )
        const failure = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        )
        if (failure) {
            throw failure.reason
        }

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
        const counted = !INFRASTRUCTURE_FAILURE_REASONS.has(reason)
        const maxResubmits = this.config.maxResubmits

        // Re-add each nonce slot one userOp at a time in nonce order, so nonce
        // N is back in outstanding before N+1 can be popped. Slots run in
        // parallel.
        const nonceSlots = new Map<string, UserOpInfo[]>()
        for (const userOpInfo of userOps) {
            const { sender, nonce } = userOpInfo.userOp
            const [nonceKey] = getNonceKeyAndSequence(nonce)
            const slot = `${sender}-${nonceKey}`
            nonceSlots.set(slot, [...(nonceSlots.get(slot) ?? []), userOpInfo])
        }

        // A failed userOp does not stop the rest of its slot. The first error
        // is rethrown once every slot has settled.
        const errors: unknown[] = []
        await Promise.all(
            [...nonceSlots.values()].map(async (slotUserOps) => {
                slotUserOps.sort((a, b) => {
                    const [, aNonceSeq] = getNonceKeyAndSequence(a.userOp.nonce)
                    const [, bNonceSeq] = getNonceKeyAndSequence(b.userOp.nonce)
                    if (aNonceSeq === bNonceSeq) {
                        return 0
                    }
                    return aNonceSeq < bNonceSeq ? -1 : 1
                })

                for (const userOpInfo of slotUserOps) {
                    try {
                        await this.resubmitUserOp({
                            userOpInfo,
                            entryPoint,
                            reason,
                            counted,
                            maxResubmits
                        })
                    } catch (err) {
                        errors.push(err)
                    }
                }
            })
        )
        if (errors.length > 0) {
            throw errors[0]
        }

        this.metrics.userOperationsResubmitted
            .labels({ reason })
            .inc(userOps.length)
    }

    private async resubmitUserOp({
        userOpInfo,
        entryPoint,
        reason,
        counted,
        maxResubmits
    }: {
        userOpInfo: UserOpInfo
        entryPoint: Address
        reason: string
        counted: boolean
        maxResubmits: number
    }) {
        const { userOpHash, userOp, submissionAttempts } = userOpInfo

        // Mirrors upstream #617: check, then increment. Infrastructure
        // failures are exempt, which upstream does not do: they are our own
        // outages, and counting them would drop queued userOps within seconds
        // of an RPC blip (see ADR 0006).
        if (counted && submissionAttempts >= maxResubmits) {
            this.logger.warn(
                { userOpHash, submissionAttempts, maxResubmits, reason },
                `userOp ${userOpHash} dropped: max resubmits reached after ${reason}`
            )
            const rejectedUserOp = {
                ...userOpInfo,
                reason: MAX_RESUBMITS_REASON
            }
            // Not awaited, like the refused re-add drop below.
            this.dropUserOps(entryPoint, [rejectedUserOp]).catch((err) =>
                this.logger.error(
                    { err, userOpHash },
                    `failed to drop userOp ${userOpHash} after max resubmits reached`
                )
            )
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
        const [success, failureReason] = await this.add(userOp, entryPoint, {
            receivedAt: userOpInfo.receivedAt,
            reentry: true,
            submissionAttempts: counted
                ? submissionAttempts + 1
                : submissionAttempts
        })

        if (!success) {
            this.logger.error(
                { userOpHash, failureReason },
                `failed to re-add userOp ${userOpHash} during resubmission, dropping it`
            )
            const rejectedUserOp = {
                ...userOpInfo,
                reason: failureReason
            }
            // Deliberately not awaited, so every caller keeps the
            // resolve/reject behavior it has today; the catch keeps a
            // failed drop from escaping as an unhandled rejection.
            this.dropUserOps(entryPoint, [rejectedUserOp]).catch((err) =>
                this.logger.error(
                    { err, userOpHash },
                    `failed to drop userOp ${userOpHash} after its re-add was refused`
                )
            )
        }
    }

    async dropUserOps(entryPoint: Address, rejectedUserOps: RejectedUserOp[]) {
        await Promise.all(
            rejectedUserOps.map(async (rejectedUserOp) => {
                const { userOp, reason, userOpHash } = rejectedUserOp
                await this.store.removeProcessing({ entryPoint, userOpHash })
                await this.store.removeSubmitted({ entryPoint, userOpHash })
                this.eventManager.emitDropped(
                    userOpHash,
                    reason,
                    getAAError(reason)
                )
                this.metrics.userOperationsDropped
                    .labels({ reason: dropReasonLabel(reason) })
                    .inc()
                await this.monitor.setUserOpStatus(userOpHash, {
                    status: "rejected",
                    transactionHash: null
                })
                this.logger.warn(
                    {
                        userOperation: jsonStringifyWithBigint(userOp),
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
            receivedAt,
            reentry,
            submissionAttempts = 0
        }: {
            referencedContracts?: ReferencedCodeHashes
            receivedAt?: number
            reentry?: boolean
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

        await this.reputationManager.increaseUserOpSeenStatus(
            userOp,
            entryPoint
        )

        await this.store.addOutstanding({
            entryPoint,
            userOpInfo: {
                userOp,
                userOpHash,
                referencedContracts,
                receivedAt,
                addedToMempool: Date.now(),
                submissionAttempts,
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
    async shouldSkip({
        userOpInfo,
        paymasterDeposit,
        stakedEntityCount,
        knownEntities,
        senders,
        storageMap,
        entryPoint
    }: {
        userOpInfo: UserOpInfo
        paymasterDeposit: { [paymaster: string]: bigint }
        stakedEntityCount: { [addr: string]: number }
        knownEntities: {
            sender: Set<`0x${string}`>
            paymasters: Set<`0x${string}`>
            factories: Set<`0x${string}`>
        }
        senders: Set<string>
        storageMap: StorageMap
        entryPoint: Address
    }): Promise<{
        skip: boolean
        removeOutstanding?: boolean
        paymasterDeposit: { [paymaster: string]: bigint }
        stakedEntityCount: { [addr: string]: number }
        knownEntities: {
            sender: Set<`0x${string}`>
            paymasters: Set<`0x${string}`>
            factories: Set<`0x${string}`>
        }
        senders: Set<string>
        storageMap: StorageMap
    }> {
        if (!this.config.safeMode) {
            return {
                skip: false,
                paymasterDeposit,
                stakedEntityCount,
                knownEntities,
                senders,
                storageMap
            }
        }

        const { userOp, userOpHash, referencedContracts } = userOpInfo

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
            return {
                skip: true,
                removeOutstanding: true,
                paymasterDeposit,
                stakedEntityCount,
                knownEntities,
                senders,
                storageMap
            }
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
            return {
                skip: true,
                paymasterDeposit,
                stakedEntityCount,
                knownEntities,
                senders,
                storageMap
            }
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
            return {
                skip: true,
                paymasterDeposit,
                stakedEntityCount,
                knownEntities,
                senders,
                storageMap
            }
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
            return {
                skip: true,
                paymasterDeposit,
                stakedEntityCount,
                knownEntities,
                senders,
                storageMap
            }
        }

        let validationResult: ValidationResult & { storageMap: StorageMap }

        try {
            let queuedUserOps: UserOperation[] = []

            if (!isUserOpV06) {
                queuedUserOps = await this.getQueuedOutstandingUserOps({
                    userOp,
                    entryPoint
                })
            }

            validationResult = await this.validator.validateUserOp({
                userOp,
                queuedUserOps,
                entryPoint,
                referencedContracts
            })
        } catch (e) {
            this.logger.error(
                {
                    userOpHash,
                    error: JSON.stringify(e)
                },
                "2nd Validation error"
            )
            this.store.removeOutstanding({ entryPoint, userOpHash })
            this.reputationManager.decreaseUserOpSeenStatus(
                userOp,
                entryPoint,
                e instanceof RpcError ? e.message : JSON.stringify(e)
            )
            return {
                skip: true,
                paymasterDeposit,
                stakedEntityCount,
                knownEntities,
                senders,
                storageMap
            }
        }

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
                return {
                    skip: true,
                    paymasterDeposit,
                    stakedEntityCount,
                    knownEntities,
                    senders,
                    storageMap
                }
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
                return {
                    skip: true,
                    paymasterDeposit,
                    stakedEntityCount,
                    knownEntities,
                    senders,
                    storageMap
                }
            }
            stakedEntityCount[paymaster] =
                (stakedEntityCount[paymaster] ?? 0) + 1
            paymasterDeposit[paymaster] -= validationResult.returnInfo.prefund
        }

        if (factory) {
            stakedEntityCount[factory] = (stakedEntityCount[factory] ?? 0) + 1
        }

        senders.add(userOp.sender)

        return {
            skip: false,
            paymasterDeposit,
            stakedEntityCount,
            knownEntities,
            senders,
            storageMap
        }
    }

    // onBundle, when given, is called with each bundle the moment it is
    // complete, while the pass goes on packing. It must be synchronous and
    // return void: do not pass an async function. Normal return hands the
    // bundle's ownership to the callback; it may throw only before accepting
    // it. The returned array still lists every bundle, but for such a caller
    // it is informational only and must not be dispatched again.
    public async getBundles(
        maxBundleCount?: number,
        onBundle?: (bundle: UserOperationBundle) => void
    ): Promise<UserOperationBundle[]> {
        const bundlePromises = this.config.entrypoints.map(
            async (entryPoint) => {
                return await this.process({
                    entryPoint,
                    maxGasLimit: this.config.maxGasPerBundle,
                    minOpsPerBundle: 1,
                    maxBundleCount,
                    onBundle
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
        maxBundleCount,
        onBundle
    }: {
        maxGasLimit: bigint
        entryPoint: Address
        minOpsPerBundle: number
        maxBundleCount?: number
        onBundle?: (bundle: UserOperationBundle) => void
    }): Promise<UserOperationBundle[]> {
        // Check if there are any operations in the store
        const firstOp = await this.store.peekOutstanding(entryPoint)
        if (!firstOp) {
            return []
        }

        // Get EntryPoint version
        const bundles: UserOperationBundle[] = []
        const seenOps = new Set()
        let breakLoop = false
        // Set by the first pop that finds nothing ready. The loops used to
        // re-check with a peek before every pop, which on the Redis queue
        // cost two extra round trips per op; the pop already reports empty.
        let outstandingEmpty = false

        // Sender-and-nonce-key slots already placed in an EARLIER bundle of
        // this pass. Dispatch and execution can overlap across the bundles of
        // one pass (with onBundle, an earlier bundle is already in flight
        // while later ones are packed) and each is simulated on its own, so a
        // later nonce for one of these slots would fail AA25 before its
        // predecessor lands and be dropped as not-found. Such an op is handed
        // back and the pass ends; the next tick picks it up once the
        // predecessor has had a block.
        const slotsInPriorBundles = new Set<string>()

        // Successor hold and isolation are fork-only; upstream has neither
        // (see ADR 0006). A userOp whose immediate predecessor in its nonce
        // slot is still processing or submitted would fail AA25 if simulated
        // before that predecessor lands, so it waits for a later tick. A held
        // userOp is set aside here and written back once by the finally, not
        // at once: a write-back would let the store hand it back in this same
        // pass and trip the repeat guard below, so a sender with a chain in
        // flight would end every pass and stall every other sender until its
        // predecessor lands. Setting it aside also stops the later nonce the
        // store promotes when the held op is popped from slipping past: its
        // nonce slot stays held for the rest of the pass.
        const heldSlots = new Set<string>()
        const heldUserOps: UserOpInfo[] = []

        // A userOp deferred by a bundle cap is held here rather than written
        // back to outstanding: its hash is already in seenOps, so re-popping it
        // would trip the repeat guard below and end the whole pass with the
        // backlog untouched. The slot owns the op from deferral until it is
        // accepted or handed to skip handling; the finally at the bottom
        // returns anything still held, so an early exit or a throw in between
        // cannot drop it.
        let carriedUserOpInfo: UserOpInfo | undefined
        let isolationOverflowUsed = false
        // True once the extra bundle is open: it holds only the isolated
        // userOp, so nothing fresh is popped into it.
        let inOverflowBundle = false

        try {
            // Process operations until no more are available or we hit maxBundleCount
            while (carriedUserOpInfo || !outstandingEmpty) {
                // If maxBundles is set and we reached the limit, break
                if (maxBundleCount && bundles.length >= maxBundleCount) {
                    // Fork-only: a retried userOp carried for isolation gets
                    // one extra bundle per pass. A single-wallet relay
                    // (budget 1) would otherwise push it back every tick and
                    // never send it. Cost: that bundle waits for a wallet.
                    // The extra bundle holds only the isolated userOp: if it
                    // is released unaccepted, the pass ends. See ADR 0006.
                    const isolatedCarry =
                        carriedUserOpInfo !== undefined &&
                        carriedUserOpInfo.submissionAttempts > 0
                    if (!isolatedCarry || isolationOverflowUsed) {
                        break
                    }
                    isolationOverflowUsed = true
                    inOverflowBundle = true
                }

                if (breakLoop) {
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
                const processingWrites: Promise<void>[] = []
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
                // Nonce slot -> highest nonce sequence in this bundle. A slot
                // pops in nonce order, so the latest accepted is the highest.
                const currentBundleSlots = new Map<string, bigint>()

                // A carried userOp is no longer in outstanding, so the snapshot
                // above no longer lists its entities. Put them back so this
                // bundle evaluates candidates against the same entity set it
                // would have seen had the op stayed queued. The redis
                // outstanding store dumps an empty list, so there is no
                // snapshot to keep consistent there.
                const usesMemoryOutstanding = !(
                    this.config.enableHorizontalScaling &&
                    this.config.redisEndpoint
                )
                if (carriedUserOpInfo && usesMemoryOutstanding) {
                    const { userOp: carriedUserOp } = carriedUserOpInfo
                    const isCarriedV06 = isVersion06(carriedUserOp)

                    const carriedPaymaster = isCarriedV06
                        ? getAddressFromInitCodeOrPaymasterAndData(
                              carriedUserOp.paymasterAndData
                          )
                        : carriedUserOp.paymaster
                    const carriedFactory = isCarriedV06
                        ? getAddressFromInitCodeOrPaymasterAndData(
                              carriedUserOp.initCode
                          )
                        : carriedUserOp.factory

                    knownEntities.sender.add(carriedUserOp.sender)
                    if (carriedPaymaster) {
                        knownEntities.paymasters.add(carriedPaymaster)
                    }
                    if (carriedFactory) {
                        knownEntities.factories.add(carriedFactory)
                    }
                }

                // Keep adding ops to current bundle
                while (carriedUserOpInfo || !outstandingEmpty) {
                    let userOpInfo: UserOpInfo
                    let fromCarry = false

                    if (carriedUserOpInfo) {
                        // Selecting does not release ownership: the slot keeps
                        // the op through shouldSkip and the cap maths, so a
                        // throw in either is caught by the finally below.
                        // seenOps already holds this hash and must keep it, so
                        // that a later store pop of the same hash still trips
                        // the repeat guard.
                        userOpInfo = carriedUserOpInfo
                        fromCarry = true
                    } else {
                        if (inOverflowBundle) {
                            breakLoop = true
                            break
                        }
                        const poppedUserOpInfo =
                            await this.store.popOutstanding(entryPoint)
                        if (!poppedUserOpInfo) {
                            outstandingEmpty = true
                            break
                        }

                        if (seenOps.has(poppedUserOpInfo.userOpHash)) {
                            breakLoop = true
                            poppedUserOpInfo.reentered = true
                            await this.store.addOutstanding({
                                entryPoint,
                                userOpInfo: poppedUserOpInfo
                            })
                            break
                        }

                        seenOps.add(poppedUserOpInfo.userOpHash)
                        userOpInfo = poppedUserOpInfo
                    }

                    const { userOp } = userOpInfo

                    const [nonceKey, nonceSequence] = getNonceKeyAndSequence(
                        userOp.nonce
                    )
                    const nonceSlot = `${userOp.sender}-${nonceKey}`
                    if (slotsInPriorBundles.has(nonceSlot)) {
                        // Its predecessor sits in an earlier bundle of this
                        // pass. Release the carry slot before the write so the
                        // finally cannot write it a second time, then end the
                        // pass so the predecessor gets a block to land first.
                        carriedUserOpInfo = undefined
                        breakLoop = true
                        userOpInfo.reentered = true
                        await this.store.addOutstanding({
                            entryPoint,
                            userOpInfo
                        })
                        break
                    }

                    // Successor hold, for popped and carried candidates alike.
                    // A predecessor in the bundle being built does not hold,
                    // so consecutive nonces still pack together: their
                    // processing writes are not awaited until the bundle
                    // closes, so a lookup could see the predecessor and hold
                    // its own bundle-mate. It must be the exact predecessor:
                    // nonce N can be back in outstanding while N+1 is still
                    // processing, and N+2 must not join N's bundle then.
                    let isHeld = heldSlots.has(nonceSlot)
                    if (
                        !isHeld &&
                        nonceSequence > 0n &&
                        currentBundleSlots.get(nonceSlot) !== nonceSequence - 1n
                    ) {
                        isHeld = await this.isPredecessorPending({
                            entryPoint,
                            userOpInfo
                        })
                    }
                    if (isHeld) {
                        // The held list owns the op from here, so release the
                        // carry first: the finally must not write it twice.
                        carriedUserOpInfo = undefined
                        userOpInfo.reentered = true
                        heldUserOps.push(userOpInfo)

                        // Past the bound, end the pass like the bundle budget.
                        // This op is written back with the held ones.
                        if (heldUserOps.length > MAX_HELD_USEROPS_PER_PASS) {
                            breakLoop = true
                            break
                        }

                        heldSlots.add(nonceSlot)
                        this.logger.debug(
                            {
                                event: "userOpSuccessorHold",
                                userOpHash: userOpInfo.userOpHash,
                                sender: userOp.sender,
                                nonce: toHex(userOp.nonce)
                            },
                            `Holding userOp ${userOpInfo.userOpHash} until its predecessor in nonce slot ${nonceSlot} lands.`
                        )
                        continue
                    }

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
                        // Skip handling owns the op from here, so release the
                        // slot first: otherwise the finally would write it a
                        // second time.
                        carriedUserOpInfo = undefined

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

                    // Deferring a carried op back into the empty bundle it was
                    // just carried into would hand it straight back to the slot
                    // and spin forever. Only reachable with minOpsPerBundle<=0,
                    // which is outside the supported contract (getBundles
                    // passes 1), but a hang is not an acceptable failure mode.
                    const carryWouldSpin =
                        fromCarry && currentBundle.userOps.length === 0

                    // Only break once we have at least minOpsPerBundle ops; a lone
                    // over-cap op is handled at ingress (rejected on proven-cap
                    // chains) or by the executor (dropped on a ground-truth node
                    // rejection) rather than black-holed here.
                    if (
                        (exceedsGas || exceedsBytes) &&
                        currentBundle.userOps.length >= minOpsPerBundle &&
                        !carryWouldSpin
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

                        // Hold the op for the next bundle rather than writing it
                        // back: a write-back would be re-popped, trip the repeat
                        // guard above, and abort the rest of the pass.
                        carriedUserOpInfo = userOpInfo
                        break
                    }

                    // Isolation: a retried userOp goes out in a bundle of its
                    // own, so a bad userOp cannot keep failing its
                    // bundle-mates. Carried like a bundle-cap deferral, it
                    // opens the next bundle, which closes right after it.
                    const isRetried = userOpInfo.submissionAttempts > 0
                    if (isRetried && currentBundle.userOps.length > 0) {
                        this.logger.debug(
                            {
                                event: "userOpIsolated",
                                userOpHash: userOpInfo.userOpHash,
                                submissionAttempts:
                                    userOpInfo.submissionAttempts
                            },
                            `Isolating retried userOp ${userOpInfo.userOpHash} in a bundle of its own.`
                        )
                        carriedUserOpInfo = userOpInfo
                        break
                    }

                    // Update state based on skip result
                    paymasterDeposit = skipResult.paymasterDeposit
                    stakedEntityCount = skipResult.stakedEntityCount
                    knownEntities = skipResult.knownEntities
                    senders = skipResult.senders
                    storageMap = skipResult.storageMap

                    // Accepted: the bundle owns the op from here.
                    carriedUserOpInfo = undefined

                    this.reputationManager.decreaseUserOpCount(userOp)
                    userOpInfo.processingAt = Date.now()
                    processingWrites.push(
                        this.store.addProcessing({ entryPoint, userOpInfo })
                    )

                    // Add op to current bundle
                    currentBundle.userOps.push(userOpInfo)
                    currentBundleSlots.set(nonceSlot, nonceSequence)

                    // Isolation: nothing joins a retried userOp's bundle.
                    if (isRetried) {
                        break
                    }
                }

                // Land every processing write before the bundle is handed
                // over, so the executor's removeProcessing cannot run first
                // and leave an entry nothing removes.
                await Promise.all(processingWrites)

                if (currentBundle.userOps.length > 0) {
                    // Overwritten like processingAt; see the stamp rule on
                    // userOpInfoSchema.
                    stampLatest(currentBundle.userOps, "bundledAt", Date.now())
                    bundles.push(currentBundle)
                    for (const slot of currentBundleSlots.keys()) {
                        slotsInPriorBundles.add(slot)
                    }

                    // Hand the bundle over now, while the pass goes on to the
                    // next one, so its executor work (wallet, gas, simulate,
                    // broadcast) does not wait for the rest of the pass. The
                    // callback owns the bundle on normal return. A callback
                    // may throw only before accepting ownership. Requeue that
                    // bundle and let the existing finally restore the carry.
                    // Async executor recovery belongs to sendBundleToExecutor.
                    if (onBundle) {
                        try {
                            onBundle(currentBundle)
                        } catch (err) {
                            this.logger.error(
                                {
                                    err,
                                    userOpHashes: currentBundle.userOps.map(
                                        (userOpInfo) => userOpInfo.userOpHash
                                    )
                                },
                                "onBundle callback threw"
                            )
                            await this.resubmitUserOps({
                                entryPoint,
                                userOps: currentBundle.userOps,
                                reason: "bundle_handoff_failed"
                            })
                            throw err
                        }
                    }
                }
            }

            return bundles
        } finally {
            // Anything still held is ours to return: normal completion with a
            // carry, a maxBundleCount exit, or a throw from bundle setup or
            // candidate evaluation. Exactly one write for the carried op and
            // one for each successor hold, and never a return from finally. A
            // rejected write becomes the failure.
            const userOpInfos = carriedUserOpInfo
                ? [carriedUserOpInfo, ...heldUserOps]
                : heldUserOps
            carriedUserOpInfo = undefined
            await this.writeBackToOutstanding({ entryPoint, userOpInfos })
        }
    }

    // Successor hold: whether the userOp's immediate predecessor is still
    // processing or submitted. The store answers first. The chain is checked
    // only when the store says pending, because a pod that dies leaves its
    // entries behind until they are evicted (2 h processing, 24 h submitted)
    // while the predecessor itself usually lands a block later (see ADR 0006).
    // A pass never waits for the chain: a cached read answers while it is
    // fresh (a "landed" answer for CHAIN_NONCE_LANDED_TTL_MS, a "not landed"
    // one for CHAIN_NONCE_CACHE_TTL_MS), otherwise the userOp is held and a
    // background read refreshes the cache for a later pass. The chain nonce
    // only grows except under a chain reorganization, so a stale "not landed"
    // answer can only hold a userOp longer. A stale "landed" answer could
    // release one early only after a reorg, and bundle simulation then rejects
    // it with AA25.
    private async isPredecessorPending({
        entryPoint,
        userOpInfo
    }: {
        entryPoint: Address
        userOpInfo: UserOpInfo
    }): Promise<boolean> {
        const { userOp } = userOpInfo
        if (!(await this.store.hasPendingPredecessor({ entryPoint, userOp }))) {
            return false
        }

        const [nonceKey, nonceSequence] = getNonceKeyAndSequence(userOp.nonce)
        const cacheKey = `${entryPoint}-${userOp.sender}-${nonceKey}`
        const cached = this.chainNonceCache.get(cacheKey)
        if (cached) {
            const landed = cached.sequence >= nonceSequence
            const ttl = landed
                ? CHAIN_NONCE_LANDED_TTL_MS
                : CHAIN_NONCE_CACHE_TTL_MS
            if (Date.now() - cached.fetchedAt < ttl) {
                return !landed
            }
        }

        if (
            !this.chainNonceReadsInFlight.has(cacheKey) &&
            this.chainNonceReadsInFlight.size < MAX_CONCURRENT_CHAIN_NONCE_READS
        ) {
            const { userOpHash } = userOpInfo
            this.chainNonceReadsInFlight.add(cacheKey)
            // Not awaited: this pass holds, and a later one reads the cache.
            this.cacheChainNonce({ entryPoint, userOp, cacheKey })
                .catch((err) =>
                    this.logger.warn(
                        { err, userOpHash },
                        `failed to read the on-chain nonce for userOp ${userOpHash}, holding it`
                    )
                )
                .finally(() => this.chainNonceReadsInFlight.delete(cacheKey))
        }
        return true
    }

    // Reads EntryPoint.getNonce at latest, as rpcHandler.getNonceSeq does, and
    // caches the slot's sequence. A failed read rejects and caches nothing.
    private async cacheChainNonce({
        entryPoint,
        userOp,
        cacheKey
    }: {
        entryPoint: Address
        userOp: UserOperation
        cacheKey: string
    }): Promise<void> {
        const [nonceKey] = getNonceKeyAndSequence(userOp.nonce)
        const entryPointContract = getContract({
            address: entryPoint,
            abi: isVersion06(userOp) ? EntryPointV06Abi : EntryPointV07Abi,
            client: {
                public: this.config.publicClient
            }
        })
        const chainNonce = await entryPointContract.read.getNonce(
            [userOp.sender, nonceKey],
            { blockTag: "latest" }
        )
        const [, sequence] = getNonceKeyAndSequence(chainNonce)

        // Deleted first so Map order stays oldest fetch first.
        this.chainNonceCache.delete(cacheKey)
        this.chainNonceCache.set(cacheKey, { sequence, fetchedAt: Date.now() })
        if (this.chainNonceCache.size > MAX_CHAIN_NONCE_CACHE_ENTRIES) {
            const [oldestKey] = this.chainNonceCache.keys()
            this.chainNonceCache.delete(oldestKey)
        }
    }

    // One write per userOp, in order: held userOps are in pop order, so each
    // nonce slot goes back in nonce order. Every write is attempted, then the
    // first error is rethrown.
    private async writeBackToOutstanding({
        entryPoint,
        userOpInfos
    }: {
        entryPoint: Address
        userOpInfos: UserOpInfo[]
    }) {
        const errors: unknown[] = []
        for (const userOpInfo of userOpInfos) {
            try {
                await this.store.addOutstanding({ entryPoint, userOpInfo })
            } catch (err) {
                errors.push(err)
            }
        }
        if (errors.length > 0) {
            throw errors[0]
        }
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
