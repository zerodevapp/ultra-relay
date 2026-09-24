import type { Hex } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExecutorManager } from "./executorManager"

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
// this.sendBundleToExecutor and this.bundlingMode, so a stand-in suffices.
// bundlingMode "manual" keeps it from re-arming its own setTimeout.
type AutoScalingBundling = () => Promise<void>

const autoScalingBundling = (
    ExecutorManager.prototype as unknown as {
        autoScalingBundling: AutoScalingBundling
    }
).autoScalingBundling

const makeTick = (config: Record<string, unknown>, wallets = 10) => {
    const getBundles = vi.fn(async (): Promise<unknown[]> => [])
    const sendBundleToExecutor = vi.fn()

    return {
        getBundles,
        sendBundleToExecutor,
        manager: {
            opsCount: [] as number[],
            config: { minBundleInterval: 0, maxBundleInterval: 0, ...config },
            mempool: { getBundles },
            senderManager: { getAllWallets: () => new Array(wallets).fill({}) },
            sendBundleToExecutor,
            bundlingMode: "manual"
        }
    }
}

describe("autoScalingBundling", () => {
    it("budgets one bundle per executor wallet when max-bundle-count is unset", async () => {
        const { manager, getBundles } = makeTick({}, 10)

        await autoScalingBundling.call(manager)

        expect(getBundles).toHaveBeenCalledTimes(1)
        expect(getBundles).toHaveBeenCalledWith(10)
    })

    it("lets max-bundle-count lower the budget below the wallet count", async () => {
        const { manager, getBundles } = makeTick({ maxBundleCount: 4 }, 10)

        await autoScalingBundling.call(manager)

        expect(getBundles).toHaveBeenCalledWith(4)
    })

    it("clamps max-bundle-count to the wallet count, since extra bundles only queue", async () => {
        const { manager, getBundles } = makeTick({ maxBundleCount: 50 }, 10)

        await autoScalingBundling.call(manager)

        expect(getBundles).toHaveBeenCalledWith(10)
    })

    it("still bounds the pass to one bundle when no wallets are configured", async () => {
        const { manager, getBundles } = makeTick({}, 0)

        await autoScalingBundling.call(manager)

        // getBundles(0) would mean unbounded, which is the failure this
        // budget exists to prevent.
        expect(getBundles).toHaveBeenCalledWith(1)
    })

    it("hands every returned bundle to the executor", async () => {
        const { manager, getBundles, sendBundleToExecutor } = makeTick({
            maxBundleCount: 10
        })
        const bundleA = { userOps: [{}] }
        const bundleB = { userOps: [{}, {}] }
        getBundles.mockResolvedValue([bundleA, bundleB])

        await autoScalingBundling.call(manager)

        expect(sendBundleToExecutor.mock.calls.map(([b]) => b)).toEqual([
            bundleA,
            bundleB
        ])
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
