import type { Address, HexData32, UserOpInfo } from "@alto/types"
import { Redis } from "ioredis"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../createConfig"
import { createRedisOutstandingQueue } from "./createRedisOutstandingStore"

vi.mock("ioredis", async () => {
    const ioredisMock = await import("ioredis-mock")
    return { Redis: ioredisMock.default, default: ioredisMock.default }
})

const chainId = 1
const entryPoint = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address
const redisEndpoint = "redis://127.0.0.1:6379/0"
const config = { chainId } as unknown as AltoConfig

// Mirrors the on-disk key layout in createRedisOutstandingStore.ts so the
// test can reach into the raw Redis state that the store itself writes.
const userOpHashLookupKey = `${chainId}:outstanding:user-op-hash-index:${entryPoint}`

const makeUserOpInfo = ({
    userOpHash,
    nonce = 0n
}: {
    userOpHash: HexData32
    nonce?: bigint
}): UserOpInfo => ({
    userOp: {
        sender: "0x1111111111111111111111111111111111111111",
        nonce,
        initCode: "0x",
        callData: "0x",
        callGasLimit: 100_000n,
        verificationGasLimit: 100_000n,
        preVerificationGas: 100_000n,
        maxPriorityFeePerGas: 1n,
        maxFeePerGas: 1n,
        paymasterAndData: "0x",
        signature: "0x"
    },
    userOpHash,
    addedToMempool: Date.now(),
    submissionAttempts: 0
})

describe("RedisOutstandingQueue.remove", () => {
    const redis = new Redis(redisEndpoint)

    beforeEach(async () => {
        await redis.flushall()
    })

    it("removes a normal record and leaves the sorted set empty", async () => {
        const store = createRedisOutstandingQueue({
            config,
            entryPoint,
            redisEndpoint
        })
        const userOpHash = `0x${"11".repeat(32)}` as HexData32
        const userOpInfo = makeUserOpInfo({ userOpHash })

        await store.add(userOpInfo)

        const pendingOpsKey = await redis.hget(userOpHashLookupKey, userOpHash)
        if (!pendingOpsKey) throw new Error("pendingOpsKey missing")

        const removed = await store.remove(userOpHash)

        expect(removed).toBe(true)
        expect(await redis.zrange(pendingOpsKey, 0, -1)).toEqual([])
        expect(await redis.hexists(userOpHashLookupKey, userOpHash)).toBe(0)
    })

    it("removes the ghost member left when the stored member has an " +
        "extra unknown field the zod schema strips on parse", async () => {
        const store = createRedisOutstandingQueue({
            config,
            entryPoint,
            redisEndpoint
        })
        const userOpHash = `0x${"22".repeat(32)}` as HexData32
        const userOpInfo = makeUserOpInfo({ userOpHash })

        await store.add(userOpInfo)

        const pendingOpsKey = await redis.hget(userOpHashLookupKey, userOpHash)
        if (!pendingOpsKey) throw new Error("pendingOpsKey missing")

        // Simulate a member written by a different build: same logical
        // record, but with an extra field that userOpInfoSchema.safeParse
        // silently drops. Re-serializing the parsed record would then
        // produce different bytes than what is actually stored.
        const [[rawMember, rawScore]] = (
            await redis.zrange(pendingOpsKey, 0, -1, "WITHSCORES")
        ).reduce<[string, string][]>((pairs, value, index, arr) => {
            if (index % 2 === 0) pairs.push([value, arr[index + 1]])
            return pairs
        }, [])

        const variantMember = JSON.stringify({
            ...JSON.parse(rawMember),
            futureField: 1
        })

        await redis.zrem(pendingOpsKey, rawMember)
        await redis.zadd(pendingOpsKey, Number(rawScore), variantMember)

        const removed = await store.remove(userOpHash)

        expect(removed).toBe(true)
        expect(await redis.zrange(pendingOpsKey, 0, -1)).toEqual([])
        expect(await redis.hexists(userOpHashLookupKey, userOpHash)).toBe(0)
    })

    it("restore reproduces the state sequential adds would leave", async () => {
        // ioredis-mock has no zmpop, so pop() cannot run here; the memory store
        // test covers pop inversion. In Redis every position is score-derived,
        // so restoring in original order must equal adding in that order.
        const redis = new Redis(redisEndpoint)
        const senderA = "0x1111111111111111111111111111111111111111" as Address
        const senderB = "0x2222222222222222222222222222222222222222" as Address
        const ops = [
            makeUserOpInfo({ userOpHash: `0x${"a1".repeat(32)}` as HexData32 }),
            makeUserOpInfo({
                userOpHash: `0x${"a2".repeat(32)}` as HexData32,
                nonce: 1n
            }),
            makeUserOpInfo({ userOpHash: `0x${"b1".repeat(32)}` as HexData32 })
        ]
        ops[0].userOp = { ...ops[0].userOp, sender: senderA, maxFeePerGas: 3n }
        ops[1].userOp = { ...ops[1].userOp, sender: senderA, maxFeePerGas: 3n }
        ops[2].userOp = { ...ops[2].userOp, sender: senderB, maxFeePerGas: 2n }

        const snapshot = async () => {
            const keys = (await redis.keys("*")).sort()
            const state: Record<string, unknown> = {}
            for (const key of keys) {
                const type = await redis.type(key)
                state[key] =
                    type === "zset"
                        ? await redis.zrange(key, 0, -1, "WITHSCORES")
                        : type === "hash"
                          ? await redis.hgetall(key)
                          : await redis.get(key)
            }
            return state
        }

        await redis.flushall()
        const added = createRedisOutstandingQueue({
            config,
            entryPoint,
            redisEndpoint
        })
        for (const op of ops) await added.add(op)
        const viaAdd = await snapshot()

        await redis.flushall()
        const restored = createRedisOutstandingQueue({
            config,
            entryPoint,
            redisEndpoint
        })
        await restored.restore(ops)
        const viaRestore = await snapshot()

        expect(Object.keys(viaRestore).length).toBeGreaterThan(0)
        expect(viaRestore).toEqual(viaAdd)
    })
})
