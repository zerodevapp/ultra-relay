import Redis from "ioredis"
import { type Address, toHex } from "viem"
import type { Store } from "."
import { getRedisStorePrefix } from "../cli/config/redisKeys"
import type { AltoConfig } from "../createConfig"
import {
    type HexData32,
    type UserOpInfo,
    type UserOperation,
    userOperationSchema
} from "../types/schemas"
import { isVersion06, isVersion07 } from "../utils/userop"
import { RedisHash } from "./createRedisOutstandingStore"
import { createMemoryStore } from "./createStore"

const isDeploymentOperation = (userOp: UserOperation): boolean => {
    const isV6Deployment =
        isVersion06(userOp) && !!userOp.initCode && userOp.initCode !== "0x"
    const isV7Deployment =
        isVersion07(userOp) && !!userOp.factory && userOp.factory !== "0x"
    return isV6Deployment || isV7Deployment
}

const serializeUserOp = (userOpInfo: UserOperation): string => {
    return JSON.stringify(userOpInfo, (_, value) =>
        typeof value === "bigint" ? toHex(value) : value
    )
}

const deserializeUserOp = (data: string): UserOperation => {
    try {
        const parsed = JSON.parse(data)
        const result = userOperationSchema.safeParse(parsed)

        if (!result.success) {
            throw new Error(
                `Failed to parse UserOpInfo: ${result.error.message}`
            )
        }
        return result.data
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(
                `UserOpInfo deserialization failed: ${error.message}`
            )
        }
        throw new Error("UserOpInfo deserialization failed with unknown error")
    }
}

// A sender-nonce entry is removed by the instance that owns the userOp. When
// that instance dies (a deploy kills it mid-bundle) or loses track of the op,
// nothing removes the entry and every later userOp at that sender-nonce is
// rejected with AA25 forever. Entries older than this are treated as orphans.
// Live entries clear within minutes: the slowest observed path is a bundle
// waiting ~7.5 minutes for a free executor wallet.
export const STALE_SENDER_NONCE_MS = 30 * 60 * 1000

// Deletes a sender-nonce entry, its timestamp and every hash-index entry that
// holds the same userOp, but only if the timestamp is still the one the caller
// judged stale. A fresh add in between changes the timestamp and wins.
export const EVICT_STALE_SENDER_NONCE_SCRIPT = `
local userOp = redis.call('HGET', KEYS[1], ARGV[1])
if not userOp then return 0 end
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
local entries = redis.call('HGETALL', KEYS[3])
for i = 1, #entries, 2 do
    if entries[i + 1] == userOp then
        redis.call('HDEL', KEYS[3], entries[i])
    end
end
return 1
`

