import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExecutorManager } from "./executorManager"

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
            pendingBundles = pendingBundles.filter(
                (b) => b !== submittedBundle
            )
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
            watchBlocks,
            // Only cost metrics reach this, and they swallow failures.
            getTransactionReceipt: vi
                .fn()
                .mockRejectedValue(new Error("no receipt in test"))
        }
    }

    const executorManager = new ExecutorManager({
        // Narrow stubs: only the block-reconcile path is under test.
        config: config as any,
        executor: {} as any,
        mempool: {} as any,
        metrics: {} as any,
        gasPriceManager: {
            tryGetNetworkGasPrice: vi.fn().mockResolvedValue({
                maxFeePerGas: 1n,
                maxPriorityFeePerGas: 1n
            })
        } as any,
        senderManager: { getAllWallets: () => [] } as any,
        bundleManager: bundleManager as any
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
    blockNumber: 2n
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
