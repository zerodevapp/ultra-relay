import type {
    UserOpInfo,
    UserOperation06,
    UserOperationBundle
} from "@alto/types"
import type { Address, Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ExecutorManager, summarizePass } from "./executorManager"
import { computeInclusionTimings } from "./inclusionTimings"
import { WalletNotFoundError } from "./senderManager"

// Importing ExecutorManager reaches utils/logger, which builds a Logtail
// transport at module load when BETTER_STACK_TOKEN is set. vi.hoisted runs
// before the imports above, so clearing it here keeps the test from opening
// one. Set to an empty string rather than deleted: biome's noDelete rule
// forbids the delete operator, and an empty string is falsy so the guard
// still skips building the transport (assigning undefined would instead
// store the truthy string "undefined").
vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

// Chains that only produce a block per transaction deadlock a block-driven
// reconciler. These cover the timer that breaks that loop.
//
// Wallet release lives in BundleManager.processIncludedBundle.
// These tests assert that timer-driven reconciliation delegates included
// bundles to that boundary.

const RESUBMIT_STUCK_TIMEOUT = 10_000
const BLOCK_TIME = 1000

const noopLogger = () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
})

// Matches networkGasPrice below, so isGasPriceTooLow stays false and only the
// stuck path can fire.
const createBundle = (overrides: Record<string, unknown> = {}) => ({
    uid: "0xbundle",
    transactionHash: "0xtx",
    previousTransactionHashes: [],
    transactionRequest: {
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        nonce: 0
    },
    bundle: {
        entryPoint: "0xentrypoint",
        version: "0.7",
        userOps: [{ userOpHash: "0xuserop" }],
        submissionAttempts: 1
    },
    executor: { address: "0xexecutor" },
    lastReplaced: Date.now(),
    ...overrides
})

const createHarness = (bundles: unknown[] = [createBundle()]) => {
    // Captured so a test can emit a block the way watchBlocks would.
    let onBlock: ((block: unknown) => Promise<void>) | undefined
    const unwatch = vi.fn()

    let pendingBundles = [...bundles]

    const getBundleStatuses = vi.fn().mockResolvedValue([])
    const processIncludedBundle = vi.fn(
        ({ submittedBundle }: { submittedBundle: unknown }) => {
            pendingBundles = pendingBundles.filter((b) => b !== submittedBundle)
        }
    )

    const bundleManager = {
        getPendingBundles: vi.fn(() => pendingBundles),
        getBundleStatuses,
        processIncludedBundle,
        processRevertedBundle: vi.fn(),
        stopTrackingBundle: vi.fn()
    }

    const watchBlocks = vi.fn(
        (args: { onBlock: (block: unknown) => Promise<void> }) => {
            onBlock = args.onBlock
            return unwatch
        }
    )

    const config = {
        bundleMode: "manual",
        blockTime: BLOCK_TIME,
        resubmitStuckTimeout: RESUBMIT_STUCK_TIMEOUT,
        flashblocksPreconfirmationTime: undefined,
        maxStuckAttemptsBeforeRotation: 3,
        maxBundlingGasPrice: undefined,
        // Keeps getBaseFee() off the network.
        legacyTransactions: true,
        logLevel: "info",
        executorLogLevel: "info",
        getLogger: () => noopLogger(),
        publicClient: {
            watchBlocks
        }
    }

    const executorManager = new ExecutorManager({
        // Narrow stubs: only the block-reconcile path is under test.
        config: config as any,
        executor: {} as any,
        mempool: {} as any,
        metrics: { transactionCosts: { set: vi.fn() } } as any,
        gasPriceManager: {
            tryGetNetworkGasPrice: vi.fn().mockResolvedValue({
                maxFeePerGas: 1n,
                maxPriorityFeePerGas: 1n
            })
        } as any,
        senderManager: { getAllWallets: () => [] } as any,
        bundleManager: bundleManager as any,
        requestShutdown: vi.fn()
    })

    // Stops at the replacement decision: everything past it needs a real
    // executor and store.
    const replaceTransaction = vi
        .spyOn(executorManager as any, "replaceTransaction")
        .mockImplementation(() => undefined)

    return {
        executorManager,
        getBundleStatuses,
        processIncludedBundle,
        replaceTransaction,
        watchBlocks,
        unwatch,
        getPending: () => pendingBundles,
        emitBlock: async (number = 1n) => {
            await onBlock?.({ number, baseFeePerGas: 1n })
        }
    }
}

const includedStatus = {
    status: "included",
    userOpReceipts: {},
    transactionHash: "0xtx",
    blockNumber: 2n,
    // handleBlockInner passes this to updateTransactionCostMetrics, which
    // destructures it before its own try.
    receipt: {
        transactionHash: "0xtx",
        from: "0xexecutor",
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n
    }
}

