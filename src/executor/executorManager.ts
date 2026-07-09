import type { GasPriceManager } from "@alto/handlers"
import type { Mempool } from "@alto/mempool"
import type {
    BundlingMode,
    HexData32,
    SubmittedBundleInfo,
    UserOperationBundle
} from "@alto/types"
import type { GasPriceParameters } from "@alto/types"
import { type Logger, type Metrics, scaleBigIntByPercent } from "@alto/utils"
import {
    type Account,
    type Address,
    type Block,
    type Hex,
    type WatchBlocksReturnType,
    formatEther
} from "viem"
import type { AltoConfig } from "../createConfig"
import type { BundleManager } from "./bundleManager"
import type { Executor } from "./executor"
import type { SenderManager } from "./senderManager"
import { getUserOpHashes } from "./utils"

const SCALE_FACTOR = 10 // Interval increases by 10ms per task per minute
const RPM_WINDOW = 60000 // 1 minute window in ms

// While a rotated-away wallet is quarantined (its stuck nonce hasn't confirmed),
// emit an error log every this-many reconcile ticks so a permanently wedged
// wallet surfaces for alerting (~ this * blockTime between alerts).
const QUARANTINE_ALERT_INTERVAL_TICKS = 30

// A dropped-tx release (pending === latest) must be observed on this many
// consecutive reconcile ticks before returning the wallet, so a single stale or
// out-of-sync RPC node read can't release a wallet whose stuck tx is still in
// flight on another node.
const QUARANTINE_CLEAR_OBSERVATIONS_TO_RELEASE = 2

export class ExecutorManager {
    private senderManager: SenderManager
    private config: AltoConfig
    private executor: Executor
    private mempool: Mempool
    private logger: Logger
    private metrics: Metrics
    private gasPriceManager: GasPriceManager
    private opsCount: number[] = []
    private bundlingMode: BundlingMode
    private bundleManager: BundleManager
    private unWatch: WatchBlocksReturnType | undefined

    private currentlyHandlingBlock = false

    // Executor wallets rotated away from a stuck bundle whose cancel did not
    // confirm. Held out of the sender pool (markWalletProcessed deferred) until
    // their on-chain nonce advances past the stuck nonce, so no other instance
    // can pop an unconfirmed nonce and collide.
    private quarantinedWallets: Map<
        Address,
        {
            wallet: Account
            stuckNonce: number
            quarantinedAt: number
            ticks: number
            // Consecutive reconcile ticks observing no in-flight tx
            // (pending === latest). Debounced so a single stale/out-of-sync
            // RPC node read can't trigger a premature release.
            clearObservations: number
        }
    > = new Map()
    // Wallets rotated away and currently held in a background cancel that
    // hasn't settled yet. They are neither in the sender pool nor (yet) in
    // quarantinedWallets, so they must be counted alongside quarantines when
    // deciding whether another rotation is allowed — otherwise a broad stall
    // could rotate the whole pool into cancel before any failed cancel lands
    // in quarantinedWallets, bypassing the half-pool drain cap.
    private cancelsInFlight = new Set<Address>()
    private quarantineTimer: NodeJS.Timeout | undefined
    private reconciling = false

    constructor({
        config,
        executor,
        mempool,
        metrics,
        gasPriceManager,
        senderManager,
        bundleManager
    }: {
        config: AltoConfig
        executor: Executor
        mempool: Mempool
        metrics: Metrics
        gasPriceManager: GasPriceManager
        senderManager: SenderManager
        bundleManager: BundleManager
    }) {
        this.config = config
        this.executor = executor
        this.mempool = mempool
        this.logger = config.getLogger(
            { module: "executor_manager" },
            {
                level: config.executorLogLevel || config.logLevel
            }
        )
        this.metrics = metrics
        this.gasPriceManager = gasPriceManager
        this.senderManager = senderManager
        this.bundlingMode = this.config.bundleMode
        this.bundleManager = bundleManager

        if (this.bundlingMode === "auto") {
            this.autoScalingBundling()
        }
    }

    async setBundlingMode(bundleMode: BundlingMode): Promise<void> {
        this.bundlingMode = bundleMode

        if (bundleMode === "manual") {
            await new Promise((resolve) =>
                setTimeout(resolve, 2 * this.config.maxBundleInterval)
            )
        }

        if (bundleMode === "auto") {
            this.autoScalingBundling()
        }
    }

