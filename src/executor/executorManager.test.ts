import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExecutorManager } from "./executorManager"

// Chains that only produce a block per transaction deadlock a block-driven
// reconciler. These cover the timer that breaks that loop.

const RESUBMIT_STUCK_TIMEOUT = 10_000
const BLOCK_TIME = 1000

const noopLogger = () => {
    const logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
    return logger
}

const createHarness = () => {
    // Captured so a test can emit a block the way watchBlocks would.
    let onBlock: ((block: unknown) => Promise<void>) | undefined
    const unwatch = vi.fn()

    const submittedBundle = {
        uid: "0xbundle",
        transactionHash: "0xtx",
        previousTransactionHashes: [],
        // Matches networkGasPrice, so isGasPriceTooLow stays false.
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
        lastReplaced: Date.now()
    }

    // Mutable: production drops the bundle in processIncludedBundle.
    let pendingBundles: unknown[] = [submittedBundle]

    const getBundleStatuses = vi.fn().mockResolvedValue([])
    const processIncludedBundle = vi.fn(() => {
        pendingBundles = []
    })

    const bundleManager = {
        getPendingBundles: vi.fn(() => pendingBundles),
        getBundleStatuses,
        processIncludedBundle
    }

    const config = {
        bundleMode: "manual",
        blockTime: BLOCK_TIME,
        resubmitStuckTimeout: RESUBMIT_STUCK_TIMEOUT,
        flashblocksPreconfirmationTime: undefined,
        // Keeps getBaseFee() off the network.
        legacyTransactions: true,
        logLevel: "info",
        executorLogLevel: "info",
        getLogger: () => noopLogger(),
        publicClient: {
            watchBlocks: (args: {
                onBlock: (block: unknown) => Promise<void>
            }) => {
                onBlock = args.onBlock
                return unwatch
            },
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
        senderManager: {} as any,
        bundleManager: bundleManager as any
    })

    return {
        executorManager,
        getBundleStatuses,
        processIncludedBundle,
        submittedBundle,
        unwatch,
        getPending: () => pendingBundles,
        emitBlock: async () => {
            await onBlock?.({ number: 1n, baseFeePerGas: 1n })
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

    it("reconciles pending bundles when no new block arrives", async () => {
        const { executorManager, getBundleStatuses } = createHarness()

        executorManager.startWatchingBlocks()

        // No block ever emitted. Was a permanent stall before the watchdog.
        expect(getBundleStatuses).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)

        expect(getBundleStatuses).toHaveBeenCalled()
    })

    it("releases a bundle that lands while blocks are stalled", async () => {
        const {
            executorManager,
            getBundleStatuses,
            processIncludedBundle,
            submittedBundle,
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

        expect(processIncludedBundle).toHaveBeenCalledWith(
            expect.objectContaining({ submittedBundle })
        )
        // Left the pending set -> wallet released.
        expect(getPending()).toHaveLength(0)
    })

    it("stays idle while blocks keep arriving", async () => {
        const { executorManager, getBundleStatuses, emitBlock } =
            createHarness()

        executorManager.startWatchingBlocks()

        // Fresh lastReconcileAt -> watchdog adds no reconciles of its own.
        for (let i = 0; i < RESUBMIT_STUCK_TIMEOUT / BLOCK_TIME + 2; i++) {
            await emitBlock()
            await vi.advanceTimersByTimeAsync(BLOCK_TIME)
        }

        expect(getBundleStatuses).toHaveBeenCalledTimes(
            RESUBMIT_STUCK_TIMEOUT / BLOCK_TIME + 2
        )
    })

    it("keeps reconciling after a failed tick", async () => {
        const { executorManager, getBundleStatuses, emitBlock } =
            createHarness()

        getBundleStatuses.mockRejectedValueOnce(new Error("store unavailable"))

        executorManager.startWatchingBlocks()

        // A throw used to leave currentlyHandlingBlock set forever.
        await emitBlock().catch(() => undefined)
        await emitBlock()

        expect(getBundleStatuses).toHaveBeenCalledTimes(2)
    })

    it("clears the watchdog when the watcher stops", async () => {
        const { executorManager, getBundleStatuses, unwatch } = createHarness()

        executorManager.startWatchingBlocks()
        executorManager.stopWatchingBlocks()

        expect(unwatch).toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT * 3)

        expect(getBundleStatuses).not.toHaveBeenCalled()
    })
})
