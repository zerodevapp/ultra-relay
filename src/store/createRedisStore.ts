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

// A processing entry is removed by the instance that owns the userOp. When
// that instance dies (a deploy kills it mid-bundle) or loses track of the op,
// nothing removes the entry and every later userOp at that sender-nonce is
// rejected with AA25, and an identical resend with "Already known", forever.
// Processing entries older than this are treated as orphans. The bound is
// generous because a live op can sit in processing while it waits for a free
// executor wallet, and that wait has no limit (the Nov 2 incident had 30
// minutes of wallet starvation).
export const STALE_SENDER_NONCE_MS = 2 * 60 * 60 * 1000

// A submitted entry holds a pending transaction's nonce lock. It is removed by
// the instance tracking that bundle, and that tracking lives in memory, so a
// pod that shuts down before its bundle lands leaves the entry behind. A stuck
// bundle is rotated to a fresh wallet after max-stuck-attempts-before-rotation
// attempts, and the rotation re-adds the entry and restarts its clock, so a
// live entry should not reach this age.
export const STALE_SUBMITTED_MS = 24 * 60 * 60 * 1000

// Bounds every command on the store's connection, so a connection that stops
// answering fails the write (the mempool store logs it) instead of hanging the
// bundle builder or the executor.
export const REDIS_COMMAND_TIMEOUT_MS = 5000

// Every key is per store type and entry point:
// KEYS[1] hash index        (userOpHash -> userOp)
// KEYS[2] added-at          (userOpHash -> ms timestamp)
// KEYS[3] sender-nonce      (sender-nonce -> userOp)
// KEYS[4] sender-nonce owner (sender-nonce -> userOpHash)
// KEYS[5] factory lookup    (sender -> userOpHash)
// An owner counts only while its hash index entry still holds the
// sender-nonce's userOp, or it is the synthetic owner of an entry with no hash
// index match. Any other owner was left by a version that does not write
// owners and is ignored. Secondary entries are deleted only while their valid
// owner is the evicted or removed hash, or, with no valid owner, while they
// hold the same userOp. So a late remove by a dead op's owner cannot drop a
// newer op's entries. An op written before added-at existed starts its clock
// when first seen.
const OWNER_FNS = `
local function syntheticOwner(userOp)
    return 'orphan:' .. redis.sha1hex(userOp)
end
local function validOwner(senderNonce, userOp)
    if not userOp then return nil end
    local owner = redis.call('HGET', KEYS[4], senderNonce)
    if not owner then return nil end
    if owner == syntheticOwner(userOp) then return owner end
    if redis.call('HGET', KEYS[1], owner) == userOp then return owner end
    return nil
end
local function removeSecondary(hash, userOp, senderNonce, sender)
    local senderNonceUserOp = redis.call('HGET', KEYS[3], senderNonce)
    local owner = validOwner(senderNonce, senderNonceUserOp)
    if owner == hash or (not owner and senderNonceUserOp and senderNonceUserOp == userOp) then
        redis.call('HDEL', KEYS[3], senderNonce)
        redis.call('HDEL', KEYS[4], senderNonce)
    end
    if redis.call('HGET', KEYS[5], sender) == hash then
        redis.call('HDEL', KEYS[5], sender)
    end
end
`

const EVICT_IF_STALE_FN = `${OWNER_FNS}
local function evictIfStale(hash, senderNonce, sender, now, maxAge)
    redis.call('HSETNX', KEYS[2], hash, now)
    local ageMs = tonumber(now) - tonumber(redis.call('HGET', KEYS[2], hash))
    if ageMs <= tonumber(maxAge) then return nil end
    removeSecondary(hash, redis.call('HGET', KEYS[1], hash), senderNonce, sender)
    redis.call('HDEL', KEYS[1], hash)
    redis.call('HDEL', KEYS[2], hash)
    return ageMs
end
`

// ARGV: sender-nonce, sender, now (ms), max age (ms), owner candidate
// Returns nil, {'live', userOp}, {'evicted', ageMs} or {'unowned', userOp}.
// An entry with no valid owner returns 'unowned' while the candidate is empty;
// the caller then finds its hash with HSCAN, outside the script so Redis never
// blocks on a scan, and calls again with that hash or 'none'. An entry with no
// hash index match gets a synthetic owner so its clock can still run.
const SENDER_NONCE_CONFLICT_SCRIPT = `${EVICT_IF_STALE_FN}
local userOp = redis.call('HGET', KEYS[3], ARGV[1])
if not userOp then return nil end
local owner = validOwner(ARGV[1], userOp)
if not owner then
    if ARGV[5] == '' then return {'unowned', userOp} end
    if ARGV[5] ~= 'none' and redis.call('HGET', KEYS[1], ARGV[5]) == userOp then
        owner = ARGV[5]
    else
        owner = syntheticOwner(userOp)
    end
    redis.call('HSET', KEYS[4], ARGV[1], owner)
end
local ageMs = evictIfStale(owner, ARGV[1], ARGV[2], ARGV[3], ARGV[4])
if ageMs then return {'evicted', tostring(ageMs)} end
return {'live', userOp}
`