    async autoScalingBundling() {
        const now = Date.now()
        this.opsCount = this.opsCount.filter(
            (timestamp) => now - timestamp < RPM_WINDOW
        )

        const bundles = await this.mempool.getBundles()

        if (bundles.length > 0) {
            // Count total ops and add timestamps
            const totalOps = bundles.reduce(
                (sum, bundle) => sum + bundle.userOps.length,
                0
            )
            this.opsCount.push(...new Array(totalOps).fill(Date.now()))
        }

        // Send bundles to executor
        for (const bundle of bundles) {
            this.sendBundleToExecutor(bundle)
        }

        const rpm = this.opsCount.length

        // Calculate next interval with linear scaling
        const nextInterval: number = Math.min(
            this.config.minBundleInterval + rpm * SCALE_FACTOR, // Linear scaling
            this.config.maxBundleInterval // Cap at configured max interval
        )

        if (this.bundlingMode === "auto") {
            setTimeout(this.autoScalingBundling.bind(this), nextInterval)
        }
    }

    startWatchingBlocks(): void {
        if (this.unWatch) {
            return
        }

        // If preconfirmationTime is set, poll at intervals instead of watching blocks
        if (this.config.flashblocksPreconfirmationTime) {
            // Set up interval to call handleBlock
            const intervalId = setInterval(async () => {
                try {
                    await this.handleBlock()
                } catch (error) {
                    this.logger.error({ error }, "error while polling blocks")
                }
            }, this.config.flashblocksPreconfirmationTime)

            // Store cleanup function
            this.unWatch = () => {
                clearInterval(intervalId)
            }
        } else {
            // Default behavior - watch blocks
            this.unWatch = this.config.publicClient.watchBlocks({
                onBlock: async (block) => {
                    await this.handleBlock(block)
                },
                onError: (error) => {
                    this.logger.error({ error }, "error while watching blocks")
                },
                includeTransactions: false,
                emitMissed: false
            })
        }

        this.logger.debug("started watching blocks")
    }

    async getBaseFee(): Promise<bigint> {
        if (this.config.legacyTransactions) {
            return 0n
        }
        return await this.gasPriceManager.getBaseFee()
    }

