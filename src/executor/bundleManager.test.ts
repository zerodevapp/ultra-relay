import type { ReceiptCache } from "@alto/receiptCache"
import type {
    SubmittedBundleInfo,
    UserOpInfo,
    UserOperation06,
    UserOperationReceipt
} from "@alto/types"
import type { Hex } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BundleManager } from "./bundleManager"
import type { BundleStatus, BundleTransactionReceipt } from "./getBundleStatus"

// See executorManager.test.ts: keeps utils/logger from opening a Logtail
// transport at import time.
vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

// Stands in for ioredis so the Redis receipt cache never opens a
// connection. setex always fails, like an unreachable Redis.
const { redisSetex, FakeRedis } = vi.hoisted(() => {
    const redisSetex = vi.fn(() => Promise.reject(new Error("redis down")))
    class FakeRedis {
        setex = redisSetex
        get = () => Promise.resolve(null)
    }
    return { redisSetex, FakeRedis }
})

vi.mock("ioredis", () => ({ default: FakeRedis, Redis: FakeRedis }))

type Deps = ConstructorParameters<typeof BundleManager>[0]

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

// Settles every promise a test held open, so a failed assertion can't
// leave a cleanup step, cache write or status write pending.
const releases: (() => void)[] = []

// A deferred that cleanup resolves with `fallback` if the test didn't
// settle it. Resolving a settled promise is a no-op.
const hold = <T>(fallback: T): Deferred<T> => {
    const d = deferred<T>()
    releases.push(() => d.resolve(fallback))
    return d
}

// Every queued promise callback runs before a setImmediate callback.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex

const TX = hash(100)
const BLOCK_HASH = hash(101)
const ENTRY_POINT = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"
// Shared by every op, so reputation updates hit the same sender.
const SENDER = "0x1111111111111111111111111111111111111111"
const EXECUTOR = "0x000000000000000000000000000000000000dEaD"

