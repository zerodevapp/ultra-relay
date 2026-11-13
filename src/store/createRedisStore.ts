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
import { createMemoryStore } from "./createStore"
import { type StoreKeys, defineStoreCommands } from "./redisStoreScripts"

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

const encodeSenderNonce = (userOp: UserOperation) =>
    `${userOp.sender}-${userOp.nonce}`

// Entries are removed by the instance that owns the userOp. Entries older than
// staleAfterMs are treated as orphans of an instance that died or lost the op,
// and are evicted when a conflict check or contains reaches them.
export const createRedisStore = ({
    config,
    storeType,
    entryPoint,
    redisEndpoint,
    staleAfterMs,
    commandTimeoutMs
}: {
    config: AltoConfig
    storeType: string
    entryPoint: Address
    redisEndpoint: string
    staleAfterMs: number
    commandTimeoutMs: number
}): Store => {
    const redis = new Redis(redisEndpoint, { commandTimeout: commandTimeoutMs })
    defineStoreCommands(redis)
    const logger = config.getLogger(
        { module: "mempool-store" },
        { level: config.logLevel }
    )

    const keyOf = (name: string) =>
        `${getRedisStorePrefix(config)}:${storeType}:${name}:${entryPoint}`
    const hashIndexKey = keyOf("user-op-hash-index")
    const addedAtKey = keyOf("added-at")
    const senderNonceKey = keyOf("sender-nonce-lookup")
    const senderNonceOwnerKey = keyOf("sender-nonce-owner")
    const factoryKey = keyOf("factory-lookup")
    const keys: StoreKeys = [
        hashIndexKey,
        addedAtKey,
        senderNonceKey,
        senderNonceOwnerKey,
        factoryKey
    ]

    const memoryStore = createMemoryStore({ config })

    // userOpHash -> the added-at value this instance wrote, so its remove can
    // tell its own entry from an identical copy re-added after an eviction.
    const addedAtStamps = new Map<string, string>()

    // Finds the hash index entry holding this userOp, for a sender-nonce entry
    // written before owners existed. Runs in HSCAN chunks so Redis never
    // blocks on a full scan.
    const findHashOf = async (userOp: string): Promise<string> => {
        let cursor = "0"
        do {
            const [next, entries] = await redis.hscan(
                hashIndexKey,
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
        return ""
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

    // Returns the userOp stored at this hash while it is present and not
    // stale, evicting it when stale.
    const liveOpAt = async (
        userOpHash: string,
        path: "deployment" | "contains"
    ): Promise<UserOperation | undefined> => {
        const stored = await redis.hget(hashIndexKey, userOpHash)
        if (!stored) {
            return undefined
        }
        const userOp = deserializeUserOp(stored)
        const result = await redis.evictHashIfStale(
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
        return result?.[0] === "live" ? userOp : undefined
    }

    // Returns the userOp holding this sender-nonce while it is not stale,
    // evicting it when stale. An entry with no owner gets one first.
    const senderNonceHolder = async (
        userOp: UserOperation
    ): Promise<UserOperation | undefined> => {
        const senderNonce = encodeSenderNonce(userOp)
        const check = () =>
            redis.senderNonceConflict(
                ...keys,
                senderNonce,
                userOp.sender,
                String(Date.now()),
                String(staleAfterMs)
            )
        let conflict = await check()
        if (conflict?.[0] === "unowned") {
            await redis.claimSenderNonceOwner(
                ...keys,
                senderNonce,
                await findHashOf(conflict[1])
            )
            conflict = await check()
        }
        if (!conflict) {
            return undefined
        }
        if (conflict[0] === "evicted") {
            logEviction({ userOp, ageMs: conflict[1], path: "sender_nonce" })
            return undefined
        }
        // 'unowned' again means another writer replaced the entry between the
        // claim and the check; it is fresh, so it is a conflict.
        return deserializeUserOp(conflict[1])
    }

    return {
        add: async (op: UserOpInfo) => {
            memoryStore.add(op)

            const { userOpHash, userOp } = op
            const serialized = serializeUserOp(userOp)
            const senderNonce = encodeSenderNonce(userOp)
            const stamp = String(Date.now())
            addedAtStamps.set(userOpHash, stamp)

            const multi = redis
                .multi()
                .hset(hashIndexKey, userOpHash, serialized)
                .hset(senderNonceKey, senderNonce, serialized)
                .hset(senderNonceOwnerKey, senderNonce, userOpHash)
                .hset(addedAtKey, userOpHash, stamp)
            if (isDeploymentOperation(userOp)) {
                multi.hset(factoryKey, userOp.sender, userOpHash)
            }
            await multi.exec()
        },
        remove: async (userOpHash: HexData32) => {
            memoryStore.remove(userOpHash)

            const stored = await redis.hget(hashIndexKey, userOpHash)
            if (!stored) {
                return false
            }

            const userOp = deserializeUserOp(stored)
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
        contains: async (userOpHash: HexData32) =>
            (await liveOpAt(userOpHash, "contains")) !== undefined,
        dumpLocal: () => {
            return memoryStore.dumpLocal()
        },
        findConflicting: async (userOp: UserOperation) => {
            const nonceHolder = await senderNonceHolder(userOp)
            if (nonceHolder) {
                return { reason: "conflicting_nonce", userOp: nonceHolder }
            }

            if (isDeploymentOperation(userOp)) {
                const deploymentHash = await redis.hget(
                    factoryKey,
                    userOp.sender
                )
                const deployment =
                    deploymentHash &&
                    (await liveOpAt(deploymentHash, "deployment"))
                if (deployment) {
                    return {
                        reason: "conflicting_deployment",
                        userOp: deployment
                    }
                }
            }

            return undefined
        }
    }
}
