// Integration tests for the Redis sender manager against a real Redis.
// Skipped unless REDIS_URL is set, e.g.:
//   docker run --rm -d -p 6379:6379 redis:7-alpine
//   REDIS_URL=redis://localhost:6379 pnpm --filter @pimlico/alto test
import Redis from "ioredis"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { getRedisKeys } from "../../cli/config/redisKeys"
import type { AltoConfig } from "../../createConfig"
import {
    RELEASE_WALLET_LUA,
    RESTORE_WALLET_LUA,
    createRedisSenderManager
} from "./createRedisSenderManager"

const redisUrl = process.env.REDIS_URL

const STALE_MS = 30 * 60 * 1000

describe.skipIf(!redisUrl)("createRedisSenderManager", () => {
    const walletA = privateKeyToAccount(generatePrivateKey())
    const walletB = privateKeyToAccount(generatePrivateKey())
    const stranger = privateKeyToAccount(generatePrivateKey())

    const noopLogger = {
        trace: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
    }
    const metrics = {
        walletsTotal: { set: () => {} },
        walletsAvailable: { set: () => {} }
    } as unknown as Parameters<typeof createRedisSenderManager>[0]["metrics"]
    const config = {
        executorPrivateKeys: [walletA, walletB],
        maxExecutors: undefined,
        redisKeyPrefix: `sender-manager-test-${process.pid}`,
        chainId: 999,
        logLevel: "silent",
        executorLogLevel: "silent",
        getLogger: () => noopLogger
    } as unknown as AltoConfig

    const { senderManagerQueue: queueKey, senderManagerCheckedOut: markerKey } =
        getRedisKeys(config)

    const redis = new Redis(redisUrl as string)

    const release = (address: string) =>
        redis.eval(RELEASE_WALLET_LUA, 2, queueKey, markerKey, address)
    const restore = (address: string, staleCutoff: number) =>
        redis.eval(
            RESTORE_WALLET_LUA,
            2,
            queueKey,
            markerKey,
            address,
            staleCutoff
        )

    afterEach(async () => {
        await redis.del(queueKey, markerKey)
    })

    afterAll(() => {
        redis.disconnect()
    })

    it("seeds on first boot and round-trips checkout/release", async () => {
        const manager = await createRedisSenderManager({
            config,
            metrics,
            redisEndpoint: redisUrl as string
        })
        expect(await redis.llen(queueKey)).toBe(2)

        const wallet = await manager.getWallet()
        expect(await redis.llen(queueKey)).toBe(1)
        expect(await redis.zscore(markerKey, wallet.address)).not.toBeNull()

        await manager.markWalletProcessed(wallet)
        expect(await redis.llen(queueKey)).toBe(2)
        expect(await redis.zscore(markerKey, wallet.address)).toBeNull()
    })

    it("boot prunes unconfigured wallets and keeps a non-empty pool unseeded", async () => {
        await redis.rpush(queueKey, walletA.address, stranger.address)
        await redis.zadd(markerKey, Date.now(), walletB.address)

        await createRedisSenderManager({
            config,
            metrics,
            redisEndpoint: redisUrl as string
        })

        expect(await redis.lrange(queueKey, 0, -1)).toEqual([walletA.address])
        expect(await redis.zscore(markerKey, walletB.address)).not.toBeNull()
    })

    it("release without ownership marker is a no-op", async () => {
        await redis.rpush(queueKey, walletA.address)
        expect(await release(walletA.address)).toBe(0)
        expect(await redis.lrange(queueKey, 0, -1)).toEqual([walletA.address])
    })

    it("release does not duplicate an already-queued wallet", async () => {
        await redis.rpush(queueKey, walletA.address)
        await redis.zadd(markerKey, Date.now(), walletA.address)
        expect(await release(walletA.address)).toBe(1)
        expect(await redis.lrange(queueKey, 0, -1)).toEqual([walletA.address])
        expect(await redis.zscore(markerKey, walletA.address)).toBeNull()
    })

    it("restore skips a queued wallet", async () => {
        await redis.rpush(queueKey, walletA.address)
        expect(await restore(walletA.address, Date.now() - STALE_MS)).toBe(0)
        expect(await redis.lrange(queueKey, 0, -1)).toEqual([walletA.address])
    })

    it("restore skips a wallet with a fresh marker", async () => {
        await redis.zadd(markerKey, Date.now(), walletA.address)
        expect(await restore(walletA.address, Date.now() - STALE_MS)).toBe(0)
        expect(await redis.llen(queueKey)).toBe(0)
        expect(await redis.zscore(markerKey, walletA.address)).not.toBeNull()
    })

    it("restore re-queues a wallet with a stale marker", async () => {
        await redis.zadd(
            markerKey,
            Date.now() - STALE_MS - 1000,
            walletA.address
        )
        expect(await restore(walletA.address, Date.now() - STALE_MS)).toBe(1)
        expect(await redis.lrange(queueKey, 0, -1)).toEqual([walletA.address])
        expect(await redis.zscore(markerKey, walletA.address)).toBeNull()
    })

    it("restore re-queues a wallet absent from both structures", async () => {
        expect(await restore(walletA.address, Date.now() - STALE_MS)).toBe(1)
        expect(await redis.lrange(queueKey, 0, -1)).toEqual([walletA.address])
    })
})