    async sendBundleToExecutor(
        userOpBundle: UserOperationBundle
    ): Promise<Hex | undefined> {
        const { entryPoint, userOps, version } = userOpBundle
        if (userOps.length === 0) {
            return undefined
        }

        const wallet = await this.senderManager.getWallet()

        // Own userOp recovery on ANY unexpected throw so a single RPC failure
        // can't orphan them (this is invoked fire-and-forget by callers). The
        // known failure paths below still return cleanly; this only catches the
        // unexpected. bundleSubmitted prevents double-submitting a bundle that
        // was already tracked (handleBlock then owns its recovery).
        let bundleSubmitted = false
        try {
            const [gasPriceParams, baseFee, nonce] = await Promise.all([
                this.gasPriceManager.tryGetNetworkGasPrice(),
                this.getBaseFee(),
                this.config.publicClient.getTransactionCount({
                    address: wallet.address,
                    blockTag: "latest"
                })
            ]).catch((_) => {
                return []
            })

            if (!gasPriceParams || nonce === undefined) {
                // Free executor if failed to get initial params.
                await this.senderManager.markWalletProcessed(wallet)
                await this.mempool.resubmitUserOps({
                    userOps,
                    entryPoint,
                    reason: "Failed to get nonce and gas parameters for bundling"
                })
                return undefined
            }

            const bundleResult = await this.executor.bundle({
                executor: wallet,
                userOpBundle,
                networkGasPrice: gasPriceParams,
                networkBaseFee: baseFee,
                nonce
            })

            if (!bundleResult.success) {
                const { rejectedUserOps, recoverableOps, reason } = bundleResult

                // Recover any userOps that can be resubmitted.
                await this.mempool.resubmitUserOps({
                    userOps: recoverableOps,
                    entryPoint,
                    reason
                })

                // For rejected userOps, we need to check for frontruns
                const shouldCheckFrontrun = rejectedUserOps.some(
                    ({ reason }) =>
                        reason.includes("AA25 invalid account nonce") ||
                        reason.includes("AA10 sender already constructed")
                )

                if (shouldCheckFrontrun) {
                    // Check each rejected userOp for frontrun or included
                    const results = await Promise.all(
                        rejectedUserOps.map(async (userOpInfo) => ({
                            userOpInfo,
                            status: await this.bundleManager.getUserOpStatus({
                                userOpInfo,
                                entryPoint,
                                bundlerTxs: [],
                                blockReceivedTimestamp: Date.now()
                            })
                        }))
                    )

                    // Drop userOps that were rejected but not frontrun or included
                    const notFoundUserOps = results
                        .filter(({ status }) => status === "not_found")
                        .map(({ userOpInfo }) => userOpInfo)

                    await this.mempool.dropUserOps(entryPoint, notFoundUserOps)

                    // Stop tracking userOps that were included onchain either due to frontrun or included
                    const confirmedUserOps = results
                        .filter(({ status }) =>
                            ["frontran", "included"].includes(status)
                        )
                        .map(({ userOpInfo }) => userOpInfo)

                    await this.mempool.removeProcessingUserOps({
                        entryPoint,
                        userOps: confirmedUserOps
                    })
                } else {
                    this.logger.warn(
                        { reason },
                        "failed to send bundle transaction"
                    )

                    await this.mempool.dropUserOps(entryPoint, rejectedUserOps)
                }

                // Free wallet as no bundle was sent.
                await this.senderManager.markWalletProcessed(wallet)

                this.metrics.userOperationsSubmitted
                    .labels({ status: "failed" })
                    .inc(rejectedUserOps.length)

                if (
                    reason === "filterops_failed" ||
                    reason === "generic_error" ||
                    reason === "oversized_bundle"
                ) {
                    this.metrics.bundlesSubmitted
                        .labels({ status: "failed" })
                        .inc()
                }

                return undefined
            }

            // Success case
            let {
                userOpsBundled,
                rejectedUserOps,
                transactionRequest,
                transactionHash
            } = bundleResult

            // Increment submission attempts for all userOps submitted.
            userOpsBundled = userOpsBundled.map((userOpInfo) => ({
                ...userOpInfo,
                submissionAttempts: userOpInfo.submissionAttempts + 1
            }))

            const submittedBundle: SubmittedBundleInfo = {
                uid: transactionHash,
                executor: wallet,
                transactionHash,
                transactionRequest,
                bundle: {
                    entryPoint,
                    version,
                    userOps: userOpsBundled,
                    submissionAttempts: 1
                },
                previousTransactionHashes: [],
                lastReplaced: Date.now()
            }

            // Track bundle and start loop to watch blocks
            this.bundleManager.trackBundle(submittedBundle)
            bundleSubmitted = true
            this.startWatchingBlocks()

            await this.mempool.markUserOpsAsSubmitted({
                userOps: submittedBundle.bundle.userOps,
                entryPoint: submittedBundle.bundle.entryPoint,
                transactionHash: submittedBundle.transactionHash
            })

            await this.mempool.dropUserOps(entryPoint, rejectedUserOps)
            this.metrics.bundlesSubmitted.labels({ status: "success" }).inc()

            return transactionHash
        } catch (err) {
            this.logger.error(
                { err, executor: wallet.address },
                "unexpected error sending bundle to executor"
            )
            // Tx not submitted/tracked -> userOps are detached and unowned, so
            // free the wallet and requeue them rather than dropping them. If it
            // was already tracked, handleBlock owns recovery -> don't resubmit.
            if (!bundleSubmitted) {
                await this.senderManager
                    .markWalletProcessed(wallet)
                    .catch((e) =>
                        this.logger.error(
                            { err: e },
                            "failed to free wallet after send error"
                        )
                    )
                await this.mempool
                    .resubmitUserOps({
                        userOps,
                        entryPoint,
                        reason: "send_bundle_unexpected_error"
                    })
                    .catch((e) =>
                        this.logger.error(
                            { err: e },
                            "failed to resubmit userOps after send error"
                        )
                    )
            }
            return undefined
        }
    }

    stopWatchingBlocks(): void {
        if (this.unWatch) {
            this.unWatch()
            this.unWatch = undefined
        }
    }

    private async updateTransactionCostMetrics(
        transactionHash: HexData32,
        userOperationHashes: HexData32[],
        transactionStatus: string
    ) {
        try {
            const receipt =
                await this.config.publicClient.getTransactionReceipt({
                    hash: transactionHash
                })

            const l2GasCostTx = receipt.gasUsed * receipt.effectiveGasPrice

            // Handle L1 fee if present (for L2 chains like Optimism)
            let l1Fee = BigInt(0)
            if (
                "l1Fee" in receipt &&
                receipt.l1Fee !== undefined &&
                receipt.l1Fee !== null
            ) {
                l1Fee = BigInt(receipt.l1Fee.toString())
            }

            const actualCost = l2GasCostTx + l1Fee
            // Convert wei to ETH using viem's formatEther
            const actualCostInEth = Number(formatEther(actualCost))

            // Record cost for each userOp in the bundle since they share the transaction
            for (const userOpHash of userOperationHashes) {
                this.metrics.transactionCosts.set(
                    {
                        userOpHash,
                        transactionHash,
                        executor_wallet: receipt.from,
                        transaction_status: transactionStatus
                    },
                    actualCostInEth
                )
            }
        } catch (error) {
            this.logger.error(
                { error, transactionHash },
                "Failed to update transaction cost metrics"
            )
        }
    }

