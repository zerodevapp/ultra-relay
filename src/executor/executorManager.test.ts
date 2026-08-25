import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExecutorManager } from "./executorManager"

// Chains that only produce a block when they receive a transaction (Arbitrum
// Orbit and friends) deadlock a purely block-driven reconciler: the bundler
// stops submitting, so no block is produced, so handleBlock never runs, so no
// executor wallet is ever freed. These cover the timer that breaks that loop.

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

    const getBundleStatuses = vi.fn().mockResolvedValue([])

    const bundleManager = {
        // One bundle pending for the whole test: handleBlock must keep
        // reconciling it, and must not stop the watcher.
        getPendingBundles: vi.fn().mockReturnValue([{ uid: "0xbundle" }]),
        getBundleStatuses
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
            }
        }
    }

    const executorManager = new ExecutorManager({
        // biome-ignore lint/suspicious/noExplicitAny: narrow stubs, only the
        // block-reconcile path is under test.
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
        unwatch,
        emitBlock: async () => {
            await onBlock?.({ number: 1n, baseFeePerGas: 1n })
        }
    }
}

describe("ExecutorManager stale block watchdog", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        return () => vi.useRealTimers()
    })

    it("reconciles pending bundles when no new block arrives", async () => {
        const { executorManager, getBundleStatuses } = createHarness()

        executorManager.startWatchingBlocks()

        // No block is ever emitted. Before the watchdog this was a permanent
        // stall: pending bundles held their wallets forever.
        expect(getBundleStatuses).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(RESUBMIT_STUCK_TIMEOUT + BLOCK_TIME)

        expect(getBundleStatuses).toHaveBeenCalled()
    })

    it("stays idle while blocks keep arriving", async () => {
        const { executorManager, getBundleStatuses, emitBlock } =
            createHarness()

        executorManager.startWatchingBlocks()

        // A block every blockTime keeps lastReconcileAt fresh, so the watchdog
        // must add no reconciles (and therefore no RPC) of its own.
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

        // A throw used to leave currentlyHandlingBlock set, so every later tick
        // returned early at the guard and reconciliation never resumed.
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
