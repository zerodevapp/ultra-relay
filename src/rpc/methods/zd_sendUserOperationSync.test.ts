import { EventManager } from "@alto/handlers"
import { RpcError, SyncUserOpErrors, ValidationErrors } from "@alto/types"
import type { Hex } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { zdSendUserOperationSyncHandler } from "./zd_sendUserOperationSync"

const submit = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock("./eth_sendUserOperation", () => ({
    submitUserOperation: submit.fn
}))

const userOpHash = `0x${"ab".repeat(32)}` as Hex
const transactionHash = `0x${"cd".repeat(32)}` as Hex
const entryPoint = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
const receipt = { userOpHash, success: true, receipt: { transactionHash } }

const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
}

const makeRpcHandler = (config: Record<string, unknown> = {}) => {
    const fullConfig = {
        chainId: 1,
        getLogger: () => logger,
        enableSyncUseropEndpoint: true,
        syncUseropDefaultTimeoutMs: 10_000,
        syncUseropMaxTimeoutMs: 30_000,
        enableHorizontalScaling: false,
        blockTime: 1_000,
        ...config
    }
    const eventManager = new EventManager({
        config: fullConfig as any,
        metrics: {} as any
    })
    return {
        config: fullConfig,
        logger,
        eventManager,
        bundleManager: { getUserOpReceipt: vi.fn(async () => receipt) }
    }
}

// Admits the op, then runs `afterSubmit` once the handler is waiting.
const admitThen = (afterSubmit: (rpcHandler: any) => void) => {
    submit.fn.mockImplementationOnce(async ({ rpcHandler, onUserOpHash }) => {
        onUserOpHash(userOpHash)
        setTimeout(() => afterSubmit(rpcHandler), 0)
        return userOpHash
    })
}

const call = (rpcHandler: any, options?: { timeoutMs?: number }) =>
    zdSendUserOperationSyncHandler.handler({
        rpcHandler,
        params: (options
            ? [{}, entryPoint, options]
            : [{}, entryPoint]) as any,
        apiVersion: "v2"
    })

const rpcErrorOf = async (promise: Promise<unknown>) => {
    const err = await promise.catch((e) => e)
    expect(err).toBeInstanceOf(RpcError)
    return err as RpcError
}

describe("zd_sendUserOperationSync", () => {
    beforeEach(() => {
        submit.fn.mockReset()
    })

    it("is rejected when the endpoint is disabled", async () => {
        const rpcHandler = makeRpcHandler({ enableSyncUseropEndpoint: false })
        const err = await rpcErrorOf(call(rpcHandler))
        expect(err.code).toBe(ValidationErrors.InvalidRequest)
        expect(submit.fn).not.toHaveBeenCalled()
    })

    it.each([
        "included_onchain",
        "execution_reverted_onchain",
        "frontran_onchain"
    ] as const)("returns the cached receipt on %s", async (eventType) => {
        const rpcHandler = makeRpcHandler()
        admitThen(({ eventManager }) => {
            if (eventType === "included_onchain") {
                eventManager.emitIncludedOnChain(userOpHash, transactionHash, 1n)
            } else if (eventType === "frontran_onchain") {
                eventManager.emitFrontranOnChain(userOpHash, transactionHash, 1n)
            } else {
                eventManager.emitExecutionRevertedOnChain(
                    userOpHash,
                    transactionHash,
                    "0x",
                    1n
                )
            }
        })

        await expect(call(rpcHandler)).resolves.toEqual(receipt)
        expect(rpcHandler.bundleManager.getUserOpReceipt).toHaveBeenCalledWith(
            userOpHash
        )
    })

    it("ignores another op's events", async () => {
        const rpcHandler = makeRpcHandler()
        admitThen(({ eventManager }) => {
            eventManager.emitIncludedOnChain(
                `0x${"ef".repeat(32)}`,
                transactionHash,
                1n
            )
        })

        const err = await rpcErrorOf(call(rpcHandler, { timeoutMs: 50 }))
        expect(err.code).toBe(SyncUserOpErrors.Timeout)
    })

    it("returns Dropped with the reason when the op is dropped", async () => {
        const rpcHandler = makeRpcHandler()
        admitThen(({ eventManager }) => {
            eventManager.emitDropped(userOpHash, "AA25 invalid account nonce")
        })

        const err = await rpcErrorOf(call(rpcHandler))
        expect(err.code).toBe(SyncUserOpErrors.Dropped)
        expect(err.data).toEqual({
            userOpHash,
            reason: "AA25 invalid account nonce"
        })
    })

    it("returns Dropped when the op fails onchain", async () => {
        const rpcHandler = makeRpcHandler()
        admitThen(({ eventManager }) => {
            eventManager.emitFailedOnChain(userOpHash, transactionHash, 1n)
        })

        const err = await rpcErrorOf(call(rpcHandler))
        expect(err.code).toBe(SyncUserOpErrors.Dropped)
        expect(err.data).toEqual({ userOpHash, reason: "failed_onchain" })
    })

    it("times out with the hash when nothing settles", async () => {
        const rpcHandler = makeRpcHandler()
        admitThen(() => {})

        const started = Date.now()
        const err = await rpcErrorOf(call(rpcHandler, { timeoutMs: 50 }))
        expect(err.code).toBe(SyncUserOpErrors.Timeout)
        expect(err.data).toEqual({ userOpHash })
        expect(Date.now() - started).toBeLessThan(1_000)
    })

    it("clamps timeoutMs to the configured maximum", async () => {
        const rpcHandler = makeRpcHandler({ syncUseropMaxTimeoutMs: 50 })
        admitThen(() => {})

        const started = Date.now()
        const err = await rpcErrorOf(call(rpcHandler, { timeoutMs: 60_000 }))
        expect(err.code).toBe(SyncUserOpErrors.Timeout)
        expect(Date.now() - started).toBeLessThan(1_000)
    })

    it("propagates admission errors unchanged and stops watching", async () => {
        const rpcHandler = makeRpcHandler()
        const rejection = new RpcError(
            "AA23 reverted",
            ValidationErrors.SimulateValidation
        )
        submit.fn.mockImplementationOnce(async ({ onUserOpHash }) => {
            onUserOpHash(userOpHash)
            throw rejection
        })

        await expect(call(rpcHandler)).rejects.toBe(rejection)
        expect((rpcHandler.eventManager as any).watchers.size).toBe(0)
    })

    it("stops watching once it returns", async () => {
        const rpcHandler = makeRpcHandler()
        admitThen(({ eventManager }) => {
            eventManager.emitIncludedOnChain(userOpHash, transactionHash, 1n)
        })

        await call(rpcHandler)
        expect((rpcHandler.eventManager as any).watchers.size).toBe(0)
    })

    it("finds a receipt another instance produced when horizontally scaled", async () => {
        const rpcHandler = makeRpcHandler({
            enableHorizontalScaling: true,
            blockTime: 10
        })
        rpcHandler.bundleManager.getUserOpReceipt
            .mockResolvedValueOnce(null as any)
            .mockResolvedValueOnce(receipt)
        admitThen(() => {})

        await expect(call(rpcHandler, { timeoutMs: 5_000 })).resolves.toEqual(
            receipt
        )
    })
})