    private async handleBlock(block?: Block) {
        if (this.currentlyHandlingBlock) {
            return
        }

        this.currentlyHandlingBlock = true
        const blockReceivedTimestamp = Date.now()

        const pendingBundles = this.bundleManager.getPendingBundles()

        if (pendingBundles.length === 0) {
            this.stopWatchingBlocks()
            this.currentlyHandlingBlock = false
            return
        }

        const [bundleStatuses, networkGasPrice, networkBaseFee] =
            await Promise.all([
                this.bundleManager.getBundleStatuses(pendingBundles),
                this.gasPriceManager.tryGetNetworkGasPrice().catch(() => ({
                    maxFeePerGas: 0n,
                    maxPriorityFeePerGas: 0n
                })),
                this.getBaseFee().catch(() => 0n)
            ])

        await Promise.all(
            bundleStatuses.map(async (bundleStatus, index) => {
                const submittedBundle = pendingBundles[index]

                if (bundleStatus.status === "included") {
                    await this.bundleManager.processIncludedBundle({
                        submittedBundle,
                        bundleReceipt: bundleStatus,
                        blockReceivedTimestamp
                    })

                    // Track transaction costs for included bundles
                    await this.updateTransactionCostMetrics(
                        submittedBundle.transactionHash,
                        submittedBundle.bundle.userOps.map(
                            (op) => op.userOpHash
                        ),
                        bundleStatus.status
                    )
                }

                if (bundleStatus.status === "reverted") {
                    await this.bundleManager.processRevertedBundle({
                        blockReceivedTimestamp,
                        submittedBundle,
                        bundleReceipt: bundleStatus,
                        block
                    })

                    // Track transaction costs for reverted bundles
                    await this.updateTransactionCostMetrics(
                        submittedBundle.transactionHash,
                        submittedBundle.bundle.userOps.map(
                            (op) => op.userOpHash
                        ),
                        bundleStatus.status
                    )
                }

                // can be potentially resubmitted - so we first submit it again to optimize for the speed
                if (bundleStatus.status === "not_found") {
                    this.potentiallyResubmitBundle({
                        blockReceivedTimestamp,
                        submittedBundle,
                        networkGasPrice,
                        networkBaseFee
                    })
                }
            })
        )

        this.currentlyHandlingBlock = false
    }

    potentiallyResubmitBundle({
        blockReceivedTimestamp,
        submittedBundle,
        networkGasPrice,
        networkBaseFee
    }: {
        blockReceivedTimestamp: number
        submittedBundle: SubmittedBundleInfo
        networkGasPrice: {
            maxFeePerGas: bigint
            maxPriorityFeePerGas: bigint
        }
        networkBaseFee: bigint
    }) {
        const { transactionRequest, lastReplaced } = submittedBundle
        const { maxFeePerGas, maxPriorityFeePerGas } = transactionRequest

        const isGasPriceTooLow =
            maxFeePerGas < networkGasPrice.maxFeePerGas ||
            maxPriorityFeePerGas < networkGasPrice.maxPriorityFeePerGas

        const isStuck =
            Date.now() - lastReplaced > this.config.resubmitStuckTimeout

        if (!(isGasPriceTooLow || isStuck)) {
            return
        }

        // Cap concurrent quarantines at half the pool so a network-wide stall
        // (cancels also don't confirm) can't drain it.
        // ponytail: half the pool; make configurable if too coarse.
        const maxConcurrentQuarantine = Math.floor(
            this.senderManager.getAllWallets().length / 2
        )
        // Count wallets already quarantined AND those held in an unsettled
        // background cancel (each will either free or become quarantined) so a
        // burst of rotations can't drain past the cap before their cancels land.
        const canRotate =
            this.quarantinedWallets.size + this.cancelsInFlight.size <
            maxConcurrentQuarantine

        const rotate = () => {
            this.bundleManager.stopTrackingBundle(submittedBundle)
            this.rotateStuckBundle(submittedBundle).catch((err) =>
                this.logger.error(
                    { err },
                    "unhandled error rotating stuck bundle"
                )
            )
        }

        if (isGasPriceTooLow) {
            this.bundleManager.stopTrackingBundle(submittedBundle)
            this.replaceTransaction({
                blockReceivedTimestamp,
                submittedBundle,
                networkGasPrice,
                networkBaseFee,
                reason: "gas_price"
            })
            return
        }

        // isStuck: the RPC accepted our tx but the network isn't including it.
        // Bumping gas can't fix that and risks "replacement transaction
        // underpriced" churn on bor. After a few attempts, rotate onto a fresh
        // wallet + nonce instead.
        //
        // A bundle already pinned at the absolute cap can't be gas-escalated:
        // replaceTransaction would clamp back to the cap, fail bor's +10%
        // replacement rule, and free the wallet while the old tx is still
        // pending (nonce collision on reuse). Rotate immediately instead — a
        // fresh wallet gets a new nonce and a fresh sub-cap gas runway. If we
        // can't rotate (quarantine cap reached) we fall through to replace in
        // place: futile but transient and self-healing, unlike holding which
        // would strand the userOps forever.
        const { maxBundlingGasPrice } = this.config
        const atGasCap =
            maxBundlingGasPrice !== undefined &&
            maxFeePerGas >= maxBundlingGasPrice

        const shouldRotate =
            submittedBundle.bundle.submissionAttempts >=
                this.config.maxStuckAttemptsBeforeRotation || atGasCap

        if (shouldRotate) {
            if (canRotate) {
                rotate()
                return
            }

            this.logger.warn(
                {
                    event: "rotationDeferredQuarantineCap",
                    executor: submittedBundle.executor.address,
                    nonce: transactionRequest.nonce,
                    atGasCap,
                    quarantined: this.quarantinedWallets.size,
                    maxConcurrentQuarantine
                },
                "rotation deferred: quarantine cap reached, replacing in place"
            )
        }

        this.bundleManager.stopTrackingBundle(submittedBundle)
        this.replaceTransaction({
            blockReceivedTimestamp,
            submittedBundle,
            networkGasPrice,
            networkBaseFee,
            reason: "stuck"
        })
    }