// ARGV: userOpHash, sender-nonce, sender, now (ms), max age (ms)
// Returns nil when the hash is absent (and drops a factory entry still
// pointing at it), {'live'}, or {'evicted', ageMs}.
const HASH_CONFLICT_SCRIPT = `${EVICT_IF_STALE_FN}
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
    if redis.call('HGET', KEYS[5], ARGV[3]) == ARGV[1] then
        redis.call('HDEL', KEYS[5], ARGV[3])
    end
    return nil
end
local ageMs = evictIfStale(ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5])
if ageMs then return {'evicted', tostring(ageMs)} end
return {'live'}
`

// ARGV: userOpHash, sender-nonce, sender, added-at stamp of the caller's add
// Returns 1 when the hash was present and removed. With a stamp, nothing is
// removed when another add has since rewritten added-at: the op was evicted and
// an identical copy re-added, and that copy's entries are not the caller's.
const REMOVE_OWNED_SCRIPT = `${OWNER_FNS}
local userOp = redis.call('HGET', KEYS[1], ARGV[1])
if not userOp then return 0 end
local addedAt = redis.call('HGET', KEYS[2], ARGV[1])
if ARGV[4] ~= '' and addedAt and addedAt ~= ARGV[4] then return 0 end
removeSecondary(ARGV[1], userOp, ARGV[2], ARGV[3])
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`

type StoreKeys = [string, string, string, string, string]

declare module "ioredis" {
    interface RedisCommander<Context> {
        senderNonceConflict(
            ...args: [
                ...StoreKeys,
                senderNonce: string,
                sender: string,
                nowMs: string,
                maxAgeMs: string,
                ownerCandidate: string
            ]
        ): Result<["live" | "evicted" | "unowned", string] | null, Context>
        hashConflict(
            ...args: [
                ...StoreKeys,
                userOpHash: string,
                senderNonce: string,
                sender: string,
                nowMs: string,
                maxAgeMs: string
            ]
        ): Result<["live"] | ["evicted", string] | null, Context>
        removeOwned(
            ...args: [
                ...StoreKeys,
                userOpHash: string,
                senderNonce: string,
                sender: string,
                addedAtStamp: string
            ]
        ): Result<number, Context>
    }
}