describe("ExecutorManager stale block watchdog", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        return () => vi.useRealTimers()
    })

    it("replaces a stuck bundle when no new block arrives", async () => {
        const { executorManager, getBundleStatuses, replaceTransaction } =
            createHarness()

        getBundleStatuses.mockResolvedValue([{ status: "not_found" }])

        executorManager.startWatchingBlocks()

        // No block ever emitted. Was a permanent stall before the watchdog.
        expect(getBundleStatuses).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)

        expect(replaceTransaction).toHaveBeenCalledWith(
            expect.objectContaining({ reason: "stuck" })
        )
    })

    it("releases a bundle that lands while blocks are stalled", async () => {
        const {
            executorManager,
            getBundleStatuses,
            processIncludedBundle,
            emitBlock,
            getPending
        } = createHarness()

        // Not yet included, and this is the last block the chain produces.
        getBundleStatuses
            .mockResolvedValueOnce([{ status: "not_found" }])
            .mockResolvedValueOnce([includedStatus])

        executorManager.startWatchingBlocks()
        await emitBlock()

        expect(processIncludedBundle).not.toHaveBeenCalled()
        expect(getPending()).toHaveLength(1)

        // Only the watchdog can see the inclusion now.
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT)

        expect(processIncludedBundle).toHaveBeenCalled()
        expect(getPending()).toHaveLength(0)
    })

    it("stays idle while blocks keep arriving", async () => {
        const { executorManager, getBundleStatuses, emitBlock } =
            createHarness()

        executorManager.startWatchingBlocks()

        // Fresh lastReconcileAt -> watchdog adds no reconciles of its own.
        const ticks = RESUBMIT_STUCK_TIMEOUT / BLOCK_TIME + 2
        for (let i = 0; i < ticks; i++) {
            await emitBlock(BigInt(i))
            await vi.advanceTimersByTimeAsync(BLOCK_TIME)
        }

        expect(getBundleStatuses).toHaveBeenCalledTimes(ticks)
    })

    it("lets a block just before the deadline push it out", async () => {
        const { executorManager, getBundleStatuses, emitBlock } =
            createHarness()

        executorManager.startWatchingBlocks()

        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT - BLOCK_TIME)
        expect(getBundleStatuses).not.toHaveBeenCalled()

        await emitBlock()
        expect(getBundleStatuses).toHaveBeenCalledTimes(1)

        // Deadline moved with the block, so no watchdog reconcile yet.
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT - BLOCK_TIME)
        expect(getBundleStatuses).toHaveBeenCalledTimes(1)
    })

    it("treats elapsed exactly equal to the timeout as stuck", async () => {
        const { executorManager, getBundleStatuses, replaceTransaction } =
            createHarness([createBundle({ lastReplaced: Date.now() })])

        getBundleStatuses.mockResolvedValue([{ status: "not_found" }])

        executorManager.startWatchingBlocks()

        // lastReconcileAt and lastReplaced are seeded from the same
        // Date.now(), so the first tick past the watchdog deadline has
        // elapsed == timeout exactly. `>` skips it, and the reconcile it
        // performs resets lastReconcileAt, pushing the retry a full window
        // out rather than losing it.
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT)

        expect(replaceTransaction).toHaveBeenCalled()
    })

    it("leaves a bundle one ms short of the timeout alone", async () => {
        const { executorManager, getBundleStatuses, replaceTransaction } =
            createHarness([createBundle({ lastReplaced: Date.now() + 1 })])

        getBundleStatuses.mockResolvedValue([{ status: "not_found" }])

        executorManager.startWatchingBlocks()

        // Watchdog fires (its own deadline is met) but elapsed is timeout - 1.
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT)

        expect(getBundleStatuses).toHaveBeenCalled()
        expect(replaceTransaction).not.toHaveBeenCalled()
    })

    it("keeps reconciling after a failed block tick", async () => {
        const { executorManager, getBundleStatuses, emitBlock } =
            createHarness()

        getBundleStatuses.mockRejectedValueOnce(new Error("store unavailable"))

        executorManager.startWatchingBlocks()

        // A throw used to leave currentlyHandlingBlock set forever.
        await emitBlock().catch(() => undefined)
        await emitBlock()

        expect(getBundleStatuses).toHaveBeenCalledTimes(2)
    })

    it("keeps reconciling after a failed watchdog tick", async () => {
        const { executorManager, getBundleStatuses } = createHarness()

        getBundleStatuses.mockRejectedValueOnce(new Error("store unavailable"))

        executorManager.startWatchingBlocks()

        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)
        expect(getBundleStatuses).toHaveBeenCalledTimes(1)

        // The rejection is caught inside the timer, so the guard must clear.
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)
        expect(getBundleStatuses).toHaveBeenCalledTimes(2)
    })

    it("runs one reconcile when a block lands mid watchdog tick", async () => {
        const { executorManager, getBundleStatuses, emitBlock } =
            createHarness()

        // Never settles, so the watchdog's reconcile is still in flight.
        getBundleStatuses.mockReturnValue(new Promise(() => undefined))

        executorManager.startWatchingBlocks()

        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)
        expect(getBundleStatuses).toHaveBeenCalledTimes(1)

        await emitBlock()

        // currentlyHandlingBlock must gate the overlapping tick.
        expect(getBundleStatuses).toHaveBeenCalledTimes(1)
    })

    it("handles a mixed batch of pending bundles", async () => {
        const included = createBundle({ uid: "0xincluded" })
        const stuck = createBundle({ uid: "0xstuck" })

        const {
            executorManager,
            getBundleStatuses,
            processIncludedBundle,
            replaceTransaction,
            getPending
        } = createHarness([included, stuck])

        // Index-aligned with getPendingBundles().
        getBundleStatuses.mockResolvedValue([
            includedStatus,
            { status: "not_found" }
        ])

        executorManager.startWatchingBlocks()
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)

        expect(processIncludedBundle).toHaveBeenCalledWith(
            expect.objectContaining({ submittedBundle: included })
        )
        expect(replaceTransaction).toHaveBeenCalledWith(
            expect.objectContaining({ submittedBundle: stuck })
        )
        expect(getPending()).toEqual([stuck])
    })

    it("stops watching once the last pending bundle is resolved", async () => {
        const { executorManager, getBundleStatuses, unwatch, getPending } =
            createHarness()

        getBundleStatuses.mockResolvedValueOnce([includedStatus])

        executorManager.startWatchingBlocks()

        // First window reconciles and the bundle lands.
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)
        expect(getPending()).toHaveLength(0)

        const callsAfterDrain = getBundleStatuses.mock.calls.length

        // That tick entered with a pending bundle, so the empty-set branch
        // only runs a window later.
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)
        expect(unwatch).toHaveBeenCalled()

        // Timer cleared too, else it spins for the process lifetime.
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT * 3)
        expect(getBundleStatuses.mock.calls).toHaveLength(callsAfterDrain)
    })

    it("clears the watchdog when the watcher stops", async () => {
        const { executorManager, getBundleStatuses, unwatch } = createHarness()

        executorManager.startWatchingBlocks()
        executorManager.stopWatchingBlocks()

        expect(unwatch).toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT * 3)

        expect(getBundleStatuses).not.toHaveBeenCalled()
    })

    it("does not stack watchers or timers on restart", async () => {
        const { executorManager, getBundleStatuses, watchBlocks } =
            createHarness()

        executorManager.startWatchingBlocks()
        executorManager.startWatchingBlocks()
        expect(watchBlocks).toHaveBeenCalledTimes(1)

        executorManager.stopWatchingBlocks()
        executorManager.startWatchingBlocks()
        expect(watchBlocks).toHaveBeenCalledTimes(2)

        // Two timers would reconcile twice in one window.
        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)
        expect(getBundleStatuses).toHaveBeenCalledTimes(1)
    })
})

type UpdateTransactionCostMetrics = (
    receipt: unknown,
    userOpHashes: Hex[],
    transactionStatus: string
) => void

// The method touches only this.logger and this.metrics, so it can be
// exercised against a stand-in rather than a fully wired manager.
const updateTransactionCostMetrics = (
    ExecutorManager.prototype as unknown as {
        updateTransactionCostMetrics: UpdateTransactionCostMetrics
    }
).updateTransactionCostMetrics

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex

const MINED = hash(1)
const USER_OP_A = hash(9)
const USER_OP_B = hash(10)
const EXECUTOR = "0x000000000000000000000000000000000000dead"

// 21_000 gas at 1 gwei = 0.000021 ETH
const minedReceipt = {
    transactionHash: MINED,
    from: EXECUTOR,
    gasUsed: 21_000n,
    effectiveGasPrice: 1_000_000_000n
}