    // Recover a bundle whose executor transaction is stuck (accepted by the RPC
    // but not being mined). Re-queue the userOps so they are rebundled on a
    // fresh wallet + nonce, and cancel the stuck transaction in the background
    // so it can't later mine as a wasteful duplicate.
    async rotateStuckBundle(
        submittedBundle: SubmittedBundleInfo
    ): Promise<void> {
        const { bundle, executor, transactionRequest, transactionHash } =
            submittedBundle
        const { entryPoint, userOps } = bundle

        this.logger.warn(
            {
                event: "rotatingStuckBundle",
                userOperations: getUserOpHashes(userOps),
                oldTxHash: transactionHash,
                nonce: transactionRequest.nonce,
                oldExecutor: executor.address,
                submissionAttempts: bundle.submissionAttempts
            },
            "rotating stuck bundle to a fresh executor wallet"
        )

        this.metrics.replacedTransactions
            .labels({ reason: "stuck", status: "rotated" })
            .inc()

        // Cancel the stuck transaction. Free the wallet ONLY if the cancel
        // confirms (nonce advanced past the stuck nonce); otherwise quarantine
        // it so no other instance can pop an unconfirmed nonce and collide.
        // Runs in the background so recovery isn't blocked on cancel. Track the
        // wallet as cancel-in-flight (added synchronously here, before the next
        // bundle in this tick is evaluated) so the rotation cap counts it, and
        // clear it once the cancel settles into a free/quarantine decision.
        this.cancelsInFlight.add(executor.address)
        this.cancelBundle(submittedBundle)
            .then((confirmed) => {
                if (confirmed) {
                    return this.senderManager
                        .markWalletProcessed(executor)
                        .catch((err) =>
                            this.logger.error(
                                { err, executor: executor.address },
                                "failed to free wallet after confirmed cancel"
                            )
                        )
                }
                this.quarantineWallet(executor, transactionRequest.nonce)
                return undefined
            })
            .catch((err) => {
                this.logger.error(
                    { err, executor: executor.address },
                    "error cancelling stuck bundle, quarantining wallet"
                )
                this.quarantineWallet(executor, transactionRequest.nonce)
            })
            .finally(() => {
                this.cancelsInFlight.delete(executor.address)
            })

        // Detach the userOps from the stuck (old) submitted bundle. If this
        // throws the ops were never handed off to the rebundle, so requeue them
        // here. Once sendBundleToExecutor is entered it owns userOp recovery on
        // every path (including unexpected throws), so no resubmit guard is
        // needed around it — guarding it too would double-handle ops it already
        // resubmitted/dropped/submitted.
        try {
            await this.mempool.removeSubmittedUserOps({ entryPoint, userOps })
        } catch (err) {
            this.logger.error(
                {
                    err,
                    userOperations: getUserOpHashes(userOps),
                    oldTxHash: transactionHash
                },
                "failed to detach stuck bundle, resubmitting userOps"
            )
            await this.mempool
                .resubmitUserOps({
                    userOps,
                    entryPoint,
                    reason: "stuck_bundle_detach_failed"
                })
                .catch((resubmitErr) =>
                    this.logger.error(
                        { err: resubmitErr },
                        "failed to resubmit userOps after detach failure"
                    )
                )
            return
        }

        // Re-bundle on a fresh wallet. The stuck wallet is still locked (freed
        // only after the cancel above), so getWallet() picks a different one and
        // the new tx uses a fresh nonce — no same-nonce bor replacement
        // constraint, so no gas floor is carried. Passing the existing bundle
        // preserves submissionAttempts, so the new tx starts at the already
        // escalated gas level (bounded by resubmitMultiplierCeiling) rather than
        // resetting to base — avoids a livelock under sustained network load.
        const newTxHash = await this.sendBundleToExecutor(bundle)

        this.logger.warn(
            {
                event: "rotatedStuckBundle",
                userOperations: getUserOpHashes(userOps),
                oldTxHash: transactionHash,
                oldExecutor: executor.address,
                newTxHash
            },
            newTxHash
                ? "stuck bundle rotated to a fresh executor wallet"
                : "stuck bundle rotation failed to submit on a fresh wallet"
        )
    }

