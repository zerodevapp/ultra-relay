import { randomUUID } from "node:crypto"
import {
    type Address,
    type HexData32,
    type UserOpInfo,
    type UserOperation,
    userOpInfoSchema
} from "@alto/types"
import { Redis } from "ioredis"
import { type Hex, getAddress, slice, toHex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OutstandingStore } from "."
import { getRedisStorePrefix } from "../cli/config/redisKeys"
import type { AltoConfig } from "../createConfig"
import {
    getNonceKeyAndSequence,
    isVersion06,
    isVersion07
} from "../utils/userop"
import { createRedisOutstandingQueue } from "./createRedisOutstandingStore"

// Contract tests for RedisOutstandingQueue.pop() against a real Redis.
// ioredis-mock has no cjson, so the pop script cannot run there. REDIS_URL
// must name a disposable server: the cache-loss test runs SCRIPT FLUSH.
// Tests in this file run sequentially (vitest's default within a file).

type Version = "0.6" | "0.7" | "0.8"

const VERSIONS: Version[] = ["0.6", "0.7", "0.8"]

const ENTRY_POINTS: Record<Version, Address> = {
    "0.6": "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    "0.7": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    "0.8": "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108"
}

const FACTORY = getAddress(`0x${"fa".repeat(20)}`)
const DEPLOYMENT_INIT_CODE: Hex = `${FACTORY}1234`

const hash = (n: number): HexData32 =>
    `0x${n.toString(16).padStart(64, "0")}` as HexData32

const address = (n: number): Address =>
    getAddress(`0x${n.toString(16).padStart(40, "0")}`)

const makeUserOpInfo = ({
    version = "0.6",
    userOpHash,
    sender,
    nonce = 0n,
    maxFeePerGas = 1n,
    initCode = "0x"
}: {
    version?: Version
    userOpHash: HexData32
    sender: Address
    nonce?: bigint
    maxFeePerGas?: bigint
    initCode?: Hex
}): UserOpInfo => {
    const common = {
        sender,
        nonce,
        callData: "0x" as Hex,
        callGasLimit: 100_000n,
        verificationGasLimit: 100_000n,
        preVerificationGas: 100_000n,
        maxPriorityFeePerGas: 1n,
        maxFeePerGas,
        signature: "0x" as Hex
    }
    const isDeploymentFixture = initCode !== "0x"
    const userOp: UserOperation =
        version === "0.6"
            ? { ...common, initCode, paymasterAndData: "0x" }
            : {
                  ...common,
                  factory: isDeploymentFixture
                      ? getAddress(slice(initCode, 0, 20))
                      : null,
                  factoryData: isDeploymentFixture ? slice(initCode, 20) : null,
                  paymaster: null,
                  paymasterData: null,
                  paymasterVerificationGasLimit: null,
                  paymasterPostOpGasLimit: null
              }
    return {
        userOp,
        userOpHash,
        addedToMempool: 1000,
        submissionAttempts: 0
    }
}

type QueueKeys = { ready: string; hashes: string; factories: string }

type Queue = {
    store: OutstandingStore
    // The store's private client; used only to observe its requests.
    redis: Redis
    redisKeyPrefix: string
    storePrefix: string
    entryPoint: Address
    keys: QueueKeys
    slotKey: (sender: Address, nonce: bigint) => string
}

type Snapshot = Record<string, unknown>

const scanKeys = async (redis: Redis, pattern: string): Promise<string[]> => {
    const found = new Set<string>()
    let cursor = "0"
    do {
        const [next, keys] = await redis.scan(
            cursor,
            "MATCH",
            pattern,
            "COUNT",
            1000
        )
        for (const key of keys) {
            found.add(key)
        }
        cursor = next
    } while (cursor !== "0")
    return [...found]
}

