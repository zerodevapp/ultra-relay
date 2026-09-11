import type { Address, HexData32, UserOpInfo } from "@alto/types"
import { Redis } from "ioredis"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getQueueName } from "../cli/shutDown"
import type { AltoConfig } from "../createConfig"
import { createRedisMinMaxQueue } from "../utils/minMaxQueue/createRedisMinMaxQueue"
import { createRedisOutstandingQueue } from "./createRedisOutstandingStore"
import { createRedisStore } from "./createRedisStore"

vi.mock("ioredis", async () => {
    const ioredisMock = await import("ioredis-mock")
    return { Redis: ioredisMock.default, default: ioredisMock.default }
})

const entryPoint = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address
const redisEndpoint = "redis://127.0.0.1:6379/0"
const chainId = 42161
const prefix = "ur-arbitrum-mainnet-ostium"

const noopLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {}
}

const makeConfig = (redisKeyPrefix?: string) =>
    ({
        chainId,
        redisKeyPrefix,
        gasPriceExpiry: 300,
        logLevel: "silent",
        getLogger: () => noopLogger
    }) as unknown as AltoConfig

const makeUserOpInfo = (userOpHash: HexData32): UserOpInfo => ({
    userOp: {
        sender: "0x1111111111111111111111111111111111111111",
        nonce: 0n,
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

const hash = (byte: string) => `0x${byte.repeat(32)}` as HexData32

describe("redis key prefix wiring", () => {
    const redis = new Redis(redisEndpoint)

    beforeEach(async () => {
        await redis.flushall()
    })

    it("outstanding store keeps legacy bare-chainId keys for the default prefix", async () => {
        const store = createRedisOutstandingQueue({
            config: makeConfig("alto"),
            entryPoint,
            redisEndpoint
        })
        await store.add(makeUserOpInfo(hash("11")))

        expect(
            await redis.hexists(
                `${chainId}:outstanding:user-op-hash-index:${entryPoint}`,
                hash("11")
            )
        ).toBe(1)
    })

    it("outstanding store namespaces under an explicit prefix and is isolated from the default", async () => {
        const prefixed = createRedisOutstandingQueue({
            config: makeConfig(prefix),
            entryPoint,
            redisEndpoint
        })
        const legacy = createRedisOutstandingQueue({
            config: makeConfig(),
            entryPoint,
            redisEndpoint
        })
        await prefixed.add(makeUserOpInfo(hash("22")))

        expect(
            await redis.hexists(
                `${prefix}:${chainId}:outstanding:user-op-hash-index:${entryPoint}`,
                hash("22")
            )
        ).toBe(1)
        expect(
            await redis.exists(
                `${chainId}:outstanding:user-op-hash-index:${entryPoint}`
            )
        ).toBe(0)
        expect(await prefixed.contains(hash("22"))).toBe(true)
        expect(await legacy.contains(hash("22"))).toBe(false)
        expect(await legacy.peek()).toBeUndefined()
    })

    it("processing/submitted stores follow the same rule", async () => {
        const legacy = createRedisStore({
            config: makeConfig(),
            entryPoint,
            storeType: "processing",
            redisEndpoint
        })
        const prefixed = createRedisStore({
            config: makeConfig(prefix),
            entryPoint,
            storeType: "submitted",
            redisEndpoint
        })
        await legacy.add(makeUserOpInfo(hash("33")))
        await prefixed.add(makeUserOpInfo(hash("44")))

        expect(
            await redis.hexists(
                `${chainId}:processing:user-op-hash-index:${entryPoint}`,
                hash("33")
            )
        ).toBe(1)
        expect(
            await redis.hexists(
                `${prefix}:${chainId}:submitted:user-op-hash-index:${entryPoint}`,
                hash("44")
            )
        ).toBe(1)
    })

    it("gas-price min/max queues follow the same rule", async () => {
        const legacy = createRedisMinMaxQueue({
            config: makeConfig(),
            keyPrefix: "l1-base-fee-queue",
            redisEndpoint
        })
        const prefixed = createRedisMinMaxQueue({
            config: makeConfig(prefix),
            keyPrefix: "l1-base-fee-queue",
            redisEndpoint
        })
        await legacy.saveValue(7n)
        await prefixed.saveValue(9n)

        expect(
            await redis.exists(`${chainId}:l1-base-fee-queue:minMaxQueue:value`)
        ).toBe(1)
        expect(
            await redis.exists(
                `${prefix}:${chainId}:l1-base-fee-queue:minMaxQueue:value`
            )
        ).toBe(1)
        expect(await legacy.getLatestValue()).toBe(7n)
        expect(await prefixed.getLatestValue()).toBe(9n)
    })
})

describe("restoration queue name", () => {
    const cfg = (redisKeyPrefix?: string) =>
        ({
            redisKeyPrefix,
            publicClient: { chain: { id: chainId } }
        }) as unknown as AltoConfig

    it("keeps the legacy name for default, absent and empty prefixes", () => {
        for (const p of ["alto", undefined, ""]) {
            expect(getQueueName(cfg(p))).toBe(
                `alto:mempool:restoration:${chainId}`
            )
        }
    })

    it("namespaces under an explicit prefix", () => {
        expect(getQueueName(cfg(prefix))).toBe(
            `${prefix}:mempool:restoration:${chainId}`
        )
    })
})