    // Hold a rotated-away wallet out of the sender pool (markWalletProcessed
    // deferred) until its stuck nonce confirms on-chain, so no other instance
    // can pop an unconfirmed nonce and collide.
    private quarantineWallet(wallet: Account, stuckNonce: number): void {
        this.quarantinedWallets.set(wallet.address, {
            wallet,
            stuckNonce,
            quarantinedAt: Date.now(),
            ticks: 0,
            clearObservations: 0
        })
        this.metrics.executorWalletsQuarantined.set(
            this.quarantinedWallets.size
        )

        this.logger.warn(
            {
                event: "walletQuarantined",
                executor: wallet.address,
                stuckNonce
            },
            "executor wallet quarantined after failed cancel"
        )

        if (!this.quarantineTimer) {
            this.quarantineTimer = setInterval(
                () => this.reconcileQuarantinedWallets(),
                this.config.blockTime
            )
        }
    }

    // Poll quarantined wallets; release one back to the pool once its on-chain
    // nonce has advanced past the stuck nonce (cancel or original tx mined).
    // Watch-only: never force-frees a wallet whose nonce hasn't advanced.
    private async reconcileQuarantinedWallets(): Promise<void> {
        // Guard against overlapping runs if a tick takes longer than blockTime.
        if (this.reconciling) {
            return
        }
        this.reconciling = true
        try {
            await this.reconcileQuarantinedWalletsInner()
        } finally {
            this.reconciling = false
        }
    }

    private async reconcileQuarantinedWalletsInner(): Promise<void> {
        for (const [address, entry] of [...this.quarantinedWallets]) {
            const { wallet, stuckNonce, quarantinedAt } = entry

            const [latestNonce, pendingNonce] = await Promise.all([
                this.config.publicClient
                    .getTransactionCount({ address, blockTag: "latest" })
                    .catch(() => undefined),
                this.config.publicClient
                    .getTransactionCount({ address, blockTag: "pending" })
                    .catch(() => undefined)
            ])

            // RPC error — leave quarantined, retry next tick.
            if (latestNonce === undefined || pendingNonce === undefined) {
                continue
            }

            // Two ways it's safe to return the wallet:
            //  - buried on-chain: a tx at stuckNonce mined, so latest moved past
            //    it. On-chain proof, release immediately.
            //  - no tx in flight (pending === latest): the stuck tx was dropped
            //    from the mempool (it never advances the nonce, and the benched
            //    wallet sends nothing, so waiting on `latest > stuckNonce` would
            //    deadlock). Release, but only after observing "no in-flight" on
            //    several consecutive ticks, so one stale/out-of-sync RPC node
            //    read can't release while the tx is still pending elsewhere.
            const buriedOnChain = latestNonce > stuckNonce
            const noTxInFlight = pendingNonce === latestNonce

            if (buriedOnChain || noTxInFlight) {
                entry.clearObservations += 1
                if (
                    buriedOnChain ||
                    entry.clearObservations >=
                        QUARANTINE_CLEAR_OBSERVATIONS_TO_RELEASE
                ) {
                    this.quarantinedWallets.delete(address)
                    this.metrics.executorWalletsQuarantined.set(
                        this.quarantinedWallets.size
                    )
                    await this.senderManager
                        .markWalletProcessed(wallet)
                        .catch((err) =>
                            this.logger.error(
                                { err, executor: address },
                                "failed to release quarantined wallet"
                            )
                        )
                    this.logger.info(
                        {
                            event: "walletReleasedFromQuarantine",
                            executor: address,
                            stuckNonce,
                            latestNonce,
                            pendingNonce,
                            quarantinedTicks: entry.ticks
                        },
                        "executor wallet released from quarantine"
                    )
                }
                continue
            }

            // A tx is still in flight (pending > latest): reset the release
            // debounce and escalate periodically so a genuinely wedged wallet
            // surfaces for alerting (query: event:"walletQuarantineStuck").
            entry.clearObservations = 0
            entry.ticks += 1
            if (entry.ticks % QUARANTINE_ALERT_INTERVAL_TICKS === 0) {
                this.logger.error(
                    {
                        event: "walletQuarantineStuck",
                        executor: address,
                        stuckNonce,
                        latestNonce,
                        pendingNonce,
                        quarantinedTicks: entry.ticks,
                        quarantinedMs: Date.now() - quarantinedAt
                    },
                    "executor wallet stuck in quarantine — manual intervention may be required"
                )
            }
        }

        if (this.quarantinedWallets.size === 0 && this.quarantineTimer) {
            clearInterval(this.quarantineTimer)
            this.quarantineTimer = undefined
        }
    }