const makeManager = () => {
    const set = vi.fn()
    const warn = vi.fn()
    const error = vi.fn()

    return {
        set,
        warn,
        error,
        manager: {
            logger: { warn, error },
            metrics: { transactionCosts: { set } }
        }
    }
}

describe("updateTransactionCostMetrics", () => {
    it("labels the gauge with the mined hash and the executor wallet", () => {
        const { manager, set } = makeManager()

        updateTransactionCostMetrics.call(
            manager,
            minedReceipt,
            [USER_OP_A],
            "included"
        )

        expect(set).toHaveBeenCalledTimes(1)
        expect(set).toHaveBeenCalledWith(
            {
                userOpHash: USER_OP_A,
                transactionHash: MINED,
                executor_wallet: EXECUTOR,
                transaction_status: "included"
            },
            0.000021
        )
    })

    it("writes one sample per userOp sharing cost and hash", () => {
        const { manager, set } = makeManager()

        updateTransactionCostMetrics.call(
            manager,
            minedReceipt,
            [USER_OP_A, USER_OP_B],
            "included"
        )

        expect(set).toHaveBeenCalledTimes(2)
        expect(set.mock.calls.map(([labels]) => labels.userOpHash)).toEqual([
            USER_OP_A,
            USER_OP_B
        ])
        for (const [labels, value] of set.mock.calls) {
            expect(labels.transactionHash).toBe(MINED)
            expect(value).toBe(0.000021)
        }
    })

    it("still records cost for a reverted bundle", () => {
        const { manager, set } = makeManager()

        updateTransactionCostMetrics.call(
            manager,
            { ...minedReceipt, status: "reverted" },
            [USER_OP_A],
            "reverted"
        )

        expect(set).toHaveBeenCalledTimes(1)
        expect(set.mock.calls[0][0].transaction_status).toBe("reverted")
        expect(set.mock.calls[0][1]).toBe(0.000021)
    })

    it("warns and records nothing when the receipt has no gas price", () => {
        const { manager, set, warn, error } = makeManager()

        updateTransactionCostMetrics.call(
            manager,
            {
                transactionHash: MINED,
                from: EXECUTOR,
                gasUsed: 21_000n,
                effectiveGasPrice: null
            },
            [USER_OP_A],
            "included"
        )

        expect(set).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0][0]).toEqual({ transactionHash: MINED })
        expect(error).not.toHaveBeenCalled()
    })

    it("swallows a gauge failure and logs it as an error", () => {
        const { manager, warn, error, set } = makeManager()
        set.mockImplementation(() => {
            throw new Error("registry exploded")
        })

        expect(() =>
            updateTransactionCostMetrics.call(
                manager,
                minedReceipt,
                [USER_OP_A],
                "included"
            )
        ).not.toThrow()

        expect(error).toHaveBeenCalledTimes(1)
        expect(error.mock.calls[0][1]).toBe(
            "Failed to update transaction cost metrics"
        )
        expect(warn).not.toHaveBeenCalled()
    })
})

// The tick reaches only this.opsCount, this.config, this.mempool.getBundles,
// this.sendBundleToExecutor, this.logger, this.bundlingMode and the real
// scheduleNextTick and logTickLateness, so a stand-in suffices. bundlingMode
// "manual" keeps it from re-arming its own setTimeout; in "auto" the timer
// calls this.autoScalingBundling, which runs the real tick.
const tickMethods = ExecutorManager.prototype as unknown as {
    autoScalingBundling: () => Promise<void>
    scheduleNextTick: (interval: number) => void
    logTickLateness: (dueAt: number) => void
}

const autoScalingBundling = tickMethods.autoScalingBundling

const makeTick = (config: Record<string, unknown>, wallets = 10) => {
    const getBundles = vi.fn(
        async (
            _budget: number,
            _onBundle: (bundle: unknown) => void
        ): Promise<unknown[]> => []
    )
    const sendBundleToExecutor = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const manager = {
        opsCount: [] as number[],
        config: { minBundleInterval: 0, maxBundleInterval: 0, ...config },
        mempool: { getBundles },
        senderManager: { getAllWallets: () => new Array(wallets).fill({}) },
        sendBundleToExecutor,
        logger,
        bundlingMode: "manual",
        scheduleNextTick: tickMethods.scheduleNextTick,
        logTickLateness: tickMethods.logTickLateness,
        autoScalingBundling: vi.fn(
            (): Promise<void> => autoScalingBundling.call(manager)
        )
    }

    return { getBundles, sendBundleToExecutor, logger, manager }
}

// The step field of every line logged at one level.
const loggedSteps = (log: ReturnType<typeof vi.fn>): unknown[] =>
    log.mock.calls.map(([fields]) => fields.step)

