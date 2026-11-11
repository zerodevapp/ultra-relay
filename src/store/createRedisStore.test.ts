import type { Address, HexData32, UserOpInfo } from "@alto/types"
import { Redis } from "ioredis"
import pino from "pino"
import { getAddress } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../createConfig"
import { STALE_SENDER_NONCE_MS, createRedisStore } from "./createRedisStore"

// Runs against a real Redis because eviction is a Lua script. REDIS_URL must
// name a disposable server; each test uses its own key prefix.

const entryPoint = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address
const sender = getAddress("0x8353e73573194d9275d82f775d248d30235e403a")

const makeUserOpInfo = (userOpHash: HexData32, nonce = 126n): UserOpInfo => ({
    userOp: {
        sender,
        nonce,
        callData: "0x",
        callGasLimit: 100_000n,
        verificationGasLimit: 100_000n,
        preVerificationGas: 100_000n,
        maxPriorityFeePerGas: 1n,
        maxFeePerGas: 1n,
        signature: "0x",
        factory: null,
        factoryData: null,
        paymaster: null,
        paymasterData: null,
        paymasterVerificationGasLimit: null,
        paymasterPostOpGasLimit: null
    },
    userOpHash,
    addedToMempool: Date.now(),
    submissionAttempts: 0
})

const hash = (n: number): HexData32 =>
    `0x${n.toString(16).padStart(64, "0")}` as HexData32

const redisUrl = (): string => {
    const url = process.env.REDIS_URL
    if (!url) {
        throw new Error("REDIS_URL is not set")
    }
    return url
}

describe.skipIf(!process.env.REDIS_URL)(
    "RedisStore stale sender-nonce eviction",
    () => {
        let inspect: Redis
        let prefix: string
        let config: AltoConfig

        const keys = () => {
            const base = `${prefix}:8453:processing`
            return {
                senderNonce: `${base}:sender-nonce-lookup:${entryPoint}`,
                addedAt: `${base}:sender-nonce-added-at:${entryPoint}`,
                hashIndex: `${base}:user-op-hash-index:${entryPoint}`
            }
        }

        const newStore = () =>
            createRedisStore({
                config,
                entryPoint,
                storeType: "processing",
                redisEndpoint: redisUrl()
            })

        beforeEach(async () => {
            inspect = new Redis(redisUrl())
            prefix = `stale-test-${Math.random().toString(36).slice(2)}`
            config = {
                chainId: 8453,
                redisKeyPrefix: prefix,
                logLevel: "silent",
                getLogger: () => pino({ level: "silent" })
            } as unknown as AltoConfig
        })

        afterEach(async () => {
            vi.useRealTimers()
            const found = await inspect.keys(`${prefix}:*`)
            if (found.length > 0) {
                await inspect.del(...found)
            }
            inspect.disconnect()
        })

        it("still reports a fresh entry as a conflict", async () => {
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))

            const conflict = await store.findConflicting(
                makeUserOpInfo(hash(2)).userOp
            )

            expect(conflict?.reason).toBe("conflicting_nonce")
        })

        it("evicts an entry older than the timeout and clears its hash index", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))

            vi.setSystemTime(Date.now() + STALE_SENDER_NONCE_MS + 1)
            const conflict = await store.findConflicting(
                makeUserOpInfo(hash(2)).userOp
            )

            expect(conflict).toBeUndefined()
            const k = keys()
            expect(await inspect.hlen(k.senderNonce)).toBe(0)
            expect(await inspect.hlen(k.addedAt)).toBe(0)
            expect(await inspect.hlen(k.hashIndex)).toBe(0)
        })

        // The prod orphan: written before the timestamp key existed, its
        // owner gone, so no add or remove will ever touch it again.
        it("starts the clock on a legacy entry and evicts it one timeout later", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))
            const k = keys()
            await inspect.del(k.addedAt)

            const blocked = await store.findConflicting(
                makeUserOpInfo(hash(2)).userOp
            )
            expect(blocked?.reason).toBe("conflicting_nonce")

            vi.setSystemTime(Date.now() + STALE_SENDER_NONCE_MS + 1)
            const cleared = await store.findConflicting(
                makeUserOpInfo(hash(2)).userOp
            )

            expect(cleared).toBeUndefined()
            expect(await inspect.hlen(k.senderNonce)).toBe(0)
            expect(await inspect.hlen(k.hashIndex)).toBe(0)
        })

        it("removes the timestamp when the owner removes the entry", async () => {
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))

            expect(await store.remove(hash(1))).toBe(true)

            expect(await inspect.hlen(keys().addedAt)).toBe(0)
        })
    }
)