    async cancelBundle(submittedBundle: SubmittedBundleInfo): Promise<boolean> {
        const {
            bundle: { userOps },
            executor,
            transactionRequest,
            transactionHash
        } = submittedBundle

        const { walletClients, publicClient, cancelTransactionTimeout } =
            this.config
        const walletClient = walletClients.public
        const logger = this.logger.child({
            userOps: getUserOpHashes(userOps)
        })

        // Poll for the stuck nonce to clear (the cancel tx OR the original tx
        // mining both advance it) across the whole cancelTransactionTimeout,
        // re-broadcasting the cancel at an escalating gas price a bounded number
        // of times. The window MUST exceed the chain's real inclusion latency:
        // waiting only a couple of blocks (the previous behaviour) is far too
        // short on slow-inclusion chains and quarantines wallets whose cancel
        // simply hadn't mined yet. Sends are capped so gas can't run away.
        const MAX_CANCEL_ATTEMPTS = 5
        const pollInterval = Math.floor(
            cancelTransactionTimeout / MAX_CANCEL_ATTEMPTS
        )

        // Treat an RPC failure as "not yet cleared" rather than letting it
        // reject cancelBundle: both the in-loop and post-loop checks route
        // through here, so a transient read error just triggers another poll
        // (or a clean false at the deadline) instead of a spurious quarantine.
        const nonceCleared = async () => {
            try {
                const currentNonce = await publicClient.getTransactionCount({
                    address: executor.address,
                    blockTag: "latest"
                })
                return currentNonce > transactionRequest.nonce
            } catch (err) {
                logger.warn(
                    { error: err },
                    "failed to read nonce while cancelling bundle"
                )
                return false
            }
        }

        let gasMultiplier = 150n // Start with 50% increase

        for (let attempt = 0; attempt < MAX_CANCEL_ATTEMPTS; attempt++) {
            try {
                if (await nonceCleared()) {
                    logger.info("Transaction already mined or cancelled")
                    return true
                }

                logger.info(`Trying to cancel bundle, attempt ${attempt + 1}`)

                const cancelTxHash = await walletClient.sendTransaction({
                    account: executor,
                    to: executor.address,
                    value: 0n,
                    nonce: transactionRequest.nonce,
                    maxFeePerGas: scaleBigIntByPercent(
                        transactionRequest.maxFeePerGas,
                        gasMultiplier
                    ),
                    maxPriorityFeePerGas: scaleBigIntByPercent(
                        transactionRequest.maxPriorityFeePerGas,
                        gasMultiplier
                    )
                })

                logger.info(
                    {
                        originalTxHash: transactionHash,
                        cancelTxHash,
                        attempt: attempt + 1
                    },
                    "cancel transaction sent"
                )
            } catch (err) {
                logger.warn({ error: err }, "failed to cancel bundle")
            }

            // Escalate every re-broadcast (not just on error) so each resend
            // strictly outbids the last and satisfies bor's +10% replacement
            // rule instead of failing "replacement transaction underpriced".
            gasMultiplier += 20n
            await new Promise((resolve) => setTimeout(resolve, pollInterval))
        }

        // The final cancel may have mined during the closing wait.
        if (await nonceCleared()) {
            logger.info("Transaction already mined or cancelled")
            return true
        }

        logger.error(
            { transactionHash },
            "failed to cancel bundle after timeout"
        )
        return false
    }