export const createRedisStore = ({
    config,
    storeType,
    entryPoint,
    redisEndpoint
}: {
    config: AltoConfig
    storeType: string
    entryPoint: Address
    redisEndpoint: string
}): Store => {
    const redis = new Redis(redisEndpoint, {})
    const logger = config.getLogger(
        { module: "mempool-store" },
        { level: config.logLevel }
    )

    const storePrefix = getRedisStorePrefix(config)
    const factoryLookupKey = `${storePrefix}:${storeType}:factory-lookup:${entryPoint}`
    const userOpHashLookupKey = `${storePrefix}:${storeType}:user-op-hash-index:${entryPoint}`
    const senderNonceLookupKey = `${storePrefix}:${storeType}:sender-nonce-lookup:${entryPoint}`
    const senderNonceAddedAtKey = `${storePrefix}:${storeType}:sender-nonce-added-at:${entryPoint}`

    const factoryLookup = new RedisHash(redis, factoryLookupKey) // sender -> userOpHash (if deployment is present)
    const senderNonceLookup = new RedisHash(redis, senderNonceLookupKey) // sender + nonce -> userOp
    const senderNonceAddedAt = new RedisHash(redis, senderNonceAddedAtKey) // sender + nonce -> ms timestamp
    const userOpHashLookup = new RedisHash(redis, userOpHashLookupKey) // userOpHash -> userOp

    // Entries written before this key existed have no timestamp. Start their
    // clock at the first conflict so they are evicted one timeout later.
    const isStale = async (senderNonce: string): Promise<string | null> => {
        const now = Date.now()
        await redis.hsetnx(senderNonceAddedAtKey, senderNonce, String(now))
        const addedAt = await senderNonceAddedAt.get(senderNonce)
        if (addedAt === null) {
            return null
        }
        return now - Number(addedAt) > STALE_SENDER_NONCE_MS ? addedAt : null
    }

    const evictStale = async (
        senderNonce: string,
        addedAt: string
    ): Promise<boolean> => {
        const evicted = await redis.eval(
            EVICT_STALE_SENDER_NONCE_SCRIPT,
            3,
            senderNonceLookupKey,
            senderNonceAddedAtKey,
            userOpHashLookupKey,
            senderNonce,
            addedAt
        )
        return evicted === 1
    }

    const memoryStore = createMemoryStore({ config })

    const encodeSenderNonce = (userOp: UserOperation) => {
        return `${userOp.sender}-${userOp.nonce}`
    }

    return {
        add: async (op: UserOpInfo) => {
            // Local memory logic
            memoryStore.add(op)

            // Global redis logic
            const { userOpHash, userOp } = op

            const multi = redis.multi()

            await userOpHashLookup.set({
                key: userOpHash,
                value: serializeUserOp(userOp),
                multi
            })
            await senderNonceLookup.set({
                key: encodeSenderNonce(userOp),
                value: serializeUserOp(userOp),
                multi
            })
            await senderNonceAddedAt.set({
                key: encodeSenderNonce(userOp),
                value: String(Date.now()),
                multi
            })

            if (isDeploymentOperation(userOp)) {
                await factoryLookup.set({
                    key: op.userOp.sender,
                    value: op.userOpHash,
                    multi
                })
            }

            await multi.exec()
        },
        remove: async (userOpHash: HexData32) => {
            // Local memory logic
            memoryStore.remove(userOpHash)

            // Redis Logic
            const exist = await userOpHashLookup.get(userOpHash)

            if (!exist) {
                return false
            }

            const userOp = deserializeUserOp(exist)

            const multi = redis.multi()
            await userOpHashLookup.delete({ key: userOpHash, multi })
            await senderNonceLookup.delete({
                key: encodeSenderNonce(userOp),
                multi
            })
            await senderNonceAddedAt.delete({
                key: encodeSenderNonce(userOp),
                multi
            })
            if (isDeploymentOperation(userOp)) {
                await factoryLookup.delete({ key: userOp.sender, multi })
            }
            await multi.exec()

            return true
        },
        contains: async (userOpHash: HexData32) => {
            return await userOpHashLookup.exists(userOpHash)
        },
        dumpLocal: () => {
            return memoryStore.dumpLocal()
        },
        findConflicting: async (userOp: UserOperation) => {
            const senderNonce = encodeSenderNonce(userOp)
            const conflictingNonce = await senderNonceLookup.get(senderNonce)

            if (conflictingNonce) {
                const staleAddedAt = await isStale(senderNonce)
                const evicted =
                    staleAddedAt !== null &&
                    (await evictStale(senderNonce, staleAddedAt))

                if (!evicted) {
                    return {
                        reason: "conflicting_nonce",
                        userOp: deserializeUserOp(conflictingNonce)
                    }
                }

                logger.warn(
                    {
                        event: "staleSenderNonceEvicted",
                        store: storeType,
                        sender: userOp.sender,
                        nonce: toHex(userOp.nonce),
                        ageMs: Date.now() - Number(staleAddedAt)
                    },
                    `evicted stale ${storeType} entry for ${senderNonce}`
                )
            }

            if (isDeploymentOperation(userOp)) {
                const userOpHash = await factoryLookup.get(userOp.sender)
                if (userOpHash) {
                    const userOp = await userOpHashLookup.get(userOpHash)

                    if (!userOp) {
                        return undefined
                    }
                    return {
                        reason: "conflicting_deployment",
                        userOp: deserializeUserOp(userOp)
                    }
                }
            }

            return undefined
        }
    }
}