// Full state of one queue prefix. Only the run's own prefix is normalized
// (in key names and in values that are key names); raw sorted-set members
// and scores are kept in rank order.
const snapshot = async (redis: Redis, queue: Queue): Promise<Snapshot> => {
    const keys = (await scanKeys(redis, `${queue.redisKeyPrefix}:*`)).sort()
    const normalize = (value: string) =>
        value.replaceAll(queue.storePrefix, "PREFIX")
    const result: Snapshot = {}
    for (const key of keys) {
        const type = await redis.type(key)
        let value: string[] | [string, string][]
        if (type === "hash") {
            value = Object.entries(await redis.hgetall(key)).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0
            )
        } else if (type === "zset") {
            value = await redis.zrange(key, 0, -1, "WITHSCORES")
        } else {
            throw new Error(`unexpected key type ${type} for ${key}`)
        }
        result[normalize(key)] = JSON.parse(normalize(JSON.stringify(value)))
    }
    return result
}

const isDeployment = (userOp: UserOperation): boolean => {
    const isV6Deployment =
        isVersion06(userOp) && !!userOp.initCode && userOp.initCode !== "0x"
    const isV7Deployment =
        isVersion07(userOp) && !!userOp.factory && userOp.factory !== "0x"
    return isV6Deployment || isV7Deployment
}

// Frozen copy of the baseline (ba8d4cf) pop(), run on the test's own client
// with explicit key paths. Used as the reference side of the state
// equivalence regression; it never calls store.pop().
const referencePop = async (
    redis: Redis,
    keys: QueueKeys
): Promise<UserOpInfo | undefined> => {
    type ZmpopResult = [string, [string, string][]] | null
    const popped = (await redis.zmpop(
        1,
        [keys.ready],
        "MAX",
        "COUNT",
        1
    )) as ZmpopResult
    const pendingOpsKey =
        popped && popped[1].length > 0 ? popped[1][0][0] : undefined
    if (!pendingOpsKey) {
        return undefined
    }

    const ops = await redis.zrange(pendingOpsKey, 0, 1)
    if (ops.length === 0) {
        return undefined
    }

    const current = userOpInfoSchema.parse(JSON.parse(ops[0]))
    const multi = redis.multi()
    if (isDeployment(current.userOp)) {
        multi.hdel(keys.factories, current.userOp.sender)
    }
    multi.zrem(pendingOpsKey, ops[0])
    multi.hdel(keys.hashes, current.userOpHash)
    await multi.exec()

    if (ops.length > 1) {
        const next = userOpInfoSchema.parse(JSON.parse(ops[1]))
        await redis.zadd(
            keys.ready,
            Number(next.userOp.maxFeePerGas),
            pendingOpsKey
        )
    } else {
        await redis.del(pendingOpsKey)
    }
    return current
}

const redisUrl = (): string => {
    const url = process.env.REDIS_URL
    if (!url) {
        throw new Error("REDIS_URL is not set")
    }
    return url
}

