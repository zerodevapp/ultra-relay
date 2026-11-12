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

const makeUserOpInfo = (
    userOpHash: HexData32,
    nonce = 126n,
    { deployment = false }: { deployment?: boolean } = {}
): UserOpInfo => ({
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
        factory: deployment
            ? getAddress("0xd703aae79538628d27099b8c4f621be4ccd142d5")
            : null,
        factoryData: deployment ? "0x01" : null,
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
    "RedisStore stale entry eviction",
    () => {
        let inspect: Redis
        let prefix: string
        let config: AltoConfig

        const keys = (storeType = "processing") => {
            const base = `${prefix}:8453:${storeType}`
            return {
                senderNonce: `${base}:sender-nonce-lookup:${entryPoint}`,
                owner: `${base}:sender-nonce-owner:${entryPoint}`,
                addedAt: `${base}:added-at:${entryPoint}`,
                hashIndex: `${base}:user-op-hash-index:${entryPoint}`,
                factory: `${base}:factory-lookup:${entryPoint}`
            }
        }

        const newStore = (storeType = "processing") =>
            createRedisStore({
                config,
                entryPoint,
                storeType,
                redisEndpoint: redisUrl(),
                staleAfterMs:
                    storeType === "processing"
                        ? STALE_SENDER_NONCE_MS
                        : undefined
            })

        const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

        // Nonce keys sit in the upper 192 bits of the nonce.
        const nonceWithKey = (key: bigint, seq: bigint) => (key << 64n) | seq

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

        it("keeps an entry just inside the timeout and evicts one just past it", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))

            advance(STALE_SENDER_NONCE_MS - 60_000)
            const live = await store.findConflicting(
                makeUserOpInfo(hash(2)).userOp
            )
            expect(live?.reason).toBe("conflicting_nonce")

            advance(120_000)
            const cleared = await store.findConflicting(
                makeUserOpInfo(hash(2)).userOp
            )

            expect(cleared).toBeUndefined()
            const k = keys()
            expect(await inspect.hlen(k.senderNonce)).toBe(0)
            expect(await inspect.hlen(k.owner)).toBe(0)
            expect(await inspect.hlen(k.addedAt)).toBe(0)
            expect(await inspect.hlen(k.hashIndex)).toBe(0)
        })

        it("never evicts from the submitted store", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore("submitted")
            await store.add(makeUserOpInfo(hash(1)))

            advance(3 * STALE_SENDER_NONCE_MS)

            const conflict = await store.findConflicting(
                makeUserOpInfo(hash(2)).userOp
            )
            expect(conflict?.reason).toBe("conflicting_nonce")
            expect(await store.contains(hash(1))).toBe(true)
        })

        it("lets an identical resend through once the original is stale", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))

            expect(await store.contains(hash(1))).toBe(true)

            advance(STALE_SENDER_NONCE_MS + 1)

            expect(await store.contains(hash(1))).toBe(false)
            const k = keys()
            expect(await inspect.hlen(k.hashIndex)).toBe(0)
            expect(await inspect.hlen(k.senderNonce)).toBe(0)
        })

        it("drops the factory entry with an evicted deployment", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1), 126n, { deployment: true }))

            advance(STALE_SENDER_NONCE_MS + 1)
            const cleared = await store.findConflicting(
                makeUserOpInfo(hash(2), 126n, { deployment: true }).userOp
            )

            expect(cleared).toBeUndefined()
            expect(await inspect.hlen(keys().factory)).toBe(0)
        })

        it("stops a stale deployment blocking a deployment on another nonce key", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(
                makeUserOpInfo(hash(1), nonceWithKey(1n, 0n), {
                    deployment: true
                })
            )
            const retry = makeUserOpInfo(hash(2), nonceWithKey(2n, 0n), {
                deployment: true
            }).userOp

            const blocked = await store.findConflicting(retry)
            expect(blocked?.reason).toBe("conflicting_deployment")

            advance(STALE_SENDER_NONCE_MS + 1)
            const cleared = await store.findConflicting(retry)

            expect(cleared).toBeUndefined()
            const k = keys()
            expect(await inspect.hlen(k.factory)).toBe(0)
            expect(await inspect.hlen(k.hashIndex)).toBe(0)
            expect(await inspect.hlen(k.senderNonce)).toBe(0)
        })

        it("does not let a dead owner's late remove drop the replacement's entries", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))

            advance(STALE_SENDER_NONCE_MS + 1)
            expect(
                await store.findConflicting(makeUserOpInfo(hash(2)).userOp)
            ).toBeUndefined()
            await store.add(makeUserOpInfo(hash(2)))

            expect(await store.remove(hash(1))).toBe(false)

            const conflict = await store.findConflicting(
                makeUserOpInfo(hash(3)).userOp
            )
            expect(conflict?.reason).toBe("conflicting_nonce")
            expect(await inspect.hget(keys().owner, `${sender}-126`)).toBe(
                hash(2)
            )
        })

        it("evicts without scanning the hash index", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))
            advance(STALE_SENDER_NONCE_MS + 1)

            const monitor = await new Redis(redisUrl()).monitor()
            const commands: string[] = []
            // Other test files share this Redis; keep only this test's keys.
            monitor.on("monitor", (_time, args: string[]) => {
                if (String(args[1]).startsWith(prefix)) {
                    commands.push(String(args[0]).toLowerCase())
                }
            })

            await store.findConflicting(makeUserOpInfo(hash(2)).userOp)
            await inspect.ping()
            monitor.disconnect()

            expect(commands).toContain("hdel")
            expect(commands).not.toContain("hgetall")
        })

        // The prod orphan: written before the owner and added-at keys
        // existed, its owner gone, so no add or remove will touch it again.
        it("starts the clock on a legacy entry and evicts it one timeout later", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))
            const k = keys()
            await inspect.del(k.addedAt, k.owner)

            const blocked = await store.findConflicting(
                makeUserOpInfo(hash(2)).userOp
            )
            expect(blocked?.reason).toBe("conflicting_nonce")
            expect(await inspect.hget(k.owner, `${sender}-126`)).toBe(hash(1))

            advance(STALE_SENDER_NONCE_MS + 1)
            const cleared = await store.findConflicting(
                makeUserOpInfo(hash(2)).userOp
            )

            expect(cleared).toBeUndefined()
            expect(await inspect.hlen(k.senderNonce)).toBe(0)
            expect(await inspect.hlen(k.hashIndex)).toBe(0)
            expect(await inspect.hlen(k.owner)).toBe(0)
        })

        it("evicts a legacy sender-nonce entry with no hash index entry", async () => {
            vi.useFakeTimers({ toFake: ["Date"] })
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))
            const k = keys()
            await inspect.del(k.addedAt, k.owner, k.hashIndex)

            expect(
                (await store.findConflicting(makeUserOpInfo(hash(2)).userOp))
                    ?.reason
            ).toBe("conflicting_nonce")

            advance(STALE_SENDER_NONCE_MS + 1)

            expect(
                await store.findConflicting(makeUserOpInfo(hash(2)).userOp)
            ).toBeUndefined()
            expect(await inspect.hlen(k.senderNonce)).toBe(0)
        })

        it("removes a legacy entry the owner still holds", async () => {
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1)))
            const k = keys()
            await inspect.del(k.addedAt, k.owner)

            expect(await store.remove(hash(1))).toBe(true)

            expect(await inspect.hlen(k.senderNonce)).toBe(0)
            expect(await inspect.hlen(k.hashIndex)).toBe(0)
        })

        it("removes every key when the owner removes the entry", async () => {
            const store = newStore()
            await store.add(makeUserOpInfo(hash(1), 126n, { deployment: true }))

            expect(await store.remove(hash(1))).toBe(true)

            const k = keys()
            for (const key of Object.values(k)) {
                expect(await inspect.hlen(key)).toBe(0)
            }
        })
    }
)
