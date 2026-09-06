import { RpcError, ValidationErrors } from "@alto/types"
import { describe, expect, it, vi } from "vitest"
import { Mempool } from "./mempool"

function fixture(error: unknown) {
    const mempool = Object.create(Mempool.prototype) as Mempool
    const monitor = { setUserOpStatus: vi.fn() }
    const reputation = {
        getStatus: () => 0,
        decreaseUserOpSeenStatus: vi.fn(),
        decreaseUserOpCount: vi.fn()
    }
    const store = {
        removeProcessing: vi.fn(),
        removeSubmitted: vi.fn(),
        removeOutstanding: vi.fn()
    }
    const validator = { validateUserOp: vi.fn().mockRejectedValue(error) }
    Object.assign(mempool, {
        config: { safeMode: true },
        logger: { warn: vi.fn(), error: vi.fn() },
        monitor,
        reputationManager: reputation,
        store,
        validator,
        eventManager: { emitDropped: vi.fn() }
    })
    const info: any = {
        userOp: {
            sender: `0x${"11".repeat(20)}`,
            nonce: 0n,
            initCode: "0x",
            paymasterAndData: "0x"
        },
        userOpHash: `0x${"ab".repeat(32)}`,
        submissionAttempts: 0,
        addedToMempool: 1
    }
    const run = () =>
        mempool.shouldSkip({
            userOpInfo: info,
            entryPoint: `0x${"22".repeat(20)}`,
            paymasterDeposit: {},
            stakedEntityCount: {},
            knownEntities: {
                sender: new Set(),
                paymasters: new Set(),
                factories: new Set()
            },
            senders: new Set(),
            storageMap: {}
        })
    return { mempool, info, run, reputation, monitor, store, validator }
}

describe("bundle-time failure recovery", () => {
    it("requeues infrastructure failures three times, never penalizes reputation, then records exhaustion", async () => {
        const f = fixture(
            Object.assign(new Error("network"), { code: "ETIMEDOUT" })
        )
        for (let i = 0; i < 3; i++) {
            expect(await f.run()).toMatchObject({
                skip: true,
                removeOutstanding: false
            })
            expect(f.info.infrastructureRetries).toBe(i + 1)
        }
        expect(await f.run()).toMatchObject({
            skip: true,
            removeOutstanding: true
        })
        expect(f.reputation.decreaseUserOpSeenStatus).not.toHaveBeenCalled()
        expect(f.reputation.decreaseUserOpCount).toHaveBeenCalledTimes(1)
        expect(f.store.removeOutstanding).not.toHaveBeenCalled()
        expect(f.monitor.setUserOpStatus).toHaveBeenCalledExactlyOnceWith(
            f.info.userOpHash,
            {
                status: "rejected",
                transactionHash: null,
                reason: "Validation node timed out; infrastructure retries exhausted"
            }
        )
    })
    it("drops a proven invalid operation once with a reason and one reputation effect", async () => {
        const f = fixture(
            new RpcError("AA23 reverted", ValidationErrors.SimulateValidation)
        )
        expect(await f.run()).toMatchObject({
            skip: true,
            removeOutstanding: true
        })
        expect(f.reputation.decreaseUserOpSeenStatus).toHaveBeenCalledTimes(1)
        expect(f.monitor.setUserOpStatus).toHaveBeenCalledTimes(1)
        expect(f.info.infrastructureRetries).toBeUndefined()
    })
    it("resubmission preserves infrastructure and submission counters", async () => {
        const f = fixture(new Error("unused"))
        f.info.infrastructureRetries = 1
        f.info.submissionAttempts = 2
        Object.assign(f.mempool, {
            add: vi.fn().mockResolvedValue([true, ""]),
            metrics: { userOperationsResubmitted: { inc: vi.fn() } }
        })
        await f.mempool.resubmitUserOps({
            entryPoint: `0x${"22".repeat(20)}`,
            userOps: [f.info],
            reason: "filterops_infrastructure"
        })
        expect(f.mempool.add).toHaveBeenCalledWith(
            f.info.userOp,
            expect.any(String),
            expect.objectContaining({
                infrastructureRetries: 2,
                submissionAttempts: 2
            })
        )
    })
    it("still records rejection when reputation persistence fails", async () => {
        const f = fixture(
            new RpcError("AA23 reverted", ValidationErrors.SimulateValidation)
        )
        f.reputation.decreaseUserOpSeenStatus.mockRejectedValue(
            new Error("offline")
        )
        expect(await f.run()).toMatchObject({
            skip: true,
            removeOutstanding: true
        })
        expect(f.monitor.setUserOpStatus).toHaveBeenCalledTimes(1)
    })
})
