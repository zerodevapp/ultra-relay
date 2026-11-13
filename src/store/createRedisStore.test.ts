import { type AddressInfo, type Socket, connect, createServer } from "node:net"
import type { Address, HexData32, UserOpInfo } from "@alto/types"
import { Redis } from "ioredis"
import pino from "pino"
import { getAddress } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../createConfig"
import {
    STALE_SENDER_NONCE_MS,
    STALE_SUBMITTED_MS,
    createRedisStore
} from "./createRedisStore"

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

const redisUrl = process.env.REDIS_URL ?? ""

// Forwards to Redis. While frozen it holds every reply back: a connection that
// stays open but stops answering. Unfreezing delivers the held replies.
const startFreezableProxy = async (target: string) => {
    const { hostname, port } = new URL(target)
    let frozen = false
    const held: { client: Socket; data: Buffer }[] = []
    const server = createServer((client) => {
        const upstream = connect(Number(port), hostname)
        client.on("data", (data) => upstream.write(data))
        upstream.on("data", (data) => {
            if (frozen) {
                held.push({ client, data })
            } else {
                client.write(data)
            }
        })
        client.on("error", () => upstream.destroy())
        upstream.on("error", () => client.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port: proxyPort } = server.address() as AddressInfo
    return {
        url: `redis://127.0.0.1:${proxyPort}`,
        // The store has no way to close its client, so the proxy stays up
        // after the test; unfreezing lets that client catch up normally.
        setFrozen: (value: boolean) => {
            frozen = value
            if (!frozen) {
                for (const { client, data } of held.splice(0)) {
                    client.write(data)
                }
            }
        }
    }
}

// Records the commands Redis runs on keys under keyPrefix, Lua calls included.
// Reads MONITOR over a raw socket: ioredis's monitor mode can fail with
// "Command queue state error" when other test files write at the same time.
const watchCommands = async (target: string, keyPrefix: string) => {
    const { hostname, port } = new URL(target)
    const socket = connect(Number(port), hostname)
    const sentinel = `${keyPrefix}:monitor-sentinel`
    const commands: string[] = []
    let buffered = ""
    let onSentinel = () => {}
    socket.on("data", (data) => {
        buffered += data.toString()
        const lines = buffered.split("\r\n")
        buffered = lines.pop() ?? ""
        for (const line of lines) {
            const match = line.match(/\] "([^"]+)" "([^"]*)"/)
            if (!match?.[2].startsWith(keyPrefix)) {
                continue
            }
            if (match[2] === sentinel) {
                onSentinel()
            } else {
                commands.push(match[1].toLowerCase())
            }
        }
    })
    await new Promise<void>((resolve) => {
        socket.once("data", () => resolve())
        socket.write("MONITOR\r\n")
    })
    return {
        // Waits until Redis has echoed everything sent before this call.
        stop: async (client: Redis): Promise<string[]> => {
            const seen = new Promise<void>((resolve) => {
                onSentinel = resolve
            })
            await client.exists(sentinel)
            await seen
            socket.destroy()
            return commands
        }
    }
}

describe.skipIf(!redisUrl)("RedisStore stale entry eviction", () => {
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
            redisEndpoint: redisUrl,
            staleAfterMs:
                storeType === "processing"
                    ? STALE_SENDER_NONCE_MS
                    : STALE_SUBMITTED_MS
        })

    // Drops the owner and added-at keys, as an entry written before they
    // existed, or by a pod running the previous version, would look.
    const makeLegacy = async (storeType = "processing") => {
        const k = keys(storeType)
        await inspect.del(k.addedAt, k.owner)
    }

    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

    // Nonce keys sit in the upper 192 bits of the nonce.
    const nonceWithKey = (key: bigint, seq: bigint) => (key << 64n) | seq

    beforeEach(async () => {
        inspect = new Redis(redisUrl)
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

    it("keeps an entry just inside the timeout and evicts one just past it", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const store = newStore()
        await store.add(makeUserOpInfo(hash(1)))

        advance(STALE_SENDER_NONCE_MS - 60_000)
        const live = await store.findConflicting(makeUserOpInfo(hash(2)).userOp)
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

    it("keeps a submitted entry well past the processing timeout and evicts it after a day", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const store = newStore("submitted")
        await store.add(makeUserOpInfo(hash(1)))

        advance(STALE_SUBMITTED_MS - 60_000)
        const live = await store.findConflicting(makeUserOpInfo(hash(2)).userOp)
        expect(live?.reason).toBe("conflicting_nonce")
        expect(await store.contains(hash(1))).toBe(true)

        advance(120_000)
        const cleared = await store.findConflicting(
            makeUserOpInfo(hash(2)).userOp
        )

        expect(cleared).toBeUndefined()
        const k = keys("submitted")
        expect(await inspect.hlen(k.senderNonce)).toBe(0)
        expect(await inspect.hlen(k.hashIndex)).toBe(0)
    })

    it("fails a write instead of hanging when the connection stops answering", async () => {
        const proxy = await startFreezableProxy(redisUrl)
        try {
            const store = createRedisStore({
                config,
                entryPoint,
                storeType: "processing",
                redisEndpoint: proxy.url,
                staleAfterMs: STALE_SENDER_NONCE_MS,
                commandTimeoutMs: 200
            })
            await store.add(makeUserOpInfo(hash(1)))
            proxy.setFrozen(true)

            const outcome = await Promise.race([
                store.add(makeUserOpInfo(hash(2), 127n)).then(
                    () => "resolved",
                    (err: Error) => err.message
                ),
                new Promise((resolve) =>
                    setTimeout(() => resolve("still waiting"), 3000)
                )
            ])

            expect(outcome).toMatch(/timed out/i)
        } finally {
            proxy.setFrozen(false)
        }
    })

    it("clears a legacy entry's sender-nonce when an identical resend evicts it", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const store = newStore()
        await store.add(makeUserOpInfo(hash(1)))
        await makeLegacy()

        expect(await store.contains(hash(1))).toBe(true)
        advance(STALE_SENDER_NONCE_MS + 1)
        expect(await store.contains(hash(1))).toBe(false)

        const k = keys()
        expect(await inspect.hlen(k.senderNonce)).toBe(0)
        expect(
            await store.findConflicting(makeUserOpInfo(hash(2)).userOp)
        ).toBeUndefined()
    })

    it("does not let a late remove drop an identical copy re-added after eviction", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const slowPod = newStore()
        const otherPod = newStore()
        await slowPod.add(makeUserOpInfo(hash(1)))

        advance(STALE_SENDER_NONCE_MS + 1)
        expect(await otherPod.contains(hash(1))).toBe(false)
        await otherPod.add(makeUserOpInfo(hash(1)))

        expect(await slowPod.remove(hash(1))).toBe(false)

        expect(await otherPod.contains(hash(1))).toBe(true)
        const conflict = await otherPod.findConflicting(
            makeUserOpInfo(hash(2)).userOp
        )
        expect(conflict?.reason).toBe("conflicting_nonce")
        expect(await otherPod.remove(hash(1))).toBe(true)
    })

    it("ignores an owner record left behind by a pod that does not write owners", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const store = newStore()
        const k = keys()
        const senderNonce = `${sender}-126`
        await store.add(makeUserOpInfo(hash(1)))
        // A previous-version pod removes the op: it deletes the hash
        // index and sender-nonce entries but not the owner or added-at.
        await inspect.hdel(k.hashIndex, hash(1))
        await inspect.hdel(k.senderNonce, senderNonce)

        advance(STALE_SENDER_NONCE_MS + 1)
        // A previous-version pod then adds a new op at that nonce: an add
        // with its owner and added-at writes undone.
        await newStore().add(makeUserOpInfo(hash(2)))
        await inspect.hset(k.owner, senderNonce, hash(1))
        await inspect.hdel(k.addedAt, hash(2))

        const conflict = await store.findConflicting(
            makeUserOpInfo(hash(3)).userOp
        )

        expect(conflict?.reason).toBe("conflicting_nonce")
        expect(await inspect.hget(k.owner, senderNonce)).toBe(hash(2))
    })

    it("backfills a legacy owner without blocking Redis on a full scan", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const store = newStore()
        await store.add(makeUserOpInfo(hash(1)))
        await makeLegacy()

        const watch = await watchCommands(redisUrl, prefix)
        const blocked = await store.findConflicting(
            makeUserOpInfo(hash(2)).userOp
        )
        const commands = await watch.stop(inspect)

        expect(blocked?.reason).toBe("conflicting_nonce")
        expect(await inspect.hget(keys().owner, `${sender}-126`)).toBe(hash(1))
        expect(commands).toContain("hscan")
        expect(commands).not.toContain("hgetall")
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
        expect(await inspect.hget(keys().owner, `${sender}-126`)).toBe(hash(2))
    })

    it("evicts without scanning the hash index", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        const store = newStore()
        await store.add(makeUserOpInfo(hash(1)))
        advance(STALE_SENDER_NONCE_MS + 1)

        // Other test files share this Redis; only this test's keys count.
        const watch = await watchCommands(redisUrl, prefix)
        await store.findConflicting(makeUserOpInfo(hash(2)).userOp)
        const commands = await watch.stop(inspect)

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
})