describe("autoScalingBundling", () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it("budgets one bundle per executor wallet when max-bundle-count is unset", async () => {
        const { manager, getBundles } = makeTick({}, 10)

        await autoScalingBundling.call(manager)

        expect(getBundles).toHaveBeenCalledTimes(1)
        expect(getBundles).toHaveBeenCalledWith(10, expect.any(Function))
    })

    it("lets max-bundle-count lower the budget below the wallet count", async () => {
        const { manager, getBundles } = makeTick({ maxBundleCount: 4 }, 10)

        await autoScalingBundling.call(manager)

        expect(getBundles).toHaveBeenCalledWith(4, expect.any(Function))
    })

    it("clamps max-bundle-count to the wallet count, since extra bundles only queue", async () => {
        const { manager, getBundles } = makeTick({ maxBundleCount: 50 }, 10)

        await autoScalingBundling.call(manager)

        expect(getBundles).toHaveBeenCalledWith(10, expect.any(Function))
    })

    it("still bounds the pass to one bundle when no wallets are configured", async () => {
        const { manager, getBundles } = makeTick({}, 0)

        await autoScalingBundling.call(manager)

        // getBundles(0) would mean unbounded, which is the failure this
        // budget exists to prevent.
        expect(getBundles).toHaveBeenCalledWith(1, expect.any(Function))
    })

    it("hands each bundle to the executor as the pass reports it", async () => {
        const { manager, getBundles, sendBundleToExecutor } = makeTick({
            maxBundleCount: 10
        })
        const bundleA = { userOps: [{}] }
        const bundleB = { userOps: [{}, {}] }
        getBundles.mockImplementation(async (_budget, onBundle) => {
            // A synchronous callback: nothing for the pass to await.
            expect(onBundle(bundleA)).toBeUndefined()
            await Promise.resolve()
            expect(sendBundleToExecutor).toHaveBeenCalledTimes(1)
            onBundle(bundleB)
            return [bundleA, bundleB]
        })

        await autoScalingBundling.call(manager)

        // Once each, from the callback; none again from the returned array.
        expect(sendBundleToExecutor.mock.calls.map(([b]) => b)).toEqual([
            bundleA,
            bundleB
        ])
        expect(sendBundleToExecutor).toHaveBeenCalledTimes(2)
    })

    it("logs the pass duration with its bundle and userOp counts", async () => {
        const { manager, getBundles, logger } = makeTick({})
        getBundles.mockResolvedValue([{ userOps: [{}] }, { userOps: [{}, {}] }])

        await autoScalingBundling.call(manager)

        expect(logger.info).toHaveBeenCalledWith(
            {
                step: "bundling.getBundles",
                ms: expect.any(Number),
                bundleBudget: 10,
                bundleCount: 2,
                userOpCount: 3
            },
            "[timing] bundling.getBundles"
        )
    })

    it("stays quiet for a fast empty pass", async () => {
        vi.spyOn(performance, "now").mockReturnValue(0)
        const { manager, logger } = makeTick({})

        await autoScalingBundling.call(manager)

        expect(logger.info).not.toHaveBeenCalled()
    })

    it("logs an empty pass that was slow", async () => {
        let clock = 0
        vi.spyOn(performance, "now").mockImplementation(() => clock)
        const { manager, getBundles, logger } = makeTick({})
        getBundles.mockImplementation(() => {
            clock += 80
            return Promise.resolve([])
        })

        await autoScalingBundling.call(manager)

        expect(logger.info).toHaveBeenCalledWith(
            {
                step: "bundling.getBundles",
                ms: 80,
                bundleBudget: 10,
                bundleCount: 0,
                userOpCount: 0
            },
            "[timing] bundling.getBundles"
        )
    })

    // Arms one tick at monotonic 0 with a 100ms interval (due at 100), then
    // fires it with the monotonic clock at firedAt. The fired tick runs in
    // manual mode, so it arms no successor.
    const fireScheduledTick = async (firedAt: number) => {
        vi.useFakeTimers()
        let clock = 0
        vi.spyOn(performance, "now").mockImplementation(() => clock)
        const tick = makeTick({
            minBundleInterval: 100,
            maxBundleInterval: 100
        })
        tick.manager.bundlingMode = "auto"
        await autoScalingBundling.call(tick.manager)

        tick.manager.bundlingMode = "manual"
        clock = firedAt
        await vi.advanceTimersByTimeAsync(100)
        await tick.manager.autoScalingBundling.mock.results[0]?.value
        return tick
    }

    it("logs a late timer tick on the monotonic clock", async () => {
        // The fake wall clock advances exactly by the timer delay, so only
        // the monotonic clock can see the 120ms.
        const { manager, logger } = await fireScheduledTick(220)

        expect(manager.autoScalingBundling).toHaveBeenCalledTimes(1)
        expect(logger.info).toHaveBeenCalledWith(
            { step: "bundling.tickLate", lateMs: 120 },
            "[timing] bundling.tickLate"
        )
    })

    it.each([
        { lateMs: 49, logged: false },
        { lateMs: 50, logged: true }
    ])(
        "applies the late-tick threshold at $lateMs ms (logged: $logged)",
        async ({ lateMs, logged }) => {
            const { manager, logger } = await fireScheduledTick(100 + lateMs)

            expect(manager.autoScalingBundling).toHaveBeenCalledTimes(1)
            const lateLines = logger.info.mock.calls.filter(
                ([fields]) => fields.step === "bundling.tickLate"
            )
            expect(lateLines).toEqual(
                logged
                    ? [
                          [
                              { step: "bundling.tickLate", lateMs },
                              "[timing] bundling.tickLate"
                          ]
                      ]
                    : []
            )
        }
    )

    it("arms the next due time from the end of the pass in auto mode", async () => {
        vi.useFakeTimers()
        let clock = 0
        vi.spyOn(performance, "now").mockImplementation(() => clock)
        const { manager, getBundles, logger } = makeTick({
            minBundleInterval: 100,
            maxBundleInterval: 100
        })
        manager.bundlingMode = "auto"
        // Every pass takes 500ms on the monotonic clock.
        getBundles.mockImplementation(() => {
            clock += 500
            return Promise.resolve([])
        })

        await autoScalingBundling.call(manager)

        // Due 100ms after the pass ended at 500, not after it started at 0.
        await vi.advanceTimersByTimeAsync(99)
        expect(manager.autoScalingBundling).not.toHaveBeenCalled()
        clock = 600
        await vi.advanceTimersByTimeAsync(1)
        expect(manager.autoScalingBundling).toHaveBeenCalledTimes(1)
        expect(manager.autoScalingBundling).toHaveBeenCalledWith()
        await manager.autoScalingBundling.mock.results[0]?.value
        // Fired on time.
        expect(loggedSteps(logger.info)).not.toContain("bundling.tickLate")

        // Manual mode arms no timer.
        vi.clearAllTimers()
        manager.bundlingMode = "manual"
        await autoScalingBundling.call(manager)
        expect(vi.getTimerCount()).toBe(0)
    })

    it("still counts every userOp toward the rate", async () => {
        const { manager, getBundles } = makeTick({})
        getBundles.mockResolvedValue([{ userOps: [{}] }, { userOps: [{}, {}] }])

        await autoScalingBundling.call(manager)

        expect(manager.opsCount).toHaveLength(3)
    })

    it("logs a failed pass with its duration and rethrows the original error", async () => {
        let clock = 0
        vi.spyOn(performance, "now").mockImplementation(() => clock)
        const { manager, getBundles, logger, sendBundleToExecutor } = makeTick(
            {}
        )
        const error = new Error("store unavailable")
        getBundles.mockImplementation(() => {
            clock += 30
            return Promise.reject(error)
        })

        await expect(autoScalingBundling.call(manager)).rejects.toBe(error)

        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith(
            {
                step: "bundling.getBundles",
                ms: 30,
                bundleBudget: 10,
                err: error.message
            },
            "[timing] bundling.getBundles failed"
        )
        expect(logger.info).not.toHaveBeenCalled()
        expect(sendBundleToExecutor).not.toHaveBeenCalled()
    })
})

const ENTRY_POINT: Address = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"
const TX_HASH = hash(2)

const USER_OP: UserOperation06 = {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    callGasLimit: 6_000_000n,
    verificationGasLimit: 350_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    paymasterAndData: "0x",
    signature: "0x"
}

const makeUserOpInfo = (
    userOpHash: Hex,
    overrides: Partial<UserOpInfo> = {}
): UserOpInfo => ({
    userOp: USER_OP,
    userOpHash,
    addedToMempool: 1000,
    submissionAttempts: 0,
    ...overrides
})

