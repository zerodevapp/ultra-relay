import type { Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
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

const makeTick = (config: Record<string, unknown>) => {
    const getBundles = vi.fn(async (): Promise<unknown[]> => [])
    const sendBundleToExecutor = vi.fn()

    return {
        getBundles,
        sendBundleToExecutor,
        manager: {
            opsCount: [] as number[],
            config: { minBundleInterval: 0, maxBundleInterval: 0, ...config },
            mempool: { getBundles },
            sendBundleToExecutor,
            bundlingMode: "manual"
        }
    }
}

describe("autoScalingBundling", () => {
    it("passes the configured max-bundle-count through to getBundles", async () => {
        const { manager, getBundles } = makeTick({ maxBundleCount: 10 })

        await autoScalingBundling.call(manager)

        expect(getBundles).toHaveBeenCalledTimes(1)
        expect(getBundles).toHaveBeenCalledWith(10)
    })

    it("leaves the pass unbounded when no max-bundle-count is configured", async () => {
        const { manager, getBundles } = makeTick({})

        await autoScalingBundling.call(manager)

        expect(getBundles).toHaveBeenCalledWith(undefined)
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