const USER_OP: UserOperation06 = {
    sender: SENDER,
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

const makeUserOpInfo = (n: number): UserOpInfo => ({
    userOp: USER_OP,
    userOpHash: hash(n),
    addedToMempool: 1000,
    submissionAttempts: 1
})

const makeReceipt = (
    userOpHash: Hex,
    success = true
): UserOperationReceipt => ({
    userOpHash,
    entryPoint: ENTRY_POINT,
    sender: SENDER,
    nonce: 0n,
    actualGasCost: 1n,
    actualGasUsed: 1n,
    success,
    logs: [],
    receipt: {
        transactionHash: TX,
        transactionIndex: 0n,
        blockHash: BLOCK_HASH,
        blockNumber: 2n,
        from: EXECUTOR,
        to: ENTRY_POINT,
        cumulativeGasUsed: 21_000n,
        gasUsed: 21_000n,
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"0".repeat(512)}`,
        status: 1n,
        effectiveGasPrice: 1n
    }
})

const makeSubmittedBundle = (userOps: UserOpInfo[]): SubmittedBundleInfo => ({
    uid: "bundle-1",
    transactionHash: TX,
    previousTransactionHashes: [],
    transactionRequest: {
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        nonce: 0
    },
    bundle: {
        entryPoint: ENTRY_POINT,
        version: "0.6",
        userOps,
        submissionAttempts: 1
    },
    executor: {
        address: EXECUTOR
    } as unknown as SubmittedBundleInfo["executor"],
    lastReplaced: 0
})

const makeIncludedStatus = (
    userOps: UserOpInfo[],
    receipts = userOps.map((op) => makeReceipt(op.userOpHash))
): BundleStatus<"included"> => ({
    status: "included",
    userOpReceipts: Object.fromEntries(
        receipts.map((receipt) => [receipt.userOpHash, receipt])
    ),
    transactionHash: TX,
    blockNumber: 2n,
    // processIncludedBundle never reads the transaction receipt.
    receipt: {} as unknown as BundleTransactionReceipt
})

const createHarness = ({ redisReceiptCache = false } = {}) => {
    const logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }

    // One pending write per hash; tests settle them in any order.
    const statusWrites = new Map<Hex, Deferred<void>>()
    const setUserOpStatus = vi.fn((userOpHash: Hex) => {
        const write = hold<void>(undefined)
        statusWrites.set(userOpHash, write)
        return write.promise
    })
    const markWalletProcessed = vi.fn(() => Promise.resolve())
    const removeSubmittedUserOps = vi.fn(() => Promise.resolve())
    const inc = vi.fn()
    const labels = vi.fn(() => ({ inc }))
    const inclusionDuration = vi.fn()
    const submissionAttempts = vi.fn()
    const emitIncludedOnChain = vi.fn()
    const emitExecutionRevertedOnChain = vi.fn()
    const updateUserOpIncludedStatus = vi.fn()

    const config = {
        getLogger: () => logger,
        logLevel: "info",
        executorLogLevel: "info",
        enableRedisReceiptCache: redisReceiptCache,
        redisEndpoint: redisReceiptCache ? "redis://fake" : undefined,
        redisKeyPrefix: "alto",
        chainId: 1
    }

    const bundleManager = new BundleManager({
        config: config as unknown as Deps["config"],
        mempool: { removeSubmittedUserOps } as unknown as Deps["mempool"],
        monitor: { setUserOpStatus } as unknown as Deps["monitor"],
        metrics: {
            userOperationsOnChain: { labels },
            userOperationInclusionDuration: { observe: inclusionDuration },
            userOperationsSubmissionAttempts: { observe: submissionAttempts }
        } as unknown as Deps["metrics"],
        reputationManager: {
            updateUserOpIncludedStatus
        } as unknown as Deps["reputationManager"],
        eventManager: {
            emitIncludedOnChain,
            emitExecutionRevertedOnChain
        } as unknown as Deps["eventManager"],
        senderManager: {
            markWalletProcessed
        } as unknown as Deps["senderManager"],
        gasPriceManager: {} as unknown as Deps["gasPriceManager"]
    })

    // The real cache the constructor built. Spied (calling through) so a
    // test can order against it or fail one op's cache call.
    const receiptCache = (
        bundleManager as unknown as { receiptCache: ReceiptCache }
    ).receiptCache
    const realCacheSet = receiptCache.set
    const cacheSet = vi.spyOn(receiptCache, "set")

    const write = (userOp: UserOpInfo) => {
        const pending = statusWrites.get(userOp.userOpHash)
        if (!pending) {
            throw new Error(`no status write started for ${userOp.userOpHash}`)
        }
        return pending
    }

    const inclusionLogs = () =>
        logger.info.mock.calls.filter(
            ([, msg]) =>
                typeof msg === "string" && msg.includes(" included in tx ")
        )

    // Tracks the bundle, runs processIncludedBundle and records when it
    // settles. The rejection observer is attached at once.
    const runBundle = (
        userOps: UserOpInfo[],
        bundleReceipt = makeIncludedStatus(userOps)
    ) => {
        const submittedBundle = makeSubmittedBundle(userOps)
        bundleManager.trackBundle(submittedBundle)
        const state: { settled: boolean; error?: unknown } = {
            settled: false
        }
        const done = bundleManager
            .processIncludedBundle({
                submittedBundle,
                bundleReceipt,
                blockReceivedTimestamp: 5000
            })
            .then(
                () => {
                    state.settled = true
                },
                (error: unknown) => {
                    state.settled = true
                    state.error = error
                }
            )
        return { state, done }
    }

    return {
        bundleManager,
        logger,
        setUserOpStatus,
        markWalletProcessed,
        removeSubmittedUserOps,
        inc,
        labels,
        inclusionDuration,
        submissionAttempts,
        emitIncludedOnChain,
        emitExecutionRevertedOnChain,
        updateUserOpIncludedStatus,
        cacheSet,
        realCacheSet,
        write,
        inclusionLogs,
        runBundle
    }
}

const hashes = (userOps: UserOpInfo[]) =>
    userOps.map((op) => op.userOpHash).sort()

const calledHashes = (mock: { mock: { calls: unknown[][] } }) =>
    mock.mock.calls.map(([userOpHash]) => userOpHash as Hex).sort()

describe("BundleManager.processIncludedBundle", () => {
    afterEach(async () => {
        // Releasing one write can start the next op's write, which holds a
        // new promise; drain until nothing new is held.
        do {
            for (const release of releases.splice(0)) {
                release()
            }
            await flush()
        } while (releases.length > 0)
        vi.restoreAllMocks()
        redisSetex.mockClear()
    })

    it("B1: starts all five status writes at once and waits for the last", async () => {
        const h = createHarness()
        const userOps = [1, 2, 3, 4, 5].map(makeUserOpInfo)

        const run = h.runBundle(userOps)
        await flush()

        expect(h.setUserOpStatus).toHaveBeenCalledTimes(5)

        for (const op of userOps.slice(0, 4)) {
            h.write(op).resolve()
        }
        await flush()
        expect(run.state.settled).toBe(false)

        h.write(userOps[4]).resolve()
        await run.done
        expect(run.state).toEqual({ settled: true })
    })

    it("B2: finishes cleanup before any op work, then caches before each status write", async () => {
        const h = createHarness()
        h.setUserOpStatus.mockResolvedValue(undefined)
        const wallet = hold<void>(undefined)
        const removal = hold<void>(undefined)
        h.markWalletProcessed.mockReturnValueOnce(wallet.promise)
        h.removeSubmittedUserOps.mockReturnValueOnce(removal.promise)
        const userOps = [1, 2, 3].map(makeUserOpInfo)

        const run = h.runBundle(userOps)
        await flush()

        expect(h.bundleManager.getPendingBundles()).toEqual([])
        expect(h.markWalletProcessed).toHaveBeenCalledTimes(1)
        expect(h.removeSubmittedUserOps).not.toHaveBeenCalled()
        expect(h.cacheSet).not.toHaveBeenCalled()
        expect(h.setUserOpStatus).not.toHaveBeenCalled()

        wallet.resolve()
        await flush()

        expect(h.removeSubmittedUserOps).toHaveBeenCalledTimes(1)
        expect(h.cacheSet).not.toHaveBeenCalled()
        expect(h.setUserOpStatus).not.toHaveBeenCalled()

        removal.resolve()
        await run.done

        expect(h.cacheSet).toHaveBeenCalledTimes(3)
        expect(h.setUserOpStatus).toHaveBeenCalledTimes(3)
        for (const op of userOps) {
            const cacheCall = h.cacheSet.mock.calls.findIndex(
                ([userOpHash]) => userOpHash === op.userOpHash
            )
            const statusCall = h.setUserOpStatus.mock.calls.findIndex(
                ([userOpHash]) => userOpHash === op.userOpHash
            )
            expect(h.cacheSet.mock.invocationCallOrder[cacheCall]).toBeLessThan(
                h.setUserOpStatus.mock.invocationCallOrder[statusCall]
            )
        }
    })

    it("B3: a failed status write rejects only after every op settles", async () => {
        const h = createHarness()
        const userOps = [1, 2, 3, 4, 5].map(makeUserOpInfo)
        const [op1, op2, op3, op4, op5] = userOps
        const error = new Error("status write failed")

        const run = h.runBundle(userOps)
        await flush()

        // Each op logs inclusion before its status write.
        expect(h.inclusionLogs()).toHaveLength(5)

        h.write(op3).reject(error)
        h.write(op1).resolve()
        h.write(op2).resolve()
        h.write(op4).resolve()
        await flush()
        expect(run.state.settled).toBe(false)

        h.write(op5).resolve()
        await run.done

        expect(run.state.error).toBe(error)
        const succeeded = hashes([op1, op2, op4, op5])
        expect(calledHashes(h.emitIncludedOnChain)).toEqual(succeeded)
        expect(h.inc).toHaveBeenCalledTimes(4)
        expect(h.inclusionDuration).toHaveBeenCalledTimes(4)
        expect(h.submissionAttempts).toHaveBeenCalledTimes(4)
        expect(h.updateUserOpIncludedStatus).toHaveBeenCalledTimes(4)
    })

    it("B4: rejects with the lowest op index, not the first to fail", async () => {
        const h = createHarness()
        const [op1, op2, op3, op4] = [1, 2, 3, 4].map(makeUserOpInfo)
        const secondError = new Error("op 2 failed")
        const fourthError = new Error("op 4 failed")

        const run = h.runBundle([op1, op2, op3, op4])
        await flush()

        h.write(op4).reject(fourthError)
        await flush()
        h.write(op2).reject(secondError)
        h.write(op1).resolve()
        h.write(op3).resolve()
        await run.done

        expect(run.state.error).toBe(secondError)
        expect(run.state.error).not.toBeInstanceOf(AggregateError)
    })

    it("B5: a rejected cache promise skips that op's work; others complete", async () => {
        const h = createHarness()
        h.setUserOpStatus.mockResolvedValue(undefined)
        const [op1, op2, op3] = [1, 2, 3].map(makeUserOpInfo)
        const error = new Error("cache rejected")
        h.cacheSet.mockImplementation((userOpHash, receipt) =>
            userOpHash === op2.userOpHash
                ? Promise.reject(error)
                : h.realCacheSet(userOpHash, receipt)
        )

        const run = h.runBundle([op1, op2, op3])
        await run.done

        expect(run.state.error).toBe(error)
        expect(calledHashes(h.setUserOpStatus)).toEqual(hashes([op1, op3]))
        expect(h.inclusionLogs()).toHaveLength(2)
        expect(calledHashes(h.emitIncludedOnChain)).toEqual(hashes([op1, op3]))
        expect(h.updateUserOpIncludedStatus).toHaveBeenCalledTimes(2)
    })

    it("B5: a slow cache write holds only its own op's status write", async () => {
        const h = createHarness()
        h.setUserOpStatus.mockResolvedValue(undefined)
        const [op1, op2, op3] = [1, 2, 3].map(makeUserOpInfo)
        const slowCache = hold<void>(undefined)
        h.cacheSet.mockImplementation((userOpHash, receipt) =>
            userOpHash === op2.userOpHash
                ? slowCache.promise
                : h.realCacheSet(userOpHash, receipt)
        )

        const run = h.runBundle([op1, op2, op3])
        await flush()

        // op 2 waits on its cache write; op 3 does not wait on op 2.
        expect(calledHashes(h.setUserOpStatus)).toEqual(hashes([op1, op3]))
        expect(run.state.settled).toBe(false)

        slowCache.resolve()
        await run.done

        expect(run.state).toEqual({ settled: true })
        expect(calledHashes(h.setUserOpStatus)).toEqual(hashes([op1, op2, op3]))
    })

    it("B5: a failure waits for a sibling's pending cache write", async () => {
        const h = createHarness()
        const [op1, op2] = [1, 2].map(makeUserOpInfo)
        const slowCache = hold<void>(undefined)
        h.cacheSet.mockImplementation((userOpHash, receipt) =>
            userOpHash === op2.userOpHash
                ? slowCache.promise
                : h.realCacheSet(userOpHash, receipt)
        )
        const error = new Error("status write failed")

        const run = h.runBundle([op1, op2])
        await flush()

        h.write(op1).reject(error)
        await flush()
        expect(run.state.settled).toBe(false)

        slowCache.resolve()
        await flush()

        // op 2's status write starts only now; the bundle still waits.
        expect(run.state.settled).toBe(false)

        h.write(op2).resolve()
        await run.done

        expect(run.state.error).toBe(error)
    })

    it("B5: a Redis cache error is logged and the op's status work continues", async () => {
        const h = createHarness({ redisReceiptCache: true })
        h.setUserOpStatus.mockResolvedValue(undefined)
        const op = makeUserOpInfo(1)

        const run = h.runBundle([op])
        await run.done

        expect(run.state).toEqual({ settled: true })
        expect(redisSetex).toHaveBeenCalledTimes(1)
        expect(h.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ userOpHash: op.userOpHash }),
            "Failed to set receipt in Redis"
        )
        expect(h.setUserOpStatus).toHaveBeenCalledWith(op.userOpHash, {
            status: "included",
            transactionHash: TX
        })
        expect(h.emitIncludedOnChain).toHaveBeenCalledTimes(1)
    })

    it("B6: a wallet release failure rejects before any op work", async () => {
        const h = createHarness()
        const error = new Error("wallet release failed")
        h.markWalletProcessed.mockRejectedValueOnce(error)

        const run = h.runBundle([makeUserOpInfo(1)])
        await run.done

        expect(run.state.error).toBe(error)
        // Tracking was already dropped; nothing is rolled back.
        expect(h.bundleManager.getPendingBundles()).toEqual([])
        expect(h.removeSubmittedUserOps).not.toHaveBeenCalled()
        expect(h.cacheSet).not.toHaveBeenCalled()
        expect(h.setUserOpStatus).not.toHaveBeenCalled()
        expect(h.inclusionLogs()).toEqual([])
    })

    it("B6: a submitted-store removal failure rejects before any op work", async () => {
        const h = createHarness()
        const error = new Error("store removal failed")
        h.removeSubmittedUserOps.mockRejectedValueOnce(error)

        const run = h.runBundle([makeUserOpInfo(1)])
        await run.done

        expect(run.state.error).toBe(error)
        expect(h.bundleManager.getPendingBundles()).toEqual([])
        expect(h.markWalletProcessed).toHaveBeenCalledTimes(1)
        expect(h.cacheSet).not.toHaveBeenCalled()
        expect(h.setUserOpStatus).not.toHaveBeenCalled()
        expect(h.inclusionLogs()).toEqual([])
    })

    it("B7: emits the event matching each receipt and keeps shared counters", async () => {
        const h = createHarness()
        h.setUserOpStatus.mockResolvedValue(undefined)
        const ok = makeUserOpInfo(1)
        const failed = makeUserOpInfo(2)
        const status = makeIncludedStatus(
            [ok, failed],
            [makeReceipt(ok.userOpHash), makeReceipt(failed.userOpHash, false)]
        )

        const run = h.runBundle([ok, failed], status)
        await run.done

        expect(run.state).toEqual({ settled: true })
        expect(h.emitIncludedOnChain.mock.calls).toEqual([
            [ok.userOpHash, TX, 2n]
        ])
        expect(h.emitExecutionRevertedOnChain.mock.calls).toEqual([
            [failed.userOpHash, TX, "0x", 2n]
        ])
        expect(h.setUserOpStatus).toHaveBeenCalledTimes(2)
        for (const op of [ok, failed]) {
            expect(h.setUserOpStatus).toHaveBeenCalledWith(op.userOpHash, {
                status: "included",
                transactionHash: TX
            })
        }
        expect(h.labels).toHaveBeenCalledWith({ status: "included" })
        expect(h.inc).toHaveBeenCalledTimes(2)
        expect(h.updateUserOpIncludedStatus.mock.calls).toEqual([
            [USER_OP, ENTRY_POINT, false],
            [USER_OP, ENTRY_POINT, false]
        ])
    })

    it("B8: an empty bundle only cleans up", async () => {
        const h = createHarness()

        const run = h.runBundle([])
        await run.done

        expect(run.state).toEqual({ settled: true })
        expect(h.markWalletProcessed).toHaveBeenCalledTimes(1)
        expect(h.removeSubmittedUserOps).toHaveBeenCalledTimes(1)
        expect(h.cacheSet).not.toHaveBeenCalled()
        expect(h.setUserOpStatus).not.toHaveBeenCalled()
        expect(h.emitIncludedOnChain).not.toHaveBeenCalled()
        expect(h.updateUserOpIncludedStatus).not.toHaveBeenCalled()
    })

    it("B8: a single op keeps its action order", async () => {
        const h = createHarness()
        h.setUserOpStatus.mockResolvedValue(undefined)

        const run = h.runBundle([makeUserOpInfo(1)])
        await run.done

        const logCall = h.logger.info.mock.calls.findIndex(
            ([, msg]) =>
                typeof msg === "string" && msg.includes(" included in tx ")
        )
        const order = [
            h.cacheSet.mock.invocationCallOrder[0],
            h.logger.info.mock.invocationCallOrder[logCall],
            h.setUserOpStatus.mock.invocationCallOrder[0],
            h.inc.mock.invocationCallOrder[0],
            h.emitIncludedOnChain.mock.invocationCallOrder[0],
            h.inclusionDuration.mock.invocationCallOrder[0],
            h.submissionAttempts.mock.invocationCallOrder[0],
            h.updateUserOpIncludedStatus.mock.invocationCallOrder[0]
        ]
        expect(order.every((n) => typeof n === "number")).toBe(true)
        expect(order).toEqual([...order].sort((a, b) => a - b))
        expect(h.setUserOpStatus).toHaveBeenCalledTimes(1)
        expect(h.updateUserOpIncludedStatus).toHaveBeenCalledTimes(1)
    })

    it("B9: an op without a receipt fails alone; the rest complete", async () => {
        const h = createHarness()
        h.setUserOpStatus.mockResolvedValue(undefined)
        const [op1, op2, op3] = [1, 2, 3].map(makeUserOpInfo)
        const status = makeIncludedStatus(
            [op1, op2, op3],
            [makeReceipt(op1.userOpHash), makeReceipt(op3.userOpHash)]
        )

        const run = h.runBundle([op1, op2, op3], status)
        await run.done

        // processIncludedUserOp (unchanged) reads receipt.success after the
        // status write, so op 2 fails there. Before this change, op 3 never ran.
        expect(run.state.error).toBeInstanceOf(TypeError)
        expect(calledHashes(h.emitIncludedOnChain)).toEqual(hashes([op1, op3]))
        expect(h.updateUserOpIncludedStatus).toHaveBeenCalledTimes(2)
    })
})