const makeBundle = (userOps: UserOpInfo[]): UserOperationBundle => ({
    entryPoint: ENTRY_POINT,
    version: "0.6",
    submissionAttempts: 0,
    userOps
})

// One macrotask turn: every microtask queued before it has run by the time it
// resolves, and so has Node's check for unhandled rejections.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

// Rejections nobody handled while `run` executed or within one turn after it,
// so a detached promise that rejects late in `run` is still caught. The
// listener is removed whatever happens.
const collectUnhandledRejections = async (
    run: () => Promise<void>
): Promise<unknown[]> => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
        unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
        await run()
        await nextTurn()
    } finally {
        process.off("unhandledRejection", onUnhandled)
    }
    return unhandled
}

// A recovery call a failure test may replace with a rejectingStub.
type RecoveryCall = (...args: never[]) => Promise<unknown>

// Rejects like a failing dependency, as a plain function rather than a vi.fn:
// a Vitest mock attaches its own handlers to every promise it returns, so a
// rejection it produced could never surface as unhandled.
const rejectingStub = (error: Error) => {
    const calls: unknown[][] = []
    return {
        calls,
        stub: (...args: unknown[]): Promise<never> => {
            calls.push(args)
            return Promise.reject(error)
        }
    }
}

// Everything sendBundleToExecutor reaches on its success and recovery paths.
// legacyTransactions keeps getBaseFee off the gas price manager.
const makeSend = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const getWallet = vi.fn(
        async (): Promise<{ address: Address }> => ({ address: EXECUTOR })
    )
    const markWalletProcessed = vi.fn().mockResolvedValue(undefined)
    const resubmitUserOps = vi.fn().mockResolvedValue(undefined)
    const requestShutdown = vi.fn()
    const tryGetNetworkGasPrice = vi.fn(async () => ({
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n
    }))
    const getTransactionCount = vi.fn(async () => 0)
    const bundle = vi.fn(
        async ({ userOpBundle }: { userOpBundle: UserOperationBundle }) => ({
            success: true,
            userOpsBundled: userOpBundle.userOps,
            rejectedUserOps: [],
            transactionRequest: {},
            transactionHash: TX_HASH
        })
    )
    const trackBundle = vi.fn()
    // Mirrors the stamp in Mempool.markUserOpsAsSubmitted.
    const markUserOpsAsSubmitted = vi.fn(
        ({ userOps }: { userOps: UserOpInfo[] }) => {
            for (const userOpInfo of userOps) {
                userOpInfo.submittedAt ??= Date.now()
            }
            return Promise.resolve()
        }
    )

    return {
        logger,
        getWallet,
        markWalletProcessed,
        resubmitUserOps,
        requestShutdown,
        tryGetNetworkGasPrice,
        getTransactionCount,
        bundle,
        trackBundle,
        markUserOpsAsSubmitted,
        manager: {
            logger,
            requestShutdown,
            shutdownRequested: false,
            config: {
                legacyTransactions: true,
                publicClient: { getTransactionCount }
            },
            senderManager: {
                getWallet,
                markWalletProcessed: markWalletProcessed as RecoveryCall
            },
            gasPriceManager: { tryGetNetworkGasPrice },
            executor: { bundle },
            bundleManager: { trackBundle },
            startWatchingBlocks: vi.fn(),
            mempool: {
                markUserOpsAsSubmitted,
                dropUserOps: vi.fn(),
                resubmitUserOps: resubmitUserOps as RecoveryCall
            },
            metrics: {
                bundlesSubmitted: { labels: () => ({ inc: vi.fn() }) }
            },
            getBaseFee: ExecutorManager.prototype.getBaseFee,
            acquireWallet: (
                ExecutorManager.prototype as unknown as {
                    acquireWallet: unknown
                }
            ).acquireWallet,
            recoverFailedSend: (
                ExecutorManager.prototype as unknown as {
                    recoverFailedSend: unknown
                }
            ).recoverFailedSend
        }
    }
}

describe("summarizePass", () => {
    const oneOpBundle = () => makeBundle([makeUserOpInfo(USER_OP_A)])

    // 49.999 would round to 50.00, so the threshold must see the raw time.
    it.each([0, 49.999])("stays quiet for an empty pass of %s ms", (ms) => {
        expect(summarizePass([], ms)).toBeUndefined()
    })

    it.each([50, 80])("logs an empty pass of %s ms", (ms) => {
        expect(summarizePass([], ms)).toEqual({
            bundleCount: 0,
            userOpCount: 0
        })
    })

    it("always logs a pass that produced bundles, with its counts", () => {
        const twoOpBundle = makeBundle([
            makeUserOpInfo(USER_OP_A),
            makeUserOpInfo(USER_OP_B)
        ])

        expect(summarizePass([oneOpBundle(), twoOpBundle], 0)).toEqual({
            bundleCount: 2,
            userOpCount: 3
        })
    })
})