    async replaceTransaction({
        blockReceivedTimestamp,
        submittedBundle,
        networkGasPrice,
        networkBaseFee,
        reason
    }: {
        blockReceivedTimestamp: number
        submittedBundle: SubmittedBundleInfo
        networkGasPrice: GasPriceParameters
        networkBaseFee: bigint
        reason: "gas_price" | "stuck"
    }): Promise<void> {
        this.logger.warn(
            {
                event: "replacingStuckTx",
                reason: reason,
                oldTxHash: submittedBundle.transactionHash,
                nonce: submittedBundle.transactionRequest.nonce,
                executor: submittedBundle.executor.address,
                submissionAttempts: submittedBundle.bundle.submissionAttempts
            },
            `Attempting to replace transaction ${submittedBundle.transactionHash} due to: ${reason}`
        )

        const {
            bundle,
            executor,
            transactionRequest,
            transactionHash: oldTxHash
        } = submittedBundle

        const { entryPoint } = bundle

        const bundleResult = await this.executor.bundle({
            executor: executor,
            networkGasPrice,
            networkBaseFee,
            userOpBundle: bundle,
            nonce: transactionRequest.nonce,
            // Floor the new bid to the previous tx's fee caps + bump so bor
            // accepts the replacement (avoids "replacement transaction
            // underpriced" when the network price has dipped).
            previousTransactionRequest: transactionRequest
        })

        // Handle case where no bundle was sent.
        if (!bundleResult.success) {
            const { rejectedUserOps, recoverableOps, reason } = bundleResult

            // Recover any userOps that can be resubmitted.
            await this.mempool.resubmitUserOps({
                userOps: recoverableOps,
                entryPoint,
                reason
            })

            // For rejected userOps, we need to check for frontruns
            const shouldCheckFrontrun = rejectedUserOps.some(
                ({ reason }) =>
                    reason.includes("AA25 invalid account nonce") ||
                    reason.includes("AA10 sender already constructed")
            )

            if (shouldCheckFrontrun) {
                // Check each rejected userOp for frontrun or included
                const results = await Promise.all(
                    rejectedUserOps.map(async (userOpInfo) => ({
                        userOpInfo,
                        status: await this.bundleManager.getUserOpStatus({
                            userOpInfo,
                            entryPoint,
                            bundlerTxs: [
                                submittedBundle.transactionHash,
                                ...submittedBundle.previousTransactionHashes
                            ],
                            blockReceivedTimestamp
                        })
                    }))
                )

                const hasFrontrun = results.some(
                    ({ status }) => status === "frontran"
                )

                // If one userOp in the bundle was frontrun, we need to cancel the entire bundle
                // as it will fail onchain
                if (hasFrontrun) {
                    await this.cancelBundle(submittedBundle)
                }

                // Drop userOps that were rejected but not frontrun or included
                const notFoundUserOps = results
                    .filter(({ status }) => status === "not_found")
                    .map(({ userOpInfo }) => userOpInfo)

                await this.mempool.dropUserOps(entryPoint, notFoundUserOps)

                // Stop tracking userOps that were included onchain either due to frontrun or included
                const confirmedUserOps = results
                    .filter(({ status }) =>
                        ["frontran", "included"].includes(status)
                    )
                    .map(({ userOpInfo }) => userOpInfo)

                await this.mempool.removeSubmittedUserOps({
                    entryPoint,
                    userOps: confirmedUserOps
                })
            } else {
                this.logger.warn(
                    { oldTxHash, reason },
                    "failed to replace transaction"
                )

                await this.mempool.dropUserOps(entryPoint, rejectedUserOps)
            }

            // Free wallet as no bundle was sent.
            await this.senderManager.markWalletProcessed(executor)

            this.metrics.replacedTransactions
                .labels({ reason, status: "failed" })
                .inc()

            return
        }

        // Success case
        const {
            rejectedUserOps,
            userOpsBundled,
            transactionRequest: newTransactionRequest,
            transactionHash: newTxHash
        } = bundleResult

        // Increment submission attempts for all replaced userOps
        const userOpsReplaced = userOpsBundled.map((userOpInfo) => ({
            ...userOpInfo,
            submissionAttempts: userOpInfo.submissionAttempts + 1
        }))

        const newTxInfo: SubmittedBundleInfo = {
            ...submittedBundle,
            transactionRequest: newTransactionRequest,
            transactionHash: newTxHash,
            previousTransactionHashes: [
                submittedBundle.transactionHash,
                ...submittedBundle.previousTransactionHashes
            ],
            lastReplaced: Date.now(),
            bundle: {
                ...bundle,
                userOps: userOpsReplaced,
                submissionAttempts: bundle.submissionAttempts + 1
            }
        }

        // Track bundle and start loop to watch blocks
        this.bundleManager.trackBundle(newTxInfo)
        this.startWatchingBlocks()

        // Drop all userOperations that were rejected during simulation.
        await this.mempool.dropUserOps(entryPoint, rejectedUserOps)

        this.logger.info(
            {
                oldTxHash,
                newTxHash,
                reason
            },
            "replaced transaction"
        )
        this.metrics.replacedTransactions
            .labels({ reason, status: "success" })
            .inc()

        return
    }
}
