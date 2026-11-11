import Redis, { type Result } from "ioredis"
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

// Atomic sender-nonce conflict check.
// KEYS[1] sender-nonce lookup (hash: sender-nonce -> userOp)
// KEYS[2] added-at            (hash: sender-nonce -> ms timestamp)
// KEYS[3] hash index          (hash: userOpHash -> userOp)
// ARGV: sender-nonce, now (ms), max age (ms)
// Returns nil when there is no entry, {'live', userOp} for a conflict, or
// {'evicted', ageMs} after deleting an orphan. An entry written before the
// added-at key existed has no timestamp, so its clock starts here. Eviction
// also drops the hash-index entries holding the same userOp, so the owner's
// late remove(hash) cannot delete a newer op's sender-nonce entry. The scan
// only runs on eviction, and processing/submitted hold one bundle round each.
const FIND_CONFLICTING_SENDER_NONCE_SCRIPT = `
local userOp = redis.call('HGET', KEYS[1], ARGV[1])
if not userOp then return nil end
redis.call('HSETNX', KEYS[2], ARGV[1], ARGV[2])
local ageMs = tonumber(ARGV[2]) - tonumber(redis.call('HGET', KEYS[2], ARGV[1]))
if ageMs <= tonumber(ARGV[3]) then return {'live', userOp} end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
local entries = redis.call('HGETALL', KEYS[3])
for i = 1, #entries, 2 do
    if entries[i + 1] == userOp then
        redis.call('HDEL', KEYS[3], entries[i])
    end
end
return {'evicted', tostring(ageMs)}
`

declare module "ioredis" {
    interface RedisCommander<Context> {
        findConflictingSenderNonce(
            senderNonceLookupKey: string,
            senderNonceAddedAtKey: string,
            userOpHashLookupKey: string,
            senderNonce: string,
            nowMs: string,
            maxAgeMs: string
        ): Result<["live" | "evicted", string] | null, Context>
    }
}

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
    redis.defineCommand("findConflictingSenderNonce", {
        numberOfKeys: 3,
        lua: FIND_CONFLICTING_SENDER_NONCE_SCRIPT
    })
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
            const conflict = await redis.findConflictingSenderNonce(
                senderNonceLookupKey,
                senderNonceAddedAtKey,
                userOpHashLookupKey,
                senderNonce,
                String(Date.now()),
                String(STALE_SENDER_NONCE_MS)
            )

            if (conflict?.[0] === "live") {
                return {
                    reason: "conflicting_nonce",
                    userOp: deserializeUserOp(conflict[1])
                }
            }

            if (conflict?.[0] === "evicted") {
                logger.warn(
                    {
                        event: "staleSenderNonceEvicted",
                        store: storeType,
                        sender: userOp.sender,
                        nonce: toHex(userOp.nonce),
                        ageMs: Number(conflict[1])
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