describe("sendBundleToExecutor stage stamps", () => {
    const sendBundleToExecutor = (
        ExecutorManager.prototype as unknown as {
            sendBundleToExecutor: (bundle: unknown) => Promise<unknown>
        }
    ).sendBundleToExecutor

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("stamps dispatchedAt on entry and walletAcquiredAt once the wallet arrives", async () => {
        const { manager, getWallet } = makeSend()
        const now = vi.spyOn(Date, "now").mockReturnValue(5000)
        let releaseWallet: (wallet: { address: Address }) => void = () =>
            undefined
        getWallet.mockReturnValueOnce(
            new Promise((resolve) => {
                releaseWallet = resolve
            })
        )
        const userOps = [makeUserOpInfo(USER_OP_A), makeUserOpInfo(USER_OP_B)]

        const sent = sendBundleToExecutor.call(manager, makeBundle(userOps))

        // Held at getWallet: dispatched, no wallet yet.
        expect(getWallet).toHaveBeenCalledTimes(1)
        expect(userOps.map((u) => u.dispatchedAt)).toEqual([5000, 5000])
        expect(userOps.map((u) => u.walletAcquiredAt)).toEqual([
            undefined,
            undefined
        ])

        now.mockReturnValue(5100)
        releaseWallet({ address: EXECUTOR })
        await expect(sent).resolves.toBe(TX_HASH)

        expect(userOps.map((u) => u.dispatchedAt)).toEqual([5000, 5000])
        expect(userOps.map((u) => u.walletAcquiredAt)).toEqual([5100, 5100])
    })

    it("keeps stamps a record already carries (first value wins)", async () => {
        const { manager } = makeSend()
        vi.spyOn(Date, "now").mockReturnValue(5000)
        const userOps = [
            makeUserOpInfo(USER_OP_A, { dispatchedAt: 1, walletAcquiredAt: 2 }),
            makeUserOpInfo(USER_OP_B)
        ]

        await sendBundleToExecutor.call(manager, makeBundle(userOps))

        expect(userOps[0]).toMatchObject({
            dispatchedAt: 1,
            walletAcquiredAt: 2
        })
        expect(userOps[1]).toMatchObject({
            dispatchedAt: 5000,
            walletAcquiredAt: 5000
        })
    })

    it("times the wallet wait", async () => {
        const { manager, logger } = makeSend()
        const userOps = [makeUserOpInfo(USER_OP_A), makeUserOpInfo(USER_OP_B)]

        await sendBundleToExecutor.call(manager, makeBundle(userOps))

        expect(logger.info).toHaveBeenCalledWith(
            {
                entryPoint: ENTRY_POINT,
                bundleSize: 2,
                step: "bundle.getWallet",
                ms: expect.any(Number)
            },
            "[timing] bundle.getWallet"
        )
    })

    it("returns early for an empty bundle without a wallet or stamps", async () => {
        const { manager, getWallet, logger } = makeSend()
        const emptyBundle = makeBundle([])

        await expect(
            sendBundleToExecutor.call(manager, emptyBundle)
        ).resolves.toBeUndefined()

        expect(getWallet).not.toHaveBeenCalled()
        expect(logger.info).not.toHaveBeenCalled()
        expect(emptyBundle).toEqual(makeBundle([]))
    })

    it("carries every stamp through the executor's copy so the stages sum to processingMs", async () => {
        const { manager, getWallet, trackBundle, markUserOpsAsSubmitted } =
            makeSend()
        let now = 1190
        vi.spyOn(Date, "now").mockImplementation(() => now)
        // The wallet arrives at 1290; the broadcast is tracked at 1500.
        getWallet.mockImplementationOnce(() => {
            now = 1290
            return Promise.resolve({ address: EXECUTOR })
        })
        trackBundle.mockImplementationOnce(() => {
            now = 1500
        })
        const userOps = [
            makeUserOpInfo(USER_OP_A, { processingAt: 1100, bundledAt: 1130 }),
            makeUserOpInfo(USER_OP_B, { processingAt: 1120, bundledAt: 1130 })
        ]

        await sendBundleToExecutor.call(manager, makeBundle(userOps))

        const submitted: UserOpInfo[] =
            trackBundle.mock.calls[0][0].bundle.userOps
        expect(markUserOpsAsSubmitted.mock.calls[0][0].userOps).toBe(submitted)
        submitted.forEach((userOpInfo, i) => {
            // A copy with the attempt counted, not the record the pass built.
            expect(userOpInfo).not.toBe(userOps[i])
            expect(userOpInfo).toMatchObject({
                submissionAttempts: 1,
                processingAt: userOps[i].processingAt,
                bundledAt: 1130,
                dispatchedAt: 1190,
                walletAcquiredAt: 1290,
                submittedAt: 1500
            })
        })

        const timings = submitted.map((userOpInfo) =>
            computeInclusionTimings(userOpInfo, 1760)
        )
        expect(timings[0]).toMatchObject({
            processingMs: 400,
            bundleBuildMs: 30,
            handOffMs: 60,
            walletWaitMs: 100,
            submissionMs: 210
        })
        expect(timings[1]).toMatchObject({
            processingMs: 380,
            bundleBuildMs: 10,
            handOffMs: 60,
            walletWaitMs: 100,
            submissionMs: 210
        })
        for (const t of timings) {
            expect(
                (t.bundleBuildMs ?? 0) +
                    (t.handOffMs ?? 0) +
                    (t.walletWaitMs ?? 0) +
                    (t.submissionMs ?? 0)
            ).toBe(t.processingMs)
        }
    })

    it("keeps the original submission chain when a submitted record is rotated", async () => {
        const { manager, trackBundle } = makeSend()
        vi.spyOn(Date, "now").mockReturnValue(9000)
        // A record from a prior successful cycle, as rotateStuckBundle passes
        // the submitted bundle back in.
        const userOps = [
            makeUserOpInfo(USER_OP_A, {
                processingAt: 1100,
                bundledAt: 1130,
                dispatchedAt: 1190,
                walletAcquiredAt: 1290,
                submittedAt: 1500,
                submissionAttempts: 1
            })
        ]

        await sendBundleToExecutor.call(manager, {
            ...makeBundle(userOps),
            submissionAttempts: 1
        })

        const [rotated] = trackBundle.mock.calls[0][0].bundle.userOps
        expect(rotated).toMatchObject({
            submissionAttempts: 2,
            dispatchedAt: 1190,
            walletAcquiredAt: 1290,
            submittedAt: 1500
        })
    })

    it("logs a failed wallet wait, stamps no wallet time and resolves", async () => {
        const { manager, getWallet, logger } = makeSend()
        vi.spyOn(Date, "now").mockReturnValue(5000)
        const error = new Error("wallet pool unavailable")
        getWallet.mockRejectedValueOnce(error)
        const userOps = [makeUserOpInfo(USER_OP_A), makeUserOpInfo(USER_OP_B)]

        // The recovery guard owns the failure (see the recovery tests below).
        await expect(
            sendBundleToExecutor.call(manager, makeBundle(userOps))
        ).resolves.toBeUndefined()

        expect(logger.warn).toHaveBeenCalledWith(
            {
                entryPoint: ENTRY_POINT,
                bundleSize: 2,
                step: "bundle.getWallet",
                ms: expect.any(Number),
                err: error.message
            },
            "[timing] bundle.getWallet failed"
        )
        expect(userOps.map((u) => u.dispatchedAt)).toEqual([5000, 5000])
        expect(userOps.map((u) => u.walletAcquiredAt)).toEqual([
            undefined,
            undefined
        ])
    })
})

// Runs the real sendBundleToExecutor and hands back its promises untouched:
// no handler is attached before the test settles them, so a rejection would
// surface as unhandled first.
type Dispatch = (
    send: ReturnType<typeof makeSend>,
    bundle: UserOperationBundle
) => Promise<Promise<unknown>[]>

const realSendBundleToExecutor = (
    ExecutorManager.prototype as unknown as {
        sendBundleToExecutor: (bundle: unknown) => Promise<unknown>
    }
).sendBundleToExecutor

const dispatchDirectly: Dispatch = async (send, bundle) => [
    realSendBundleToExecutor.call(send.manager, bundle)
]

