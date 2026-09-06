import type { UserOpInfo } from "@alto/types"
import type { Address } from "viem"
import { describe, expect, it, vi } from "vitest"
import { Mempool } from "./mempool"

const entryPoint = `0x${"22".repeat(20)}` as Address

function op(index: number, extra: Partial<UserOpInfo> = {}): UserOpInfo {
    return {
        userOp: {
            sender: `0x${index.toString(16).padStart(40, "0")}`,
            nonce: 0n,
            initCode: "0x",
            callData: "0x",
            callGasLimit: 100_000n,
            verificationGasLimit: 100_000n,
            preVerificationGas: 50_000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            paymasterAndData: "0x",
            signature: "0x"
        },
        userOpHash: `0x${index.toString(16).padStart(64, "0")}`,
        addedToMempool: 0,
        submissionAttempts: 0,
        ...extra
    } as UserOpInfo
}

// A first-in-first-out store records every call so the test can assert both
// the bundle composition and when deferred operations return to the queue.
function fifoStore(initial: UserOpInfo[]) {
    const queue = [...initial]
    const calls: string[] = []
    return {
        queue,
        calls,
        peekOutstanding: vi.fn(async () => queue[0]),
        popOutstanding: vi.fn(async () => {
            const info = queue.shift()
            if (info) calls.push(`pop:${info.userOpHash}`)
            return info
        }),
        addOutstanding: vi.fn(
            async ({ userOpInfo }: { userOpInfo: UserOpInfo }) => {
                calls.push(`add:${userOpInfo.userOpHash}`)
                queue.push(userOpInfo)
            }
        ),
        addProcessing: vi.fn(
            async ({ userOpInfo }: { userOpInfo: UserOpInfo }) => {
                calls.push(`processing:${userOpInfo.userOpHash}`)
            }
        ),
        dumpOutstanding: vi.fn(async () => [...queue])
    }
}

function fixture(initial: UserOpInfo[]) {
    const mempool = Object.create(Mempool.prototype) as Mempool
    const store = fifoStore(initial)
    Object.assign(mempool, {
        config: {
            safeMode: false,
            chainId: 412346,
            chainType: "default",
            entrypoints: [entryPoint],
            maxGasPerBundle: 30_000_000n
        },
        store,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        },
        reputationManager: { decreaseUserOpCount: vi.fn() }
    })
    return { mempool, store }
}

describe("infrastructure backoff during bundling", () => {
    it("holds a backing-off operation aside, bundles the rest, and re-queues it after the tick", async () => {
        const waiting = op(1, {
            retryAfter: Date.now() + 60_000,
            infrastructureRetries: 1
        })
        const { mempool, store } = fixture([waiting, op(2), op(3)])

        const bundles = await mempool.process({
            maxGasLimit: 30_000_000n,
            entryPoint,
            minOpsPerBundle: 1
        })

        expect(bundles.map((b) => b.userOps.map((o) => o.userOpHash))).toEqual([
            [op(2).userOpHash, op(3).userOpHash]
        ])
        // The deferred operation goes back only after every other operation
        // was considered, so it can never end the tick early by being popped
        // twice through the reentry guard.
        expect(store.calls).toEqual([
            `pop:${waiting.userOpHash}`,
            `pop:${op(2).userOpHash}`,
            `processing:${op(2).userOpHash}`,
            `pop:${op(3).userOpHash}`,
            `processing:${op(3).userOpHash}`,
            `add:${waiting.userOpHash}`
        ])
        expect(store.queue.map((o) => o.userOpHash)).toEqual([
            waiting.userOpHash
        ])
    })

    it("bundles an operation whose backoff has elapsed", async () => {
        const ready = op(1, {
            retryAfter: Date.now() - 1,
            infrastructureRetries: 2
        })
        const { mempool, store } = fixture([ready])

        const bundles = await mempool.process({
            maxGasLimit: 30_000_000n,
            entryPoint,
            minOpsPerBundle: 1
        })

        expect(bundles[0].userOps.map((o) => o.userOpHash)).toEqual([
            ready.userOpHash
        ])
        expect(store.addOutstanding).not.toHaveBeenCalled()
    })
})