export const createRedisStore = ({
    config,
    storeType,
    entryPoint,
    redisEndpoint,
    staleAfterMs,
    commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS
}: {
    config: AltoConfig
    storeType: string
    entryPoint: Address
    redisEndpoint: string
    // Set to evict entries older than this. Unset, entries never expire.
    staleAfterMs?: number
    commandTimeoutMs?: number
}): Store => {
    const redis = new Redis(redisEndpoint, { commandTimeout: commandTimeoutMs })
    redis.defineCommand("senderNonceConflict", {
        numberOfKeys: 5,
        lua: SENDER_NONCE_CONFLICT_SCRIPT
    })
    redis.defineCommand("hashConflict", {
        numberOfKeys: 5,
        lua: HASH_CONFLICT_SCRIPT
    })
    redis.defineCommand("removeOwned", {
        numberOfKeys: 5,
        lua: REMOVE_OWNED_SCRIPT
    })
    const logger = config.getLogger(
        { module: "mempool-store" },
        { level: config.logLevel }
    )

    const storePrefix = getRedisStorePrefix(config)
    const factoryLookupKey = `${storePrefix}:${storeType}:factory-lookup:${entryPoint}`
    const userOpHashLookupKey = `${storePrefix}:${storeType}:user-op-hash-index:${entryPoint}`
    const senderNonceLookupKey = `${storePrefix}:${storeType}:sender-nonce-lookup:${entryPoint}`
    const senderNonceOwnerKey = `${storePrefix}:${storeType}:sender-nonce-owner:${entryPoint}`
    const addedAtKey = `${storePrefix}:${storeType}:added-at:${entryPoint}`
    const keys: StoreKeys = [
        userOpHashLookupKey,
        addedAtKey,
        senderNonceLookupKey,
        senderNonceOwnerKey,
        factoryLookupKey
    ]

    const factoryLookup = new RedisHash(redis, factoryLookupKey) // sender -> userOpHash (if deployment is present)
    const senderNonceLookup = new RedisHash(redis, senderNonceLookupKey) // sender + nonce -> userOp
    const senderNonceOwner = new RedisHash(redis, senderNonceOwnerKey) // sender + nonce -> userOpHash
    const addedAt = new RedisHash(redis, addedAtKey) // userOpHash -> ms timestamp
    const userOpHashLookup = new RedisHash(redis, userOpHashLookupKey) // userOpHash -> userOp

    const memoryStore = createMemoryStore({ config })

    // userOpHash -> the added-at value this instance wrote, so its remove can
    // tell its own entry from an identical copy re-added after an eviction.
    const addedAtStamps = new Map<string, string>()

    // Finds the hash index entry holding this userOp, for an entry written
    // before owners existed. Runs once per such entry, in HSCAN chunks.
    const findHashOf = async (userOp: string): Promise<string> => {
        let cursor = "0"
        do {
            const [next, entries] = await redis.hscan(
                userOpHashLookupKey,
                cursor,
                "COUNT",
                1000
            )
            for (let i = 0; i < entries.length; i += 2) {
                if (entries[i + 1] === userOp) {
                    return entries[i]
                }
            }
            cursor = next
        } while (cursor !== "0")
        return "none"
    }

    const encodeSenderNonce = (userOp: UserOperation) => {
        return `${userOp.sender}-${userOp.nonce}`
    }

    const logEviction = ({
        userOp,
        ageMs,
        path
    }: {
        userOp: UserOperation
        ageMs: string
        path: "sender_nonce" | "deployment" | "contains"
    }) => {
        logger.warn(
            {
                event: "staleSenderNonceEvicted",
                store: storeType,
                path,
                sender: userOp.sender,
                nonce: toHex(userOp.nonce),
                ageMs: Number(ageMs)
            },
            `evicted stale ${storeType} entry for ${encodeSenderNonce(userOp)}`
        )
    }

    // Returns true when the op at this hash is present and not stale.
    const checkHash = async ({
        userOpHash,
        userOp,
        path
    }: {
        userOpHash: string
        userOp: UserOperation
        path: "deployment" | "contains"
    }): Promise<boolean> => {
        if (staleAfterMs === undefined) {
            return await userOpHashLookup.exists(userOpHash)
        }
        const result = await redis.hashConflict(
            ...keys,
            userOpHash,
            encodeSenderNonce(userOp),
            userOp.sender,
            String(Date.now()),
            String(staleAfterMs)
        )
        if (result?.[0] === "evicted") {
            logEviction({ userOp, ageMs: result[1], path })
        }
        return result?.[0] === "live"
    }

    return {
        add: async (op: UserOpInfo) => {
            // Local memory logic
            memoryStore.add(op)

            // Global redis logic
            const { userOpHash, userOp } = op
            const senderNonce = encodeSenderNonce(userOp)

            const multi = redis.multi()

            await userOpHashLookup.set({
                key: userOpHash,
                value: serializeUserOp(userOp),
                multi
            })
            await senderNonceLookup.set({
                key: senderNonce,
                value: serializeUserOp(userOp),
                multi
            })
            await senderNonceOwner.set({
                key: senderNonce,
                value: userOpHash,
                multi
            })
            const stamp = String(Date.now())
            addedAtStamps.set(userOpHash, stamp)
            await addedAt.set({
                key: userOpHash,
                value: stamp,
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
            const stamp = addedAtStamps.get(userOpHash) ?? ""
            addedAtStamps.delete(userOpHash)

            const removed = await redis.removeOwned(
                ...keys,
                userOpHash,
                encodeSenderNonce(userOp),
                userOp.sender,
                stamp
            )

            return removed === 1
        },
        contains: async (userOpHash: HexData32) => {
            if (staleAfterMs === undefined) {
                return await userOpHashLookup.exists(userOpHash)
            }
            const exist = await userOpHashLookup.get(userOpHash)
            if (!exist) {
                return false
            }
            return await checkHash({
                userOpHash,
                userOp: deserializeUserOp(exist),
                path: "contains"
            })
        },
        dumpLocal: () => {
            return memoryStore.dumpLocal()
        },
        findConflicting: async (userOp: UserOperation) => {
            const senderNonce = encodeSenderNonce(userOp)

            if (staleAfterMs === undefined) {
                const conflicting = await senderNonceLookup.get(senderNonce)
                if (conflicting) {
                    return {
                        reason: "conflicting_nonce",
                        userOp: deserializeUserOp(conflicting)
                    }
                }
            } else {
                const senderNonceConflict = (ownerCandidate: string) =>
                    redis.senderNonceConflict(
                        ...keys,
                        senderNonce,
                        userOp.sender,
                        String(Date.now()),
                        String(staleAfterMs),
                        ownerCandidate
                    )
                let conflict = await senderNonceConflict("")
                if (conflict?.[0] === "unowned") {
                    conflict = await senderNonceConflict(
                        await findHashOf(conflict[1])
                    )
                }

                if (conflict?.[0] === "live") {
                    return {
                        reason: "conflicting_nonce",
                        userOp: deserializeUserOp(conflict[1])
                    }
                }

                if (conflict?.[0] === "evicted") {
                    logEviction({
                        userOp,
                        ageMs: conflict[1],
                        path: "sender_nonce"
                    })
                }
            }

            if (isDeploymentOperation(userOp)) {
                const deploymentHash = await factoryLookup.get(userOp.sender)
                if (deploymentHash) {
                    const deployment =
                        await userOpHashLookup.get(deploymentHash)
                    const deploymentUserOp = deployment
                        ? deserializeUserOp(deployment)
                        : undefined

                    const live = await checkHash({
                        userOpHash: deploymentHash,
                        userOp: deploymentUserOp ?? userOp,
                        path: "deployment"
                    })

                    if (live && deploymentUserOp) {
                        return {
                            reason: "conflicting_deployment",
                            userOp: deploymentUserOp
                        }
                    }
                }
            }

            return undefined
        }
    }
}