// Through the real tick: the mocked pass hands the bundle to the callback the
// tick supplies, which starts the real sendBundleToExecutor detached on the
// same stand-in (not makeTick's stub). The stand-in returns that promise as
// the real method would, so a handler the callback attaches runs against it;
// returning it attaches none.
const dispatchThroughTick: Dispatch = async (send, bundle) => {
    const dispatched: Promise<unknown>[] = []
    const tick = {
        ...send.manager,
        opsCount: [] as number[],
        config: {
            ...send.manager.config,
            minBundleInterval: 0,
            maxBundleInterval: 0
        },
        mempool: {
            ...send.manager.mempool,
            getBundles: (
                _budget: number,
                onBundle: (bundle: UserOperationBundle) => void
            ) => {
                onBundle(bundle)
                return Promise.resolve([bundle])
            }
        },
        senderManager: {
            ...send.manager.senderManager,
            getAllWallets: () => [{}]
        },
        bundlingMode: "manual",
        sendBundleToExecutor: (handed: UserOperationBundle) => {
            const sent = realSendBundleToExecutor.call(tick, handed)
            dispatched.push(sent)
            return sent
        }
    }

    await autoScalingBundling.call(tick)

    return dispatched
}

const makeUserOps = () => [makeUserOpInfo(USER_OP_A), makeUserOpInfo(USER_OP_B)]

// What the recovery guard hands back to the mempool for a failed bundle.
const requeueArgs = (
    userOps: UserOpInfo[],
    reason = "send_bundle_unexpected_error"
) => ({
    userOps,
    entryPoint: ENTRY_POINT,
    reason
})

// A failed wallet wait requeues under its own reason.
const WALLET_FAILED = "wallet_acquisition_failed"

// Exactly one dispatch, which resolved undefined, with nothing unhandled.
const RESOLVED_QUIETLY = {
    unhandled: [],
    outcomes: [{ status: "fulfilled", value: undefined }]
}

// Another instance's key, popped from the shared Redis wallet queue.
const FOREIGN_WALLET = "0x000000000000000000000000000000000000beef"

const NOT_OWNED_LINE = [
    { event: "executorWalletNotOwned", executor: FOREIGN_WALLET },
    "executor wallet from the shared queue is not one of this instance's keys; shutting down so a restart can re-seed the queue"
]