describe.skipIf(!process.env.REDIS_URL)(
    "RedisOutstandingQueue.pop against a real Redis",
    () => {
        let inspect: Redis
        let clients: Redis[] = []
        let redisKeyPrefixes: string[] = []

        beforeEach(async () => {
            clients = []
            redisKeyPrefixes = []
            inspect = new Redis(redisUrl())
            clients.push(inspect)
            await inspect.ping()
        })

        afterEach(async () => {
            vi.restoreAllMocks()
            try {
                for (const prefix of redisKeyPrefixes) {
                    const keys = await scanKeys(inspect, `${prefix}:*`)
                    if (keys.length > 0) {
                        await inspect.del(...keys)
                    }
                }
            } finally {
                for (const client of clients) {
                    client.disconnect()
                }
            }
        })

        // Creates a store on a unique prefix (or a shared one, for the
        // two-consumer case) and awaits PING on its private client so the
        // connection handshake is never counted as a pop request.
        const newQueue = async ({
            version = "0.6",
            redisKeyPrefix = `pop-script-test-${randomUUID()}`
        }: {
            version?: Version
            redisKeyPrefix?: string
        } = {}): Promise<Queue> => {
            const config = {
                chainId: 1,
                redisKeyPrefix
            } as unknown as AltoConfig
            const entryPoint = ENTRY_POINTS[version]
            const storePrefix = getRedisStorePrefix(config)
            const store = createRedisOutstandingQueue({
                config,
                entryPoint,
                redisEndpoint: redisUrl()
            })
            const { redis } = store as unknown as { redis: Redis }
            clients.push(redis)
            if (!redisKeyPrefixes.includes(redisKeyPrefix)) {
                redisKeyPrefixes.push(redisKeyPrefix)
            }
            await redis.ping()
            const outstanding = `${storePrefix}:outstanding`
            return {
                store,
                redis,
                redisKeyPrefix,
                storePrefix,
                entryPoint,
                keys: {
                    ready: `${outstanding}:pending-queue:${entryPoint}`,
                    hashes: `${outstanding}:user-op-hash-index:${entryPoint}`,
                    factories: `${outstanding}:factory-lookup:${entryPoint}`
                },
                slotKey: (sender, nonce) => {
                    const [nonceKey] = getNonceKeyAndSequence(nonce)
                    return `${outstanding}:pending-ops:${entryPoint}:${sender}-${toHex(nonceKey)}`
                }
            }
        }

        it("returns undefined on an empty queue with one request", async () => {
            const q = await newQueue()
            expect(await snapshot(inspect, q)).toEqual({})
            const sendCommand = vi.spyOn(q.redis, "sendCommand")

            expect(await q.store.pop()).toBeUndefined()

            expect(sendCommand).toHaveBeenCalledTimes(1)
            expect(await snapshot(inspect, q)).toEqual({})
        })

        it.each(VERSIONS)(
            "pops by fee, then nonce, and reranks the slot (v%s)",
            async (version) => {
                const q = await newQueue({ version })
                const a = address(0xa)
                const a0 = makeUserOpInfo({
                    version,
                    userOpHash: hash(1),
                    sender: a,
                    nonce: 0n,
                    maxFeePerGas: 30n
                })
                const a1 = makeUserOpInfo({
                    version,
                    userOpHash: hash(2),
                    sender: a,
                    nonce: 1n,
                    maxFeePerGas: 1n
                })
                const b0 = makeUserOpInfo({
                    version,
                    userOpHash: hash(3),
                    sender: address(0xb),
                    maxFeePerGas: 20n
                })
                const c0 = makeUserOpInfo({
                    version,
                    userOpHash: hash(4),
                    sender: address(0xc),
                    maxFeePerGas: 10n
                })
                for (const op of [a0, a1, b0, c0]) {
                    await q.store.add(op)
                }
                const slotA = q.slotKey(a, 0n)

                expect(await q.store.pop()).toEqual(a0)
                expect(await inspect.zscore(q.keys.ready, slotA)).toBe("1")
                expect(await inspect.hexists(q.keys.hashes, hash(1))).toBe(0)

                expect(await q.store.pop()).toEqual(b0)
                expect(await q.store.pop()).toEqual(c0)
                expect(await q.store.pop()).toEqual(a1)
                expect(await inspect.exists(slotA)).toBe(0)
                expect(await inspect.zscore(q.keys.ready, slotA)).toBeNull()

                expect(await q.store.pop()).toBeUndefined()
                expect(await snapshot(inspect, q)).toEqual({})
            }
        )

        it("breaks ready-score ties by greatest slot key", async () => {
            const q = await newQueue()
            const first = makeUserOpInfo({
                userOpHash: hash(1),
                sender: address(0x1),
                maxFeePerGas: 10n
            })
            const second = makeUserOpInfo({
                userOpHash: hash(2),
                sender: address(0x2),
                maxFeePerGas: 10n
            })
            await q.store.add(first)
            await q.store.add(second)
            const firstKey = q.slotKey(first.userOp.sender, 0n)
            const secondKey = q.slotKey(second.userOp.sender, 0n)
            const [greater, lesser] =
                firstKey > secondKey ? [first, second] : [second, first]

            expect((await q.store.pop())?.userOpHash).toBe(greater.userOpHash)
            expect((await q.store.pop())?.userOpHash).toBe(lesser.userOpHash)
            expect(await q.store.pop()).toBeUndefined()
        })

        it("breaks equal nonce scores by smallest raw member", async () => {
            const q = await newQueue()
            const sender = address(0x1)
            // Same sender and nonce: both members get nonce score 0 and
            // differ only in their raw bytes.
            const high = makeUserOpInfo({ userOpHash: hash(0xff), sender })
            const low = makeUserOpInfo({ userOpHash: hash(0x01), sender })
            await q.store.add(high)
            await q.store.add(low)
            const slot = q.slotKey(sender, 0n)
            const raw = await inspect.zrange(slot, 0, -1, "WITHSCORES")
            expect([raw[1], raw[3]]).toEqual(["0", "0"])
            const smallest = [raw[0], raw[2]].sort()[0]
            const expectedFirst = userOpInfoSchema.parse(JSON.parse(smallest))
            const expectedSecond =
                expectedFirst.userOpHash === high.userOpHash ? low : high

            expect((await q.store.pop())?.userOpHash).toBe(
                expectedFirst.userOpHash
            )
            expect((await q.store.pop())?.userOpHash).toBe(
                expectedSecond.userOpHash
            )
            expect(await q.store.pop()).toBeUndefined()
        })

        it("removes the exact stored bytes of a member", async () => {
            const q = await newQueue()
            const op = makeUserOpInfo({
                userOpHash: hash(1),
                sender: address(0x1)
            })
            await q.store.add(op)
            const slot = q.slotKey(op.userOp.sender, 0n)
            const [rawMember, rawScore] = await inspect.zrange(
                slot,
                0,
                -1,
                "WITHSCORES"
            )
            const variant = JSON.stringify({
                ...JSON.parse(rawMember),
                futureField: 1
            })
            await inspect.zrem(slot, rawMember)
            await inspect.zadd(slot, Number(rawScore), variant)

            expect(await q.store.pop()).toEqual(op)

            expect(await inspect.zscore(slot, variant)).toBeNull()
            expect(await inspect.exists(slot)).toBe(0)
            expect(await inspect.hexists(q.keys.hashes, hash(1))).toBe(0)
        })

        it("skips and drops stale ready entries", async () => {
            const q = await newQueue()
            const live = makeUserOpInfo({
                userOpHash: hash(1),
                sender: address(0x1),
                maxFeePerGas: 10n
            })
            await q.store.add(live)
            const stale = (n: number) =>
                `${q.storePrefix}:outstanding:pending-ops:${q.entryPoint}:stale-${n}`
            await inspect.zadd(q.keys.ready, 100, stale(1), 200, stale(2))

            expect((await q.store.pop())?.userOpHash).toBe(hash(1))
            expect(await inspect.zrange(q.keys.ready, 0, -1)).toEqual([])

            await inspect.zadd(q.keys.ready, 100, stale(3), 200, stale(4))

            expect(await q.store.pop()).toBeUndefined()
            expect(await inspect.exists(q.keys.ready)).toBe(0)
        })

        it("pins the first-peek limitation for a stale entry below a live slot", async () => {
            const q = await newQueue()
            const live = makeUserOpInfo({
                userOpHash: hash(1),
                sender: address(0x1),
                maxFeePerGas: 10n
            })
            await q.store.add(live)
            await inspect.zadd(
                q.keys.ready,
                5,
                `${q.storePrefix}:outstanding:pending-ops:${q.entryPoint}:stale`
            )

            expect(await q.store.peek()).toBeUndefined()
            expect(await q.store.pop()).toEqual(live)
        })

        it("reranks by the successor fee without losing precision", async () => {
            const fees = [
                0n,
                1n,
                (1n << 53n) - 1n,
                1n << 53n,
                (1n << 53n) + 1n,
                0xfffffffffffff7bn,
                (1n << 64n) - 1n,
                1n << 64n,
                (1n << 64n) + 1n,
                0x20000000000000001n,
                1n << 80n,
                (1n << 128n) - 1n,
                (1n << 256n) - 1n
            ]
            const q = await newQueue()
            const sender = address(0x1)
            const slot = q.slotKey(sender, 0n)
            for (const [i, fee] of fees.entries()) {
                const head = makeUserOpInfo({
                    userOpHash: hash(2 * i + 1),
                    sender,
                    nonce: 0n
                })
                const successor = makeUserOpInfo({
                    userOpHash: hash(2 * i + 2),
                    sender,
                    nonce: 1n,
                    maxFeePerGas: fee
                })
                await q.store.add(head)
                await q.store.add(successor)

                expect((await q.store.pop())?.userOpHash).toBe(head.userOpHash)
                const score = await inspect.zscore(q.keys.ready, slot)
                expect(
                    Number(score),
                    `fee 0x${fee.toString(16)} score ${score}`
                ).toBe(Number(fee))

                expect((await q.store.pop())?.userOpHash).toBe(
                    successor.userOpHash
                )
                expect(await snapshot(inspect, q)).toEqual({})
            }
        })

        describe.each(VERSIONS)("factory lookup (v%s)", (version) => {
            const sender = address(0x1)
            const deployment = (n: number, nonce: bigint) =>
                makeUserOpInfo({
                    version,
                    userOpHash: hash(n),
                    sender,
                    nonce,
                    initCode: DEPLOYMENT_INIT_CODE
                })

            it("clears the entry that points at the popped op", async () => {
                const q = await newQueue({ version })
                await q.store.add(deployment(1, 0n))
                expect(await inspect.hget(q.keys.factories, sender)).toBe(
                    hash(1)
                )

                expect((await q.store.pop())?.userOpHash).toBe(hash(1))
                expect(await inspect.hexists(q.keys.factories, sender)).toBe(0)
            })

            it("tolerates an absent entry", async () => {
                const q = await newQueue({ version })
                await q.store.add(deployment(1, 0n))
                await inspect.hdel(q.keys.factories, sender)

                expect((await q.store.pop())?.userOpHash).toBe(hash(1))
                expect(await inspect.exists(q.keys.factories)).toBe(0)
            })

            it("keeps an entry that points at a later deployment", async () => {
                const q = await newQueue({ version })
                await q.store.add(deployment(1, 0n))
                await q.store.add(deployment(2, 1n))
                expect(await inspect.hget(q.keys.factories, sender)).toBe(
                    hash(2)
                )

                expect((await q.store.pop())?.userOpHash).toBe(hash(1))
                expect(await inspect.hget(q.keys.factories, sender)).toBe(
                    hash(2)
                )

                expect((await q.store.pop())?.userOpHash).toBe(hash(2))
                expect(await inspect.hexists(q.keys.factories, sender)).toBe(0)
            })
        })

        it("sends one request for a successful pop once warm", async () => {
            const q = await newQueue()
            expect(await q.store.pop()).toBeUndefined()
            await q.store.add(
                makeUserOpInfo({ userOpHash: hash(1), sender: address(0x1) })
            )
            const sendCommand = vi.spyOn(q.redis, "sendCommand")

            expect((await q.store.pop())?.userOpHash).toBe(hash(1))

            expect(sendCommand).toHaveBeenCalledTimes(1)
        })

        it("sends one request for an empty pop once warm", async () => {
            const q = await newQueue()
            expect(await q.store.pop()).toBeUndefined()
            const sendCommand = vi.spyOn(q.redis, "sendCommand")

            expect(await q.store.pop()).toBeUndefined()

            expect(sendCommand).toHaveBeenCalledTimes(1)
        })

        it("recovers from a flushed script cache with two requests", async () => {
            const q = await newQueue()
            expect(await q.store.pop()).toBeUndefined()
            await q.store.add(
                makeUserOpInfo({ userOpHash: hash(1), sender: address(0x1) })
            )
            await inspect.script("FLUSH")
            const sendCommand = vi.spyOn(q.redis, "sendCommand")

            expect((await q.store.pop())?.userOpHash).toBe(hash(1))

            expect(sendCommand).toHaveBeenCalledTimes(2)
            expect(await q.store.pop()).toBeUndefined()
        })

        it("gives each op to exactly one of two concurrent consumers", async () => {
            const first = await newQueue()
            const second = await newQueue({
                redisKeyPrefix: first.redisKeyPrefix
            })
            const sender = address(0x1)
            const seeded: HexData32[] = []
            for (let i = 0; i < 40; i++) {
                seeded.push(hash(i + 1))
                await first.store.add(
                    makeUserOpInfo({
                        userOpHash: hash(i + 1),
                        sender,
                        nonce: BigInt(i)
                    })
                )
            }
            const drain = async (q: Queue): Promise<HexData32[]> => {
                const out: HexData32[] = []
                while (true) {
                    const op = await q.store.pop()
                    if (!op) {
                        return out
                    }
                    out.push(op.userOpHash)
                }
            }

            const consumed = (
                await Promise.all([drain(first), drain(second)])
            ).flat()

            expect(consumed.length).toBe(40)
            expect([...consumed].sort()).toEqual([...seeded].sort())
            expect(await snapshot(inspect, first)).toEqual({})
        })

        it("rejects invalid JSON after dropping only its ready entry", async () => {
            const q = await newQueue()
            const op = makeUserOpInfo({
                userOpHash: hash(1),
                sender: address(0x1)
            })
            await q.store.add(op)
            const slot = q.slotKey(op.userOp.sender, 0n)
            const [raw] = await inspect.zrange(slot, 0, -1)
            await inspect.zrem(slot, raw)
            await inspect.zadd(slot, 0, "{not json")

            await expect(q.store.pop()).rejects.toThrow()

            expect(await inspect.zscore(q.keys.ready, slot)).toBeNull()
            expect(await inspect.zrange(slot, 0, -1)).toEqual(["{not json"])
            expect(await inspect.hget(q.keys.hashes, hash(1))).toBe(slot)
        })

        it("rejects a schema-invalid member after removing it", async () => {
            const q = await newQueue()
            const op = makeUserOpInfo({
                userOpHash: hash(1),
                sender: address(0x1)
            })
            await q.store.add(op)
            const slot = q.slotKey(op.userOp.sender, 0n)
            const [raw] = await inspect.zrange(slot, 0, -1)
            await inspect.zrem(slot, raw)
            await inspect.zadd(
                slot,
                0,
                JSON.stringify({ ...JSON.parse(raw), addedToMempool: "bad" })
            )

            await expect(q.store.pop()).rejects.toThrow()

            expect(await inspect.zrange(slot, 0, -1)).toEqual([])
            expect(await inspect.hexists(q.keys.hashes, hash(1))).toBe(0)
        })

        it("rejects an invalid successor after removing the head", async () => {
            const q = await newQueue()
            const op = makeUserOpInfo({
                userOpHash: hash(1),
                sender: address(0x1)
            })
            await q.store.add(op)
            const slot = q.slotKey(op.userOp.sender, 0n)
            await inspect.zadd(slot, 1, "{not json")

            await expect(q.store.pop()).rejects.toThrow()

            expect(await inspect.zrange(slot, 0, -1)).toEqual(["{not json"])
            expect(await inspect.hexists(q.keys.hashes, hash(1))).toBe(0)
            expect(await inspect.zscore(q.keys.ready, slot)).toBeNull()
        })

        it("matches the baseline pop on 40 seeded sequences", async () => {
            let steps = 0
            let pops = 0
            for (let seed = 1; seed <= 40; seed++) {
                let rng = seed
                const rand = () => {
                    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
                    return rng
                }
                const reference = await newQueue()
                const candidate = await newQueue()
                const compareState = async (step: string) => {
                    expect(
                        await snapshot(inspect, candidate),
                        `seed ${seed} ${step}`
                    ).toEqual(await snapshot(inspect, reference))
                }
                const sequence = new Array<number>(12).fill(0)
                for (let j = 0; j < 60; j++) {
                    if (rand() % 3 !== 0) {
                        const slot = rand() % 12
                        const op = makeUserOpInfo({
                            userOpHash: hash(seed * 100 + j + 1),
                            sender: address(Math.floor(slot / 2) + 1),
                            nonce:
                                (BigInt(slot % 2) << 64n) +
                                BigInt(sequence[slot]++),
                            maxFeePerGas: BigInt(rand()) << 40n
                        })
                        await reference.store.add(op)
                        await candidate.store.add(op)
                    } else {
                        const expected = await referencePop(
                            inspect,
                            reference.keys
                        )
                        expect(
                            await candidate.store.pop(),
                            `seed ${seed} action ${j}`
                        ).toEqual(expected)
                        pops++
                    }
                    await compareState(`action ${j}`)
                    steps++
                }
                while (true) {
                    const expected = await referencePop(inspect, reference.keys)
                    expect(
                        await candidate.store.pop(),
                        `seed ${seed} drain`
                    ).toEqual(expected)
                    await compareState("drain")
                    steps++
                    pops++
                    if (!expected) {
                        break
                    }
                }
            }

            expect({ steps, pops }).toEqual({ steps: 3296, pops: 1689 })
        }, 180_000)
    }
)
