import type { Redis, Result } from "ioredis"

// Lua commands behind createRedisStore. Every command takes the same five
// keys, all per store type and entry point:
// KEYS[1] hash index         (userOpHash -> userOp)
// KEYS[2] added-at           (userOpHash -> ms timestamp)
// KEYS[3] sender-nonce       (sender-nonce -> userOp)
// KEYS[4] sender-nonce owner (sender-nonce -> userOpHash)
// KEYS[5] factory lookup     (sender -> userOpHash)
export type StoreKeys = [string, string, string, string, string]

// An owner counts only while its hash index entry still holds the
// sender-nonce's userOp, or it is the synthetic owner of an entry with no hash
// index match. Any other owner was left by a version that does not write
// owners and is ignored. Secondary entries are deleted only while their valid
// owner is the evicted or removed hash, or, with no valid owner, while they
// hold the same userOp, so a late remove by a dead op's owner cannot drop a
// newer op's entries. An op with no added-at starts its clock when first seen.
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
local function removeEntry(hash, senderNonce, sender)
    local userOp = redis.call('HGET', KEYS[1], hash)
    local senderNonceUserOp = redis.call('HGET', KEYS[3], senderNonce)
    local owner = validOwner(senderNonce, senderNonceUserOp)
    if owner == hash or (not owner and senderNonceUserOp and senderNonceUserOp == userOp) then
        redis.call('HDEL', KEYS[3], senderNonce)
        redis.call('HDEL', KEYS[4], senderNonce)
    end
    if redis.call('HGET', KEYS[5], sender) == hash then
        redis.call('HDEL', KEYS[5], sender)
    end
    redis.call('HDEL', KEYS[1], hash)
    redis.call('HDEL', KEYS[2], hash)
end
local function evictIfStale(hash, senderNonce, sender, now, maxAge)
    redis.call('HSETNX', KEYS[2], hash, now)
    local ageMs = tonumber(now) - tonumber(redis.call('HGET', KEYS[2], hash))
    if ageMs <= tonumber(maxAge) then return nil end
    removeEntry(hash, senderNonce, sender)
    return ageMs
end
`

// ARGV: sender-nonce, sender, now (ms), max age (ms)
// Returns nil, {'live', userOp}, {'evicted', ageMs}, or {'unowned', userOp}
// when the entry has no valid owner yet (see claimSenderNonceOwner).
const SENDER_NONCE_CONFLICT = `${OWNER_FNS}
local userOp = redis.call('HGET', KEYS[3], ARGV[1])
if not userOp then return nil end
local owner = validOwner(ARGV[1], userOp)
if not owner then return {'unowned', userOp} end
local ageMs = evictIfStale(owner, ARGV[1], ARGV[2], ARGV[3], ARGV[4])
if ageMs then return {'evicted', tostring(ageMs)} end
return {'live', userOp}
`

// ARGV: sender-nonce, candidate userOpHash ('' when none was found)
// Gives an unowned sender-nonce entry an owner: the candidate when its hash
// index entry holds the same userOp, else a synthetic owner so its clock can
// still run. Does nothing when the entry already has a valid owner.
const CLAIM_SENDER_NONCE_OWNER = `${OWNER_FNS}
local userOp = redis.call('HGET', KEYS[3], ARGV[1])
if not userOp or validOwner(ARGV[1], userOp) then return 0 end
local owner = syntheticOwner(userOp)
if redis.call('HGET', KEYS[1], ARGV[2]) == userOp then owner = ARGV[2] end
redis.call('HSET', KEYS[4], ARGV[1], owner)
return 1
`

// ARGV: userOpHash, sender-nonce, sender, now (ms), max age (ms)
// Returns nil when the hash is absent, {'live'} or {'evicted', ageMs}.
const EVICT_HASH_IF_STALE = `${OWNER_FNS}
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return nil end
local ageMs = evictIfStale(ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5])
if ageMs then return {'evicted', tostring(ageMs)} end
return {'live'}
`

// ARGV: userOpHash, sender-nonce, sender, added-at stamp of the caller's add
// Returns 1 when the hash was present and removed. With a stamp, nothing is
// removed when another add has since rewritten added-at: the op was evicted and
// an identical copy re-added, and that copy's entries are not the caller's.
const REMOVE_OWNED = `${OWNER_FNS}
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end
local addedAt = redis.call('HGET', KEYS[2], ARGV[1])
if ARGV[4] ~= '' and addedAt and addedAt ~= ARGV[4] then return 0 end
removeEntry(ARGV[1], ARGV[2], ARGV[3])
return 1
`

declare module "ioredis" {
    interface RedisCommander<Context> {
        senderNonceConflict(
            ...args: [
                ...StoreKeys,
                senderNonce: string,
                sender: string,
                nowMs: string,
                maxAgeMs: string
            ]
        ): Result<
            ["live" | "unowned", string] | ["evicted", string] | null,
            Context
        >
        claimSenderNonceOwner(
            ...args: [...StoreKeys, senderNonce: string, candidate: string]
        ): Result<number, Context>
        evictHashIfStale(
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

export const defineStoreCommands = (redis: Redis): void => {
    const commands = {
        senderNonceConflict: SENDER_NONCE_CONFLICT,
        claimSenderNonceOwner: CLAIM_SENDER_NONCE_OWNER,
        evictHashIfStale: EVICT_HASH_IF_STALE,
        removeOwned: REMOVE_OWNED
    }
    for (const [name, lua] of Object.entries(commands)) {
        redis.defineCommand(name, { numberOfKeys: 5, lua })
    }
}