describe("sendBundleToExecutor failure recovery", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe.each([
        ["called directly", dispatchDirectly],
        ["streamed by the tick", dispatchThroughTick]
    ] as const)("%s", (_via, dispatch) => {
        // Dispatches one bundle and waits a turn for its detached work,
        // recording any rejection nobody handled. Only then are the executor
        // promises settled; allSettled keeps a rejection visible as one.
        const run = async (
            send: ReturnType<typeof makeSend>,
            userOps: UserOpInfo[]
        ) => {
            let dispatched: Promise<unknown>[] = []
            const unhandled = await collectUnhandledRejections(async () => {
                dispatched = await dispatch(send, makeBundle(userOps))
            })
            return { unhandled, outcomes: await Promise.allSettled(dispatched) }
        }

        it("requeues a bundle whose wallet wait failed, freeing nothing", async () => {
            const send = makeSend()
            const error = new Error("wallet pool unavailable")
            send.getWallet.mockRejectedValueOnce(error)
            const userOps = makeUserOps()

            expect(await run(send, userOps)).toEqual(RESOLVED_QUIETLY)

            expect(send.logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    step: "bundle.getWallet",
                    err: error.message
                }),
                "[timing] bundle.getWallet failed"
            )
            expect(send.logger.error.mock.calls).toEqual([
                [
                    { err: error, executor: undefined },
                    "unexpected error sending bundle to executor"
                ]
            ])
            expect(send.resubmitUserOps.mock.calls).toEqual([
                [requeueArgs(userOps, WALLET_FAILED)]
            ])
            // No wallet was acquired, so there is none to free.
            expect(send.markWalletProcessed).not.toHaveBeenCalled()
            expect(send.requestShutdown).not.toHaveBeenCalled()
            expect(send.tryGetNetworkGasPrice).not.toHaveBeenCalled()
            expect(send.getTransactionCount).not.toHaveBeenCalled()
            expect(send.bundle).not.toHaveBeenCalled()
        })

        it("requeues a popped wallet this instance does not own, then requests shutdown", async () => {
            const send = makeSend()
            const error = new WalletNotFoundError(FOREIGN_WALLET)
            send.getWallet.mockRejectedValueOnce(error)
            const userOps = makeUserOps()

            // Resolves on every path: the restart is requested explicitly,
            // not left to an unhandled rejection (ADR 0004).
            expect(await run(send, userOps)).toEqual(RESOLVED_QUIETLY)

            expect(send.requestShutdown.mock.calls).toEqual([
                ["executorWalletNotOwned"]
            ])
            expect(send.resubmitUserOps.mock.calls).toEqual([
                [requeueArgs(userOps, WALLET_FAILED)]
            ])
            expect(
                send.resubmitUserOps.mock.invocationCallOrder[0]
            ).toBeLessThan(send.requestShutdown.mock.invocationCallOrder[0])
            expect(send.logger.error.mock.calls).toEqual([
                [
                    { err: error, executor: undefined },
                    "unexpected error sending bundle to executor"
                ],
                NOT_OWNED_LINE
            ])
            expect(send.markWalletProcessed).not.toHaveBeenCalled()
            expect(send.tryGetNetworkGasPrice).not.toHaveBeenCalled()
            expect(send.getTransactionCount).not.toHaveBeenCalled()
            expect(send.bundle).not.toHaveBeenCalled()
        })

        it("requests shutdown for a wallet it does not own only after the requeue settles", async () => {
            const send = makeSend()
            send.getWallet.mockRejectedValueOnce(
                new WalletNotFoundError(FOREIGN_WALLET)
            )
            let settleRequeue: (value: undefined) => void = () => undefined
            send.resubmitUserOps.mockReturnValueOnce(
                new Promise((resolve) => {
                    settleRequeue = resolve
                })
            )

            let dispatched: Promise<unknown>[] = []
            const unhandled = await collectUnhandledRejections(async () => {
                dispatched = await dispatch(send, makeBundle(makeUserOps()))
                await nextTurn()
                expect(send.resubmitUserOps).toHaveBeenCalledTimes(1)
                expect(send.requestShutdown).not.toHaveBeenCalled()
                settleRequeue(undefined)
            })

            expect(unhandled).toEqual([])
            expect(send.requestShutdown).toHaveBeenCalledTimes(1)
            expect(await Promise.allSettled(dispatched)).toEqual([
                { status: "fulfilled", value: undefined }
            ])
        })

        it("still resolves when a step after wallet acquisition throws WalletNotFoundError", async () => {
            const send = makeSend()
            const error = new WalletNotFoundError(FOREIGN_WALLET)
            send.bundle.mockRejectedValueOnce(error)
            const userOps = makeUserOps()

            expect(await run(send, userOps)).toEqual(RESOLVED_QUIETLY)

            expect(send.markWalletProcessed).toHaveBeenCalledTimes(1)
            expect(send.resubmitUserOps.mock.calls).toEqual([
                [requeueArgs(userOps)]
            ])
            expect(send.logger.error.mock.calls).toEqual([
                [
                    { err: error, executor: EXECUTOR },
                    "unexpected error sending bundle to executor"
                ]
            ])
            expect(send.requestShutdown).not.toHaveBeenCalled()
        })

        it("frees the acquired wallet, then requeues, when a pre-submit step throws", async () => {
            const send = makeSend()
            const wallet: { address: Address } = { address: EXECUTOR }
            send.getWallet.mockResolvedValueOnce(wallet)
            const error = new Error("simulation crashed")
            send.bundle.mockRejectedValueOnce(error)
            const userOps = makeUserOps()

            expect(await run(send, userOps)).toEqual(RESOLVED_QUIETLY)

            expect(send.logger.error.mock.calls).toEqual([
                [
                    { err: error, executor: EXECUTOR },
                    "unexpected error sending bundle to executor"
                ]
            ])
            expect(send.markWalletProcessed).toHaveBeenCalledTimes(1)
            expect(send.markWalletProcessed.mock.calls[0][0]).toBe(wallet)
            expect(send.resubmitUserOps.mock.calls).toEqual([
                [requeueArgs(userOps)]
            ])
            expect(
                send.markWalletProcessed.mock.invocationCallOrder[0]
            ).toBeLessThan(send.resubmitUserOps.mock.invocationCallOrder[0])
            expect(send.trackBundle).not.toHaveBeenCalled()
        })

        it("leaves a tracked bundle to block reconciliation when a later step throws", async () => {
            const send = makeSend()
            const error = new Error("submitted write failed")
            send.markUserOpsAsSubmitted.mockRejectedValueOnce(error)

            expect(await run(send, makeUserOps())).toEqual(RESOLVED_QUIETLY)

            expect(send.trackBundle).toHaveBeenCalledTimes(1)
            expect(send.logger.error.mock.calls).toEqual([
                [
                    { err: error, executor: EXECUTOR },
                    "unexpected error sending bundle to executor"
                ]
            ])
            expect(send.markWalletProcessed).not.toHaveBeenCalled()
            expect(send.resubmitUserOps).not.toHaveBeenCalled()
        })

        it("logs a rejected requeue and still resolves", async () => {
            const send = makeSend()
            const walletError = new Error("wallet pool unavailable")
            send.getWallet.mockRejectedValueOnce(walletError)
            const requeueError = new Error("requeue failed")
            const failingRequeue = rejectingStub(requeueError)
            send.manager.mempool.resubmitUserOps = failingRequeue.stub
            const userOps = makeUserOps()

            expect(await run(send, userOps)).toEqual(RESOLVED_QUIETLY)

            expect(failingRequeue.calls).toEqual([
                [requeueArgs(userOps, WALLET_FAILED)]
            ])
            expect(send.logger.error.mock.calls).toEqual([
                [
                    { err: walletError, executor: undefined },
                    "unexpected error sending bundle to executor"
                ],
                [
                    { err: requeueError },
                    "failed to resubmit userOps after send error"
                ]
            ])
        })

        it("logs a rejected wallet release and still requeues", async () => {
            const send = makeSend()
            const wallet: { address: Address } = { address: EXECUTOR }
            send.getWallet.mockResolvedValueOnce(wallet)
            const sendError = new Error("simulation crashed")
            send.bundle.mockRejectedValueOnce(sendError)
            const releaseError = new Error("release failed")
            const failingRelease = rejectingStub(releaseError)
            send.manager.senderManager.markWalletProcessed = failingRelease.stub
            const userOps = makeUserOps()

            expect(await run(send, userOps)).toEqual(RESOLVED_QUIETLY)

            expect(failingRelease.calls).toHaveLength(1)
            expect(failingRelease.calls[0][0]).toBe(wallet)
            expect(send.resubmitUserOps.mock.calls).toEqual([
                [requeueArgs(userOps)]
            ])
            expect(send.logger.error.mock.calls).toEqual([
                [
                    { err: sendError, executor: EXECUTOR },
                    "unexpected error sending bundle to executor"
                ],
                [
                    { err: releaseError },
                    "failed to free wallet after send error"
                ]
            ])
        })
    })

    it("requests shutdown once however many popped wallets it does not own", async () => {
        const send = makeSend()
        send.getWallet
            .mockRejectedValueOnce(new WalletNotFoundError(FOREIGN_WALLET))
            .mockRejectedValueOnce(new WalletNotFoundError(FOREIGN_WALLET))

        await realSendBundleToExecutor.call(
            send.manager,
            makeBundle(makeUserOps())
        )
        await realSendBundleToExecutor.call(
            send.manager,
            makeBundle(makeUserOps())
        )

        // Both bundles are requeued; the shutdown starts once.
        expect(send.resubmitUserOps).toHaveBeenCalledTimes(2)
        expect(send.requestShutdown).toHaveBeenCalledTimes(1)
    })
})

describe("potentiallyResubmitBundle underpricing on arbitrum", () => {
    const potentiallyResubmitBundle = (
        ExecutorManager.prototype as unknown as {
            potentiallyResubmitBundle: (args: unknown) => void
        }
    ).potentiallyResubmitBundle

    const run = (chainType: string, maxFeePerGas: bigint) => {
        const replaceTransaction = vi.fn()
        const manager = {
            config: { chainType, resubmitStuckTimeout: 60_000 },
            senderManager: { getAllWallets: () => [] },
            quarantinedWallets: new Set(),
            cancelsInFlight: new Set(),
            bundleManager: { stopTrackingBundle: vi.fn() },
            replaceTransaction
        }
        potentiallyResubmitBundle.call(manager, {
            blockReceivedTimestamp: 0,
            submittedBundle: {
                // zero tip, as the arbitrum branch now bids
                transactionRequest: { maxFeePerGas, maxPriorityFeePerGas: 0n },
                lastReplaced: Date.now()
            },
            // network estimate floors a 0 tip to maxFee/200
            networkGasPrice: {
                maxFeePerGas: 30_000_000n,
                maxPriorityFeePerGas: 150_000n
            },
            networkBaseFee: 20_000_000n
        })
        return replaceTransaction
    }

    it("does not replace a zero-tip arbitrum bundle whose cap is fine", () => {
        expect(run("arbitrum", 100_000_000n)).not.toHaveBeenCalled()
    })

    it("still replaces an arbitrum bundle whose fee cap fell behind", () => {
        expect(run("arbitrum", 25_000_000n)).toHaveBeenCalledTimes(1)
    })

    it("keeps comparing tips on other chains", () => {
        expect(run("default", 100_000_000n)).toHaveBeenCalledTimes(1)
    })
})
