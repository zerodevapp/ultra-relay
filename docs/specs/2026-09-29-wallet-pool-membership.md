# Add executor wallets to a shared pool without emptying it first

- **Status:** revised design, amended 2026-09-29 to add a 5-minute sync behind an armed marker; not implemented. §10 records historical prototype results, not verification of this revision. Release requires every gate in §6.
- **Date:** 2026-09-29
- **Code read:** local HEAD `ffe09a4`. `src/executor/senderManager/*` and `src/cli/config/redisKeys.ts` are unchanged since `e2c872b`, which is the build Ostium runs (same log shapes on pods `7c76cccfdf-*` and `5c6847577c-*`).
- **Affects:** only instances that run the Redis sender manager (`enable-horizontal-scaling` + `redis-endpoint`; boot line `Created redis sender manager with queueName: …`). Known: Ostium (`srv-d9obrkvlk1mc73897rvg`, queue `ostium:42161:sender-manager`) and Base prod (`srv-cu81pel6l47c739toh50`). The in-memory sender manager is untouched.
- **Supersedes when implemented:** the "A wallet this instance does not own shuts the process down" section of ADR 0004. Resolves startup and periodic membership repair and foreign-wallet handling; automatic recovery of in-use reservations and of Redis data loss remains deferred.

## 0. Summary

Pods share one Redis list of idle executor wallets. Today a pod adds its wallets to that list only when the list is empty, so adding keys to a running instance does nothing: the new keys load, but no bundle ever uses them. This change makes every pod, at startup and then every 5 minutes, add exactly the wallets of its own that are missing from the pool, whatever else is in it.

To know what "missing" means while other pods hold wallets, taking a wallet now also records it in a Redis **in-use set**, and returning it clears the record. A wallet is missing when it is neither waiting in the list nor in the in-use set.

Pods add wallets only while the pool is **armed**: a marker key an operator sets when rebuilding the pool with every pod stopped (§8.3). If Redis loses its data, the marker goes with it, and pods stop adding wallets rather than re-add ones that live pods may still hold. An operator rebuild re-arms the pool.

Decisions (agreed 2026-09-29):

| Question | Decision |
|---|---|
| How pods know which wallets are already in the pool | Track checked-out wallets in an in-use set; take and return are atomic scripts |
| A pod encounters a wallet it has no key for | Preserve an idle foreign entry for its owner; take the next own wallet. No shutdown. Copies already in-use are duplicate cleanup (§2) |
| When pods add missing wallets | At startup and every 5 minutes, only while the pool is armed |
| Redis loses all its data | Stall: add nothing and log an error until an operator rebuild (§8.3) re-arms the pool. Pods never create the marker |
| A pod starts on an unarmed pool | Startup fails without writing anything |

**Address identity is case-insensitive.** Every new list entry written by this implementation uses the configured account's checksummed `wallet.address`. Existing entries are preserved when skipped; a lowercase entry is normalized only when its owner takes and returns it. Checksummed entries alone do not make rollback safe; §7.5 defines the required stop-and-rebuild procedure.

This revision retains the list/set design, and reconciles at startup and every 5 minutes behind the armed marker. It adds mandatory safeguards for stale returns, Redis command replay, and shutdown, and prohibits overlapping legacy/new managers during migration. These are requirements, not claims established by the earlier prototype.

## 1. Problem and evidence

### 1.1 Adding 10 keys on Ostium had no effect (2026-09-29)

Ostium went from 2 pods / 10 keys to 3 pods / 20 keys at 14:09 UTC (ReplicaSet `5c6847577c`).

- All three pods logged `Initialized 20 executor wallets` (14:09:41, 14:09:47, 14:09:51) and bundle with `bundleBudget: 20`.
- Every `submitted bundle transaction` in the 30 hours before, and all **60 bundles from 14:09:33 to 14:43:18**, used the same 10 executor addresses. None of the 10 new wallets sent anything.
- The pool pops from the right and returns to the left. Repeated use of only the original addresses is consistent with the seeding defect below. Bundle counts alone do not prove pool membership: holds, failures and differing pod configurations affect address usage.

### 1.2 Cause: the pool is filled only when empty

`createRedisQueue` (`createRedisSenderManager.ts:18–27`):

```ts
const hasElements = await redis.llen(name)
if (hasElements === 0) {
    const multi = redis.multi()
    multi.del(name)
    multi.rpush(name, ...entries)
    await multi.exec()
}
```

Nothing else ever adds an address. The list held the old 10 when the new pods started, so the new 10 were skipped. The only ways to add wallets today are to empty the list by hand with every pod stopped, or to push addresses by hand with the exact checksummed case (`:102`, a strict `===`).

### 1.3 ADR 0004 already names this gap

ADR 0004, *Known follow-ups*: "Executor-key rotation on a shared wallet queue still only converges by restarting: a new pod does not seed its addresses while old ones remain, and each restart discards one old address. It needs first-class support (seed missing own addresses safely, return or quarantine foreign ones, re-seed at runtime), and a runbook until then."

It also explains today's foreign-wallet rule (`executorManager.ts:659–675`). A pod that pops an address it has no key for drops it, requeues the ops and shuts down, because "the restart re-seeds the queue". With the fill-only-when-empty rule, a restart re-seeds nothing unless the list is empty, so the address stays missing until a later empty-pool seed or manual repair.

### 1.4 Why this is about operations, not speed

In the Sep 28 burst (19:57:00–19:59:30 UTC, 2 pods, 10 wallets), waiting for a wallet took **p50 0.9ms, p95 11.3ms, max 56.3ms** over 53 acquisitions. The intended gain is that adding funded wallets becomes a config rollout. Retirement and uncertain checkouts still require the runbooks in §8; this change does not prevent unsafe manual edits.

## 2. Behaviour after the change

1. **Startup.** Each pod reconciles once, before accepting bundle work. Its eligible wallets are `getAvailableWallets(config)` (after `maxExecutors` slicing), deduplicated by lowercase address. The script adds only eligible addresses absent from both the list and the in-use set. Concurrent startups cannot add the same missing address twice. Zero eligible wallets, or an unarmed pool, is a startup error for this manager; an unarmed startup writes nothing.
2. **Periodic sync.** Every 5 minutes after startup, each pod runs the same reconcile script. It re-adds eligible addresses that went missing from both keys (a deleted or damaged list, a manual edit). It never touches in-use entries, so it cannot reclaim a stranded reservation. On an unarmed pool it adds nothing and logs an error. Each run schedules the next, so runs never overlap; a failed run logs and the next still happens; closing the manager's Redis client ends the loop.
3. **Take.** One script examines at most the list length captured at entry, popping from the right. It drops encountered copies of an in-use address, including foreign copies. Otherwise it takes the first eligible address and records it as in use, or pushes a foreign entry unchanged to the left. A full unsuccessful scan preserves foreign entries and their relative order. Empty result means wait 100ms and retry; a Redis error must reject, not become an empty result. No delay follows a successful take.
4. **Return.** Only the exact checkout handle returned by `getWallet` may be released, once (§2.2). One script removes its lowercase in-use entry and pushes its checksummed address to the left only if that removal succeeded. It returns `[released, poolLength]`, where `released` is 0 or 1. A 0 for a locally active handle is an integrity error, not success. A return that ioredis rejects before writing it (the connection is not ready) never ran: it is kept and sent on the next reconnect, and the release resolves.
5. **Foreign entries do not cause shutdown.** Remove `WalletNotFoundError`, its shutdown branch and its `requestShutdown` hook. Duplicate cleanup still discards extra list entries; it does not remove their in-use reservation.

Invariants:

- **I1.** Within the operating conditions in §2.1, an address has at most one unreleased checkout. Atomic take, checkout-specific return guards and disabled command replay are all necessary. This is not fencing against another service or against pending on-chain transactions.
- **I2.** Startup and the periodic sync add only addresses that are missing, each once, and only while the pool is armed (S2, S3, S4, S14). Redis runs one script at a time. The startup script reads the list and the in-use set and writes in the same step. Take and return move a wallet between those two places in a single step. So a reconcile, at startup or periodic, never sees a held wallet in neither place, and pods that reconcile together each see the others' additions. Today's code has this race (S15): it checks `LLEN` and seeds in separate round trips, so two pods can both see an empty list, and the second seed puts back a wallet the first pod is already using.
- **I3.** A pod never receives a foreign wallet. Foreign entries remain available to their owners, except extra copies already protected by an in-use reservation.
- **I4.** Newly written addresses are checksummed in the list and lowercase in the set. Existing case variants count as the same address. Reconcile does not normalize or deduplicate existing list entries; take removes encountered in-use copies. No claim of immediate list uniqueness is made for a dirty starting list.
- **I5.** Each successful take attempt and return uses one script invocation with no separate metric read. A warm connection with cached scripts takes one round trip. Connection setup and `NOSCRIPT` fallback are excluded; polling needs one invocation per attempt. The periodic sync adds one reconcile invocation per pod every 5 minutes, off the take/return path.

### 2.1 Operating conditions and state meaning

- All processes sharing a pool must use this protocol before any starts reconciling. Pods may have equal, overlapping or disjoint eligible wallet sets. A foreign count is relative to one pod, not proof that a key is retired globally.
- A wallet address on a chain must not be used by another independent pool, in-memory manager, service or manual signer. Different Redis prefixes do not coordinate ownership.
- All three keys live on one authoritative Redis primary, with no TTL or eviction. Only these scripts may mutate them during normal operation. Redis state loss, restoration of an old snapshot, or failover that loses acknowledged writes requires stopping all holders and following §8.3 before resuming. This set is not a distributed fencing mechanism.
- The **armed marker** means an operator rebuilt the pool from approved configurations with every holder stopped (§7.2, §8.3). Only those procedures create it; no pod creates, refreshes or deletes it. Its absence means Redis lost its data, or the pool was never rebuilt for this protocol, so reconcile adds nothing. Its presence does not prove the in-use set is intact: deleting only the in-use set, or setting the marker while holders run, can make a sync re-add a held wallet.
- Restoring an earlier consistent state (a restart from persistence, a snapshot restore) does not make the sync add a held address: in any state these scripts produce, every added address is in the list or the in-use set. The exception is an address first added after that state, which a pod may hold while it is absent from both. Such restores, and the lost holds and returns they cause, still require §8.3.
- `in-use` means **unavailable**, including active, quarantined and stranded reservations. It has no owner, timestamp or expiry. An idle period or set cardinality cannot distinguish a crashed holder from a legitimately long-running one.
- Under a clean starting state, each registered address is in the list or in-use, never both. A crash or lost reply may leave it in-use with no live local handle. Startup must preserve such entries; it must not infer that they are safe to reuse.
- `walletsAvailable` is the raw shared `LLEN` observed at the script's execution, including foreign and duplicate entries; it is not this pod's eligible capacity. `walletsTotal` is this pod's distinct eligible address count. `foreignCount` counts distinct lowercase addresses in the union of list and set that this pod cannot use. Metrics from different pods must not be summed as pool capacity.

### 2.2 Checkout lifetime and failure policy

The address-only set is safe only if a completed return can never be replayed after another checkout. Enforce both local and transport rules:

- Return a fresh `Account` object for each successful checkout (a shallow copy of the configured signing account is sufficient). Track that exact object in `activeWallets`. Callers, submitted bundles and quarantine records must retain it; neither `getAllWallets()` accounts nor reconstructed accounts are release handles. Delete the handle synchronously before awaiting the return script. A repeated or stale call then warns and sends no Redis command, even after the same address has been acquired again. Keep address comparisons for wallet identity; object identity is only the checkout guard.
- On this dedicated Redis client, set `autoResendUnfulfilledCommands: false` and `maxRetriesPerRequest: 0`; do not add application retries or `reconnectOnError` resend behavior for take/return. Disable the offline queue and await initial connection before reconciliation. A known `NOSCRIPT` response permits `EVAL` fallback because the script did not run. Reconnection may serve future commands, but must not replay commands with unknown outcomes.
- A take whose reply is lost may have reserved an address. Reject the acquisition and requeue its user operations through existing recovery; do not release or seed a guessed address. A return whose reply is lost may have completed or may leave a reservation stranded. Log the address and failure, propagate the error, and do not restore its local release handle or retry the return. Recover uncertain reservations through §8.3. A return rejected before it was written (ioredis: "Stream isn't writeable and enableOfflineQueue options is false") is not uncertain: keep it pending, send it when the client is ready again, and resolve the caller's release. This is the same reasoning as the NOSCRIPT fallback.
- Script atomicity prevents interleaving, not rollback after a Lua error. Before the first write, all scripts must validate that the two keys are absent or have their expected types. Reject wrong types without mutation. Unexpected script errors require inspection before reuse; do not compensate by clearing membership.
- Release means the caller has stopped all use of that checkout. Stuck-nonce quarantine continues holding its handle until existing confirmation logic permits release. The Redis shutdown path must not blanket-return `getActiveWallets()`: stopping HTTP does not stop all bundle workers or settle submitted transactions. Unresolved checkouts remain in-use after termination; §4.5 and §8.3 define the safe fallback.

There is no automatic retry of an uncertain release and no claim of automatic crash recovery. Lease tokens/owners would be required to relax these constraints; they are outside this revision.

## 3. Redis layout

| Key | Type | Content | Change |
|---|---|---|---|
| `<redisKeyPrefix>:<chainId>:sender-manager` (e.g. `ostium:42161:sender-manager`) | list | idle wallet addresses; new writes checksummed, legacy case variants tolerated | unchanged key and format |
| `<redisKeyPrefix>:<chainId>:sender-manager:in-use` | set | unavailable addresses (active, quarantined or stranded), **lowercase** | new |
| `<redisKeyPrefix>:<chainId>:sender-manager:armed` | string | set only by an operator's stopped-pool rebuild (§7.2, §8.3); the value records when, who and why | new |

The in-use set stores lowercase so that membership checks are exact. Old code never reads either new key and must not run concurrently. Use `getRedisKeys`, not `getRedisStorePrefix`: this manager retains the existing explicit `<redisKeyPrefix>:<chainId>` namespace, including the `alto` default prefix.

## 4. Code changes

### 4.1 `src/cli/config/redisKeys.ts`

Add two keys next to `senderManagerQueue`:

```ts
        // Sender manager queue
        senderManagerQueue: `${prefix}:sender-manager`,

        // Executor wallets currently taken from the sender manager queue
        senderManagerInUse: `${prefix}:sender-manager:in-use`,

        // Set by an operator's stopped-pool rebuild; pods add wallets only while it exists
        senderManagerArmed: `${prefix}:sender-manager:armed`
```

### 4.2 `src/executor/senderManager/createRedisSenderManager.ts` (replace)

Remove `createRedisQueue` and `WalletNotFoundError`. Keep `delay`, the `Created redis sender manager with queueName:` log line (existing queries match it), and strengthen the `activeWallets` guard with fresh checkout objects. The implementation sketch below must satisfy §2.2 and the shutdown changes in §4.5; the old prototypes do not exercise that complete contract.

```ts
import type { Metrics } from "@alto/utils"
import Redis, { type Result } from "ioredis"
import type { Account } from "viem"
import { getAvailableWallets } from "."
import { getRedisKeys } from "../../cli/config/redisKeys"
import type { AltoConfig } from "../../createConfig"
import type { SenderManager } from "../senderManager"

// Pods share a list of idle wallet addresses and a set of the addresses
// taken and not yet returned. List entries keep the form their pod wrote
// (checksummed); comparisons lowercase them, so a hand-pushed lowercase
// entry still matches. The in-use set holds lowercase addresses.

// KEYS: pool list, in-use set. ARGV: this pod's addresses.
// Returns {entry or nil, pool length}. Scans the pool once: takes the first
// wallet this pod can sign for, drops extra copies of a wallet already in
// use, and pushes other pods' wallets back for their owners.
const TAKE_WALLET_SCRIPT = `
local own = {}
for i = 1, #ARGV do own[string.lower(ARGV[i])] = true end
local n = redis.call("LLEN", KEYS[1])
-- Validate both key types before RPOP can mutate the pool.
redis.call("SCARD", KEYS[2])
for _ = 1, n do
    local entry = redis.call("RPOP", KEYS[1])
    if not entry then break end
    local address = string.lower(entry)
    if redis.call("SISMEMBER", KEYS[2], address) == 1 then
        -- An extra copy of a wallet already in use: drop it.
    elseif own[address] then
        redis.call("SADD", KEYS[2], address)
        return {entry, redis.call("LLEN", KEYS[1])}
    else
        redis.call("LPUSH", KEYS[1], entry)
    end
end
return {false, redis.call("LLEN", KEYS[1])}
`

// KEYS: pool list, in-use set. ARGV[1]: the wallet's address.
// Returns {released (0 or 1), pool length}. This is not safe to replay
// after reacquisition: the local handle and no-replay policy are required.
const RETURN_WALLET_SCRIPT = `
local length = redis.call("LLEN", KEYS[1])
if redis.call("SREM", KEYS[2], string.lower(ARGV[1])) == 0 then
    return {0, length}
end
return {1, redis.call("LPUSH", KEYS[1], ARGV[1])}
`

// KEYS: pool list, in-use set, armed marker. ARGV: this pod's addresses.
// Adds each address that is neither in the pool nor in use, but only while
// the pool is armed: a missing marker means Redis lost its data, and adding
// then could hand out wallets that live pods still hold. Returns
// {armed (0 or 1), added addresses, pool length, in-use count,
// foreign address count}.
const RECONCILE_WALLETS_SCRIPT = `
-- Reads all three keys before any write, so a wrong type rejects first.
local armed = redis.call("GET", KEYS[3]) and 1 or 0
local present = {}
for _, entry in ipairs(redis.call("LRANGE", KEYS[1], 0, -1)) do
    present[string.lower(entry)] = true
end
for _, address in ipairs(redis.call("SMEMBERS", KEYS[2])) do
    present[address] = true
end
local own, added = {}, {}
for i = 1, #ARGV do
    local address = string.lower(ARGV[i])
    own[address] = true
    if armed == 1 and not present[address] then
        redis.call("LPUSH", KEYS[1], ARGV[i])
        present[address] = true
        added[#added + 1] = ARGV[i]
    end
end
local foreign = 0
for address in pairs(present) do
    if not own[address] then foreign = foreign + 1 end
end
return {armed, added, redis.call("LLEN", KEYS[1]), redis.call("SCARD", KEYS[2]), foreign}
`

declare module "ioredis" {
    interface RedisCommander<Context> {
        takeWallet(
            poolKey: string,
            inUseKey: string,
            ...ownAddresses: string[]
        ): Result<[string | null, number], Context>
        returnWallet(
            poolKey: string,
            inUseKey: string,
            address: string
        ): Result<[number, number], Context>
        reconcileWallets(
            poolKey: string,
            inUseKey: string,
            armedKey: string,
            ...ownAddresses: string[]
        ): Result<[number, string[], number, number, number], Context>
    }
}

// How often each pod re-adds its wallets that went missing from both keys.
const WALLET_SYNC_INTERVAL_MS = 5 * 60 * 1000

const delay = async (delay: number) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
}

export const createRedisSenderManager = async ({
    config,
    metrics,
    redisEndpoint
}: {
    config: AltoConfig
    metrics: Metrics
    redisEndpoint: string
}): Promise<SenderManager> => {
    const walletsByAddress = new Map(
        getAvailableWallets(config).map((w) => [w.address.toLowerCase(), w])
    )
    const wallets = [...walletsByAddress.values()]
    if (wallets.length === 0) {
        throw new Error("Redis sender manager requires an eligible wallet")
    }
    metrics.walletsTotal.set(wallets.length)
    const ownAddresses = wallets.map((w) => w.address)
    const logger = config.getLogger(
        { module: "redis-sender-manager" },
        {
            level: config.executorLogLevel || config.logLevel
        }
    )

    const redis = new Redis(redisEndpoint, {
        lazyConnect: true,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 0
    })
    redis.defineCommand("takeWallet", {
        numberOfKeys: 2,
        lua: TAKE_WALLET_SCRIPT
    })
    redis.defineCommand("returnWallet", {
        numberOfKeys: 2,
        lua: RETURN_WALLET_SCRIPT
    })
    redis.defineCommand("reconcileWallets", {
        numberOfKeys: 3,
        lua: RECONCILE_WALLETS_SCRIPT
    })
    const {
        senderManagerQueue: poolKey,
        senderManagerInUse: inUseKey,
        senderManagerArmed: armedKey
    } = getRedisKeys(config)
    const reconcile = () =>
        redis.reconcileWallets(poolKey, inUseKey, armedKey, ...ownAddresses)

    await redis.connect().catch((err: unknown) => {
        redis.disconnect()
        throw err
    })

    // Adds this instance's wallets that no pod has put in the pool yet, so
    // new keys join a pool that other pods are already using.
    const [armed, added, poolSize, inUseCount, foreignCount] =
        await reconcile().catch((err: unknown) => {
            redis.disconnect()
            throw err
        })
    if (armed !== 1) {
        redis.disconnect()
        throw new Error(
            `executor wallet pool ${poolKey} is not armed; rebuild it with every pod stopped (ADR 0006)`
        )
    }
    metrics.walletsAvailable.set(poolSize)
    logger.info(
        {
            added,
            addedCount: added.length,
            poolSize,
            inUseCount,
            foreignCount
        },
        "reconciled executor wallet pool"
    )

    // Re-adds this instance's wallets that went missing from both keys while
    // it runs. Each run schedules the next, so runs never overlap; closing
    // the client ends the loop.
    let syncTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleSync = () => {
        syncTimer = setTimeout(async () => {
            try {
                const [armed, added, poolSize, inUseCount, foreignCount] =
                    await reconcile()
                metrics.walletsAvailable.set(poolSize)
                if (armed !== 1) {
                    logger.error(
                        { poolSize, inUseCount },
                        "executor wallet pool is not armed; added no wallets"
                    )
                } else if (added.length > 0) {
                    logger.warn(
                        {
                            added,
                            addedCount: added.length,
                            poolSize,
                            inUseCount,
                            foreignCount
                        },
                        "re-added missing executor wallets"
                    )
                }
            } catch (err) {
                logger.error({ err }, "executor wallet sync failed")
            }
            if (redis.status !== "end") {
                scheduleSync()
            }
        }, WALLET_SYNC_INTERVAL_MS)
        syncTimer.unref()
    }
    redis.once("end", () => clearTimeout(syncTimer))
    scheduleSync()

    // Track active wallets for this instance
    const activeWallets = new Set<Account>()

    logger.info(`Created redis sender manager with queueName: ${poolKey}`)
    return {
        getAllWallets: () => [...wallets],
        getWallet: async () => {
            logger.trace("waiting for wallet ")

            let address: string | null = null

            while (!address) {
                const [taken, poolLength] = await redis.takeWallet(
                    poolKey,
                    inUseKey,
                    ...ownAddresses
                )
                metrics.walletsAvailable.set(poolLength)
                address = taken
                // Only back off when none of this instance's wallets is
                // free; a successful take sits on the bundling critical path.
                if (!address) {
                    await delay(100)
                }
            }

            const wallet = walletsByAddress.get(address.toLowerCase())
            // The take script only returns this instance's addresses.
            if (!wallet) {
                throw new Error(
                    `wallet pool returned an address this instance does not own: ${address}`
                )
            }

            // Object identity distinguishes this checkout from later ones.
            const checkout = { ...wallet }
            activeWallets.add(checkout)

            logger.trace(
                { executor: wallet.address },
                "got wallet from sender manager"
            )

            return checkout
        },
        markWalletProcessed: async (wallet: Account) => {
            if (activeWallets.delete(wallet)) {
                try {
                    const [released, poolLength] = await redis.returnWallet(
                        poolKey,
                        inUseKey,
                        wallet.address
                    )
                    metrics.walletsAvailable.set(poolLength)
                    if (released !== 1) {
                        throw new Error("Active wallet has no in-use reservation")
                    }
                } catch (err) {
                    logger.error(
                        { err, executor: wallet.address },
                        "wallet return failed; reservation requires inspection"
                    )
                    // Never retry an uncertain return or restore the handle.
                    throw err
                }
            } else {
                logger.warn(
                    { executor: wallet.address },
                    "Attempted to mark a wallet as processed that wasn't active"
                )
            }
        },
        getActiveWallets: () => {
            return [...activeWallets]
        }
    }
}
```

Notes for the implementer:

- `getWallet` loses its fire-and-forget `LLEN` (`:119–124`). The take reply carries the length.
- `markWalletProcessed` goes from `LPUSH` then `LLEN` (two sequential commands) to one.
- Deduplicate eligible accounts after `maxExecutors` slicing. Both metrics and `getAllWallets()` use this distinct local list. The script also deduplicates repeated arguments defensively.
- The periodic sync logs at `warn` only when it adds something. Under this protocol nothing goes missing from both keys in normal operation, so an addition means something removed a pool entry. Quiet runs log nothing.
- An unarmed pool fails startup but only logs during the periodic sync: running pods keep using whatever the list still holds.
- `WALLET_SYNC_INTERVAL_MS` is a constant, not a CLI flag. The sync timer is `unref`'d so it never keeps the process alive.
- Lua `false` inside the reply table becomes a nil array element, which ioredis returns as `null` (S5 checks this).
- Do not silently repair malformed addresses or uppercase set members. Those violate the layout contract and require a stopped-pool repair. Case-insensitive lookup tolerates valid legacy list addresses; it does not authorize arbitrary Redis writes.

### 4.3 `src/executor/senderManager/index.ts`

Remove the `WalletNotFoundError` import and `export { WalletNotFoundError }` (lines 5–10).

### 4.4 `src/executor/executorManager.ts`

The foreign-wallet shutdown can no longer trigger, so remove it and everything that exists only for it:

- the import of `WalletNotFoundError` (line 24): keep `type SenderManager`;
- the `requestShutdown` / `shutdownRequested` fields and their comment (lines 117–120);
- the `requestShutdown` constructor parameter, its type and its assignment (lines 130, 139, 155);
- in `recoverFailedSend`, the comment and `if (!acquiredWallet && err instanceof WalletNotFoundError) { … }` block (lines 659–675).

`recoverFailedSend` keeps everything else. A failed acquisition still requeues under `wallet_acquisition_failed`, and a failed send still frees the wallet and requeues.

### 4.5 `src/cli/setupServer.ts`

- Remove the `requestShutdown` parameter, its type and its forwarding from the executor-manager factory (lines 117, 126, 136).
- Remove the `requestShutdown: (reason) => { gracefulShutdown(reason)… }` argument and its comment (lines 297–304).

`gracefulShutdown` stays for SIGINT/SIGTERM and existing error paths. In the Redis-manager branch, remove its blanket loop returning active wallets. The current shutdown closes HTTP, but does not establish that bundle tasks, pending acquisitions, submitted transactions and quarantine are drained. Returning those handles can let another pod use an address while its old work still runs.

For this change, leave unresolved Redis checkouts in-use and log their addresses/count at shutdown; normal completion may still return a handle before exit. Preserve existing in-memory cleanup. If a complete drain is later added, it must stop new acquisitions, settle/cancel pending waits and sends, and resolve transaction/quarantine obligations before releasing any remaining handle. A process exit alone does not settle an on-chain transaction. This conservative shutdown behavior trades availability for safety and can require §8.3 even after SIGTERM.

The periodic sync needs no shutdown step: its timer is `unref`'d and `process.exit` ends it. A sync in flight at exit is harmless whether or not it ran, because it only adds addresses missing from both keys.

### 4.6 ADRs

Create `docs/adr/0006-shared-wallet-pool-membership.md` (text in §5).

In ADR 0004:

- Under the heading "A wallet this instance does not own shuts the process down", add a first line: *Superseded by ADR 0006: pods now leave other pods' wallets in the pool and never shut down for them.*
- Replace the first known follow-up with: *Startup and periodic membership repair and foreign-wallet handling: resolved by ADR 0006. Automatic recovery of in-use reservations and of Redis data loss remains deferred; retirement, uncertain checkouts and data loss require its runbooks.*
- Amend the double-release follow-up: fresh Redis checkout handles prevent an old callback from releasing a newer checkout; the existing gas/nonce caller bug and the in-memory path remain follow-up work.

## 5. ADR 0006 text

```markdown
# Shared wallet pool membership

Redis sender managers share an idle-address list and a lowercase in-use set.
Previously, only an empty list was seeded; added keys could remain unused,
and foreign addresses were discarded before requesting a restart (ADR 0004).

## Startup and a 5-minute sync add eligible missing addresses

At startup, before bundle work, and then every 5 minutes, reconcile the
distinct addresses from getAvailableWallets(config), after maxExecutors
slicing. Add only addresses absent from both list and set. All participants
must use the new protocol; concurrent scripts serialize membership changes.
The sync never reclaims in-use entries or hot-reloads keys. Automatic removal
of retired keys is not included.

## Adding requires an armed pool

An operator's stopped-pool rebuild sets an armed marker key; pods never
create it. Reconcile adds nothing without it. A missing marker means Redis
lost its data, and adding then could hand out wallets live pods still hold.
Startup on an unarmed pool fails; the periodic sync logs an error and waits.
This also stops new-protocol pods from starting on a legacy pool.

## Taking and returning preserve reservations

Take scans at most the initial list length. It reserves the first own idle
address atomically, drops encountered copies already in-use, and rotates
other entries unchanged to the left. No eligible address means a 100ms wait;
Redis errors reject through acquisition recovery. Foreign wallets cause no
shutdown. Foreign counts are pod-relative, not proof of global retirement.

Every checkout has a fresh Account object. Only that exact handle may be
returned, once. Return consumes the local handle before its script removes
the in-use member and writes the checksummed address. A missing reservation
is an integrity error. Redis must not replay take/return after a lost reply:
autoResendUnfulfilledCommands=false, maxRetriesPerRequest=0, no offline queue,
and no application retries. NOSCRIPT fallback is allowed because no script
executed. A return rejected before it was written is likewise kept and sent
after reconnect. This combination prevents stale callbacks or replayed
returns from releasing a later checkout; the set alone cannot do so.

## Address format and observability

Address identity is lowercase. New list writes use the configured checksummed
address; skipped legacy entries retain their bytes. Existing duplicates are
not eagerly normalized. The shared available gauge is raw list length,
including foreign and duplicate entries, not local signing capacity.

## Operational limits

In-use includes active, quarantined and stranded reservations. A crash or
uncertain reply can strand one; age or quiet traffic cannot prove it is safe
to clear. Shutdown does not blanket-return unresolved Redis checkouts.
Recovery requires stopping all pool participants and resolving outstanding
transaction/nonces before rebuilding and re-arming the pool from approved keys.

First migration and rollback require that same stopped-pool boundary.
Low traffic and checksummed strings do not make mixed old/new code safe.
Redis state loss requires recovery too; this is not a fencing or lease system.
One address must not be used by independent pools or external signers.
See the wallet-pool membership spec §§7–8 for the operational procedures.
```

## 6. Tests

### 6.1 New `src/executor/senderManager/createRedisSenderManager.script.test.ts`

Follow `src/store/createRedisOutstandingStore.script.test.ts`: real Redis, `describe.skipIf(!process.env.REDIS_URL)`. CI already runs `redis:7.2-alpine` with `REDIS_URL` for `test:unit` (`.github/workflows/lint.yaml`).

- Give every test its own `redisKeyPrefix` (`randomUUID()`), so tests never share keys.
- Arm the pool (`SET` the marker) in setup unless the test covers an unarmed pool. Real-Redis tests drive the periodic sync through test instrumentation or direct script calls; the timer itself is covered in §6.2.
- Simulate pods as separate `createRedisSenderManager` calls with different `executorPrivateKeys`. Use real `privateKeyToAccount` accounts, so addresses are genuinely checksummed.
- `REDIS_URL` must refer to a disposable test server: `SCRIPT FLUSH` affects the whole server, not just a test prefix. Close every test-owned client, settle pending `getWallet` calls by returning a wallet, then delete only that test's keys. Tests must leave no poll timers or sockets behind. Give the manager tests access to their created clients through test instrumentation, without adding a public production API solely for cleanup.

| # | Scenario | Assert |
|---|---|---|
| T1 | Empty pool, one pod with 20 keys | reconcile log `addedCount: 20`; list = 20 checksummed addresses; in-use empty |
| T2 | List pre-filled with 10 of the pod's 20 addresses (plain `RPUSH`, as today's code leaves it) | `addedCount: 10`, exactly the missing 10; list has 20 entries, 20 distinct |
| T3 | 5 pods with the same 20 keys created concurrently on an empty pool | list has 20 entries, all distinct |
| T4 | Pod A takes 3 wallets, then pod B starts, then both run a periodic sync | B and both syncs add 0; `inUseCount: 3`; after A returns them, list = 20 and in-use empty |
| T5 | List interleaves pod A's 10 and pod B's 10; A calls `getWallet` 10 times | A gets only its own 10; B's 10 stay in the list; an 11th `getWallet` stays pending and polls every 100ms without taking B's wallets |
| T6 | A takes W; inject another W on the right; A takes again | W's encountered copy is dropped; another eligible wallet is returned, or the script returns empty and the manager polls; W is not handed out while held. This is corruption tolerance, not support for mixed versions |
| T7 | Replace an eligible idle entry with its lowercase form (do not add another copy) | `getWallet` returns a fresh handle for that account; after return, its sole list entry is checksummed |
| T8 | Count commands after connection setup, reconciliation and script-cache warmup | One successful take = 1 command, one return = 1 command, no `LLEN` from JS; metrics use replies. Empty polling counts each attempt separately; no periodic sync fires inside the counting window |
| T9 | `SCRIPT FLUSH`, then `getWallet` | still returns a wallet (ioredis falls back to `EVAL`) |
| T10 | 3 pods × 12 concurrent workers × 34 take/hold(0–5ms)/return cycles on 20 shared wallets | no address held by two workers at once; afterwards list = 20 distinct checksummed entries, in-use empty |
| T11 | Address absent from both keys, with no live holder or unresolved transaction, pool armed | startup or the next periodic sync adds it back; this precondition must be established operationally during migration |
| T12 | Duplicate configured key, including duplicates within `maxExecutors` slice | one list entry, one `getAllWallets()` account, `walletsTotal: 1`; keys beyond the slice never become eligible |
| T13 | Take/return cycles over checksummed legacy and new entries | all newly written entries remain checksummed; this verifies format only, not rollback safety |
| T14 | Stop producers; all checkouts complete normally and return | active handles empty; list contains all eligible addresses once; in-use empty |
| T15 | A takes W, returns it, takes W again, then releases the old handle | Handles differ by identity; stale release sends no Redis command and leaves the new reservation intact; concurrent duplicate returns of one handle send only one command |
| T16 | Return a configured account or reconstructed object; call return script without an in-use member | Manager warns and sends no command; direct script returns `[0, length]` and does not insert an entry |
| T17 | Take/return script executes but its response is lost; another pod may act before reconnect | No command replay; pending call rejects. Lost take may strand W; lost return never releases a newer checkout. Cover failure before execution too. Use the installed ioredis against real Redis through connection fault injection |
| T18 | Wrong type on any pool key (list, set, marker), for each script that reads it | Error before any mutation, including an empty-list take. Startup fails and closes its client; errors during acquisition reject through existing recovery |
| T19 | Two busy pods, with their periodic syncs, while more pods repeatedly reconcile | No added held address, no overlapping checkout; atomic snapshots preserve membership, as in historical S14 |
| T20 | No eligible configured wallet | Startup rejects before polling, including a zero-result `maxExecutors` slice |
| T21 | Partially overlapping and disjoint pod wallet sets; duplicate case variants already in list | No foreign checkout or loss of unique foreign address; no overlapping checkout for common addresses; no assumption that reconcile removes pre-existing duplicates |
| T22 | Startup on an unarmed pool: empty, and non-empty with legacy entries | Startup rejects and closes its client; no key changes; no marker created |
| T23 | Armed pool: `LREM` one of a pod's idle entries, delete another from both keys, hold a third; run the periodic sync | The two missing addresses are re-added once, checksummed, with the `re-added missing executor wallets` warning; the held one is not re-added; a following quiet run adds 0 |
| T24 | Simulated wipe while pod A holds W: `DEL` all three keys; run the periodic sync; A returns W | Sync adds nothing and logs `not armed`; the return reports the integrity error and pushes nothing; list and set stay empty |
| T25 | Return while the client is reconnecting (rejected before sending) | Release resolves with the deferred warning; the wallet stays in-use until reconnect, then returns once; a written return whose reply is lost still rejects and is never resent |

Historical scenarios S1–S15 provide partial evidence only. T15–T18 and the shutdown cases below close gaps not covered by the old prototypes. Assertions about membership use an atomic Redis snapshot and lowercase identity; randomized stress supplements, rather than replaces, deterministic interleavings.

### 6.2 `src/executor/senderManager/createRedisSenderManager.test.ts`

This file keeps only JS behaviour that needs fake timers.

- Replace the list-command `FakeRedis` with one that has a no-op `defineCommand` and three commands backed by a simple array:
  - `reconcileWallets`: return the seeded timing-test fixture as `[1, added, len, 0, 0]`, and let a test make it hang, reject or reply unarmed; real Redis tests own membership correctness;
  - `takeWallet`: pop, return `[addr | null, len]`, count calls;
  - `returnWallet`: push, return `[1, len]`.
- Model the client's explicit `connect`/`disconnect`, its `status` and its `end` event; assert the no-replay options.
- Every manager now leaves one pending sync timer. Existing timer assertions must allow for it.
- Add periodic sync tests: a run fires at 5 minutes and again at 10; a hanging run starts no second one; a rejected run logs `executor wallet sync failed` and the next still fires; an unarmed reply logs its error and adds nothing; startup rejects and disconnects on an unarmed reply; emitting `end` leaves no timer (`vi.getTimerCount()` is 0). These fake tests do not replace T17's transport fault test.
- Keep "resolves without any timer when a wallet is available", counting `takeWallet` calls instead of `rpop`.
- Keep "backs off 100ms between polls while … empty". Rename it to "while none of this instance's wallets is free".
- Delete "still returns the wallet when the metrics llen read fails" (line 134). That read no longer exists.
- Delete "rejects with WalletNotFoundError …" (line 153). The error no longer exists; T5 covers the new rule.

### 6.3 `src/executor/executorManager.test.ts`

- **Delete these tests:**
  - "requeues a popped wallet this instance does not own, then requests shutdown" (2130);
  - "requests shutdown for a wallet it does not own only after the requeue settles" (2162);
  - "still resolves when a step after wallet acquisition throws WalletNotFoundError" (2190);
  - "requests shutdown once however many popped wallets it does not own" (2313).
- **Delete these fixtures:** `FOREIGN_WALLET`, `NOT_OWNED_LINE` (2067–2073; keep `RESOLVED_QUIETLY` above them, other tests use it), and the `WalletNotFoundError` import (line 10).
- **Remove `requestShutdown`** from the constructor fixtures (line 133; lines 1656–1696, including `shutdownRequested: false`).
- **Keep** "requeues a bundle whose wallet wait failed, freeing nothing" (2098). It covers a generic acquisition failure, which is unchanged.
- Remove remaining `requestShutdown` fixture assertions from retained generic tests; do not delete their recovery assertions.
- Add the gas/nonce failure interleaving: return a Redis checkout, reacquire the same address for another bundle, then reject the first bundle's requeue. Its recovery must not release the second checkout. Also verify submitted-bundle completion and quarantine release retain the exact checkout handle.

### 6.4 Shutdown coverage

Exercise the Redis shutdown branch with a waiting acquisition, an in-flight send, a submitted bundle and a quarantined wallet. It must issue no blanket returns and no longer have the foreign-wallet shutdown hook. A normal completed checkout can return once; an unresolved checkout remains unavailable to a second pod after the first exits. Preserve the existing in-memory shutdown behavior. The sync timer must not keep the process alive.

### 6.5 Gates

From the repository root, run `pnpm run lint`, `REDIS_URL=<disposable-test-server> pnpm run test:unit`, and `pnpm exec tsc -p src/tsconfig.json --noEmit`. All must pass; skipped Redis tests do not satisfy the gate. `git grep -n -E 'WalletNotFoundError|requestShutdown|executorWalletNotOwned' -- src ':!src/esm/**'` must produce no matches (exit status 1 is expected). Update prototypes before claiming they verify the revised scripts.

## 7. Rollout

### 7.1 Before deploying

1. **Confirm which instances run the Redis sender manager.** Search the last 7 days for the boot line (source 1169629):
   ```sql
   SELECT JSONExtract(raw, 'hostname', 'Nullable(String)') AS host, max(dt) AS last_boot,
          any(JSONExtract(raw, 'message', 'Nullable(String)')) AS line
   FROM s3Cluster(primary, t187081_ultra_relay_base_prod_s3)
   WHERE _row_type = 1 AND dt >= now() - INTERVAL 7 DAY
     AND raw LIKE '%Created redis sender manager with queueName%'
   GROUP BY host ORDER BY last_boot DESC
   ```
   Run `query_windows` first; add the `remote(...)` leg for the last ~30 minutes.
2. **Fund any new wallets.** The original Ostium investigation found no `refilled wallet`, `no wallets need to be refilled` or `balances missing` line in 30 hours. That absence does not prove the current refill configuration. Verify balances and refill settings directly; an eligible wallet without gas cannot submit successfully.

### 7.2 First migration: no mixed-version execution

Legacy holders do not write the in-use set. A new startup can therefore add
an address still held by a legacy pod; legacy pods can also discard newly
added addresses or take copies without consulting the set. The risk lasts
for the entire overlap, not just the first startup. Low traffic does not
establish safety, and nonce failures are not an acceptable migration result.

Use the stopped-pool recovery procedure in §8.3: block new work for every
participant, stop all old writers, resolve outstanding transaction/nonces,
clear both pool keys and arm the pool in the same transaction (§8.3 step 4),
then start only new-protocol pods. Disable automatic
restarts of the old image during this boundary. Start new pods with work
still blocked; verify the union of their eligible wallets is represented
exactly once before admitting traffic. Ordinary rolling updates are allowed
only once every participant uses this protocol, subject to its shutdown and
stranded-reservation limits.

Until the pool is armed, new-protocol pods refuse to start, so a rolling
update that reaches a legacy pool stalls instead of mixing versions. Never
arm while any legacy pod can run.

The fleet/config facts in §1 and §7.1 are historical observations from
2026-09-29, not a substitute for enumerating current pool participants and
funding before this operation.

### 7.3 Order and checks

1. Ostium first, then Base prod after Ostium has run cleanly for a day.
2. Run the inventory checks before admitting traffic, then the usage/error/latency checks after admission. Replace the service filter for Base prod, and bound each query to the deployment being checked:

   **Query 1: the startup line on every new pod.** After the required clean migration, with all pods configured for the same 20 eligible wallets and traffic blocked, expect the first reconcile to add 20 and later reconciles to add 0; `poolSize: 20`, `inUseCount: 0`, `foreignCount: 0`. In a later new-protocol rollout adding 10 to an existing 10-wallet pool, expect 10 additions across all startup logs. Different eligible sets can legitimately report nonzero `foreignCount`. Counts are snapshots, not proof that an in-use entry has a live holder.
   ```sql
   SELECT dt, JSONExtract(raw, 'hostname', 'Nullable(String)') AS host,
          JSONExtract(raw, 'addedCount', 'Nullable(Int64)') AS added,
          JSONExtract(raw, 'poolSize', 'Nullable(Int64)') AS pool,
          JSONExtract(raw, 'inUseCount', 'Nullable(Int64)') AS in_use,
          JSONExtract(raw, 'foreignCount', 'Nullable(Int64)') AS foreign
   FROM remote(t187081_ultra_relay_base_prod_logs)
   WHERE raw LIKE '%srv-d9obrkvlk1mc73897rvg%' AND raw LIKE '%reconciled executor wallet pool%'
     AND dt >= parseDateTimeBestEffort('<rollout time>')
   ORDER BY dt
   ```

   **Query 2: wallets observed submitting.** Track distinct executors as a usage check; no fixed bundle count guarantees that every wallet submits. The deployment gate is an atomic snapshot (`MULTI` / `LRANGE pool 0 -1` / `SMEMBERS in-use` / `EXEC`): before traffic, the lowercase list contains exactly the approved eligible union once and in-use is empty. After traffic begins, list plus in-use must cover that union, with no overlap or duplicates. Unexpected reservations require investigation, not deletion.
   ```sql
   SELECT toStartOfHour(dt) AS h,
          uniqExact(lower(JSONExtract(raw, 'executor', 'Nullable(String)'))) AS executors,
          count() AS bundles
   FROM remote(t187081_ultra_relay_base_prod_logs)
   WHERE raw LIKE '%srv-d9obrkvlk1mc73897rvg%' AND raw LIKE '%submitted bundle transaction%'
     AND dt >= parseDateTimeBestEffort('<rollout time>')
   GROUP BY h ORDER BY h
   ```

   **Query 3: rollout safety.** Expect no new nonce-conflict or legacy foreign-wallet errors. Any such error blocks rollout to the next instance and requires investigating concurrent signers, pool state and pending transactions. It is not an allowed one-time migration exception. Bound this query to the rollout window.
   ```sql
   SELECT dt, JSONExtract(raw, 'hostname', 'Nullable(String)') AS host,
          substring(JSONExtract(raw, 'message', 'Nullable(String)'), 1, 120) AS msg
   FROM remote(t187081_ultra_relay_base_prod_logs)
   WHERE raw LIKE '%srv-d9obrkvlk1mc73897rvg%'
     AND (raw ILIKE '%nonce too low%' OR raw ILIKE '%replacement transaction underpriced%'
          OR raw LIKE '%wallet not found%' OR raw LIKE '%executorWalletNotOwned%')
     AND dt >= parseDateTimeBestEffort('<rollout time>') - INTERVAL 5 MINUTE
     AND dt < parseDateTimeBestEffort('<rollout time>') + INTERVAL 10 MINUTE
   ORDER BY dt
   ```

   **Query 4: acquisition latency.** Compare `[timing] bundle.getWallet` against a pre-rollout window with similar load and free eligible capacity. The historical p50 0.9ms / p95 11.3ms is context, not a universal gate. Investigate new 100ms polling plateaus when eligible addresses should be free. S12 measured an absolute local command time, not incremental production overhead; the revised scripts require fresh measurement.

3. Replace obsolete `executorWalletNotOwned` alerting only after all legacy pods are gone. Keep acquisition-failure monitoring and add these to operational checks: the `wallet return failed; reservation requires inspection`, `executor wallet pool is not armed; added no wallets` and `executor wallet sync failed` errors, and the `re-added missing executor wallets` warning. The warning should not appear in normal operation; each one means something removed a pool entry. Absence of the legacy error does not prove pool health.

### 7.4 Expected Ostium result

With 20 eligible, funded and unstranded wallets, the next Ostium burst can use up to 20 executors. The historical wait was already small with 10 (§1.4), so this change does not promise a win-rate improvement. The guarantee is membership for eligible missing addresses at startup, not a usage quota for each key.

### 7.5 Rollback

Checksummed list entries are format-compatible with the old image; the
ownership protocols are not compatible. Do not roll the old image over
running new-protocol pods or delete the in-use set under live holders.

1. Apply §8.3 steps 1–3 to stop **all** pool participants and resolve every
   outstanding checkout/transaction. Keep traffic and automatic restarts blocked.
2. Approve the rollback wallet list from the old image's effective configuration
   (after `maxExecutors`). Every legacy replica sharing this pool must have the
   same eligible addresses. Omit addresses it cannot sign for; fund those retained.
3. In one Redis transaction, delete **all three** pool keys (list, in-use, marker)
   and populate the idle list with exactly one checksummed copy of each approved
   rollback address. Do not preserve case variants, duplicates or new-only
   addresses. Keep in-use and the marker absent: an unarmed pool makes any
   new-protocol pod started by mistake refuse to start.
4. Start the old replicas with traffic still blocked. The prepopulated nonempty
   list avoids their unsafe empty-pool seed race. Verify their effective key
   lists match the rebuilt pool before resuming traffic.
5. A later upgrade must repeat §7.2; legacy activity creates unrecorded holds again.

### 7.6 Abort criteria

Stop admitting new work and pause the deployment if a legacy writer remains,
key types are wrong, a pod reports the pool is not armed, inventory differs from the approved eligible union before
traffic, a wallet return reports missing/uncertain membership, or unexpected
nonce conflicts appear. Do not repair by deleting only the in-use key or by
restarting a random pod. Resolve uncertainty through §8.3 or perform the
stopped rollback above.

## 8. Runbooks

Resolve the exact keys through `getRedisKeys` and take an atomic list/set/marker
snapshot before modifying them.
Never use a wildcard delete or `FLUSHDB`/`FLUSHALL` for pool repair.

### 8.1 Add wallets

Fund them on the correct chain, add the keys to the intended pods' configuration,
and check that they survive `maxExecutors` slicing. Once the whole pool already
uses the new protocol, deploy those pods; each startup adds its eligible missing
addresses. Existing in-use reservations remain untouched. Check startup logs
and an atomic membership snapshot against the approved union, then observe usage
with §7.3 query 2. The 5-minute sync does not hot-reload keys into a running
process; new keys still need a restart. Handle
any reservations stranded by replacing pods under §8.3; a restart cannot reclaim
them automatically.

### 8.2 Retire wallets

`foreignCount` is not a retirement signal: a wallet can be foreign to one pod
and owned by another. Identify every participant sharing the exact pool keys.

1. Prepare replacement configurations that remove the retired addresses from
   every participant's effective eligible list. Check the union still has the
   intended funded capacity; a pod with no eligible keys cannot start.
2. Follow §8.3 steps 1–3. Prove no old process can return the retired address and
   resolve its pending transaction/nonces before removing membership or sweeping.
3. Clear the pool keys, re-arm, and restart only the approved configurations as in
   §8.3 steps 4–5. This rebuild removes all case variants and stale retired reservations;
   an exact-case `LREM` by itself would not.
4. Verify retired addresses are absent from both keys and all effective configs.
   Sweep leftover funds only after the transaction/nonces are settled and no
   service can sign with those keys. Sweeping is outside this change.

### 8.3 Recover stranded wallets or rebuild membership

A killed pod, an unresolved checkout at graceful termination, or a lost Redis
reply can leave a reservation stranded. There is no owner/age data in this set:
several idle minutes, `SCARD`, or a quiet log is insufficient evidence to clear it.
Redis data loss (pods log `executor wallet pool is not armed`) also lands here.

1. Record the exact pool namespace, current list/set, approved per-pod eligible
   lists, and any known submitted/quarantined transactions. Block new user work
   and all acquisition producers, including scheduled bundle work and RPC sends.
   Disable automatic old-pod restarts. An HTTP maintenance window alone is not a
   proof that workers stopped.
2. Stop every process that can use these wallets, including other deployments
   sharing the prefix and any independent signer discovered during inventory.
   Confirm none can acquire, sign, broadcast, retry, return or recreate pool state.
   Each new-protocol pod runs a 5-minute sync; stopping the pod stops it.
   If this cannot be established, do not clear either key.
3. Resolve outstanding transactions for all addresses to be reused, including
   addresses whose return outcome was unknown. Use submission/rotation logs,
   receipts and latest/pending nonce inspection; equality of one provider's
   pending/latest nonce counts alone does not prove no delayed broadcast exists.
   Wait for confirmation or explicitly resolve/cancel pending nonces according
   to the chain's existing operations procedure. Do not reuse an address whose
   status remains uncertain; keep work blocked until it is resolved.
4. With all writers stopped, delete the pool list and in-use set and arm the pool
   in one transaction (`MULTI`, `DEL <pool> <in-use>`,
   `SET <armed> '<UTC time> <operator> <reason>'`, `EXEC`). No other Redis keys
   change. The marker is what lets pods add wallets; set it only here.
   Rebuild from the approved eligible configurations, not the old possibly dirty
   list. For legacy rollback, use §7.5's prepopulation instead of the next step.
5. Start new-protocol pods with work still blocked. Reconcile may only add missing
   members. Verify startup logs and an atomic snapshot: the approved lowercase
   union appears once in the checksummed idle list, and in-use is empty. Then
   restore traffic and normal restart policy. Preserve the snapshot for audit.

Never attach TTLs, periodically `SREM`, clear just the set, or set the marker to
recover capacity while holders can still run. With no lease/fencing token, those actions can hand
out the same wallet twice.

## 9. Out of scope

- **Automatic recovery of unavailable reservations.** This requires ownership and a safe fencing/recovery protocol; a heartbeat or TTL alone cannot prove an old signer has stopped. §8.3 is the manual path, including unresolved graceful shutdowns and lost replies.
- **Automatic removal of retired keys.** §8.2 is the manual path.
- **Reclaiming in-use reservations at runtime, and hot key reload.** The 5-minute sync re-adds only addresses missing from both keys. It cannot reclaim an in-use reservation, and new keys still need a restart.
- **Automatic recovery after Redis data loss.** The marker disappears with the data, so pods add nothing until §8.3 re-arms the pool.
- **Capacity-aware `bundleBudget`.** It still comes from `getAllWallets().length`, now the distinct eligible count for Redis, not the shared free-wallet count. Excess bundle tasks still poll every 100ms. Cancellation, wait deadlines and capacity-aware scheduling are separate work; polling with no free eligible wallet is not readiness proof.
- **ADR 0004's other recovery bugs:** requeue-write loss, duplicate release attempts in callers, and other unhandled rejections. This revision prevents a stale Redis release from freeing a newer checkout but does not refactor those callers or the in-memory manager.
- **Fully draining shutdown.** Unresolved Redis reservations remain unavailable. A future drain must meet §4.5 before restoring blanket release behavior.
- **Redis Cluster.** The three keys share no hash tag. Render's Redis is a single node; add a tag if that ever changes.

## 10. Prototype evidence

`docs/specs/2026-09-29-wallet-pool-membership.proto.mts` and `.race.mts` exercised the **earlier** scripts against Redis 8.6 on port 6391 through ioredis 5.4.1. They do not implement this revision's guarded return, key-type preflight, checkout identity, client failure policy, shutdown rules, armed marker or periodic sync. The historical results below must not be reported as a pass of this revision. T1–T21 and shutdown coverage require fresh evidence on CI's Redis 7.2 as well.

To reproduce only the historical prototype, first verify port 6391 is unused and belongs to no shared service. These scripts delete their hardcoded `proto:*` / `race:*` keys, and the prototype runs server-wide `SCRIPT FLUSH`. Use a disposable local server owned by this test. Shut down only the server started for this run; do not run the final command against an existing server:

```
redis-server --port 6391 --save '' --appendonly no --daemonize yes
node_modules/.bin/tsx docs/specs/2026-09-29-wallet-pool-membership.proto.mts
node_modules/.bin/tsx docs/specs/2026-09-29-wallet-pool-membership.race.mts
redis-cli -p 6391 shutdown nosave
```

Previously recorded results (2026-09-29; not rerun for this revision):

| # | Scenario | Result |
|---|---|---|
| S1 | Empty pool, 20 keys | 20 added, length 20 |
| S2 | Pool holds the old 10 (checksummed), pod has 20 | exactly the new 10 added; 20 entries, 20 distinct |
| S3 | 3 wallets in use, another pod starts | 0 added; length 7, in-use 3 |
| S4 | 5 pods start at once on an empty pool | 20 entries, all distinct |
| S5 | Own 10 interleaved with foreign 10 | 10 own taken, 11th take returns nil, the 10 foreign left in the list |
| S6 | Extra copy of an in-use wallet pushed back | next take returns a different wallet; the copy is dropped |
| S7 | Hand-pushed lowercase entry | taken; goes back checksummed; no duplicate |
| S8 | Round trips | take 1, return 1, both return the pool length |
| S9 | `SCRIPT FLUSH` then take | works (ioredis `EVAL` fallback) |
| S10 | 3 pods × 12 workers × 34 cycles on 20 wallets (1,224 takes; 1,177 empty polls under contention) | **0 wallets held twice**; afterwards 20 in the list, 0 in use |
| S11 | Old-build pod holds a wallet during the first rollout | startup re-adds it; demonstrates why mixed-version execution is prohibited (§7.2) |
| S12 | Take past 20 foreign entries, 500 take/return pairs | 0.197ms per pair locally; `evalsha` 6.95µs per call in Redis |
| S13 | 40 cycles over legacy and new entries | entries stay checksummed; format evidence only, not proof of safe rollback |
| S14 | 2 busy pods × 10 workers taking and returning (2,233 takes) while 3 more pods run the startup add at the same moment and then 300 times each (900 adds) | **0 wallets added, 0 held twice, 0/125 atomic snapshots with a duplicate or a missing wallet**; end: 20 in the list, 0 in use (`2026-09-29-wallet-pool-membership.race.mts`) |
| S15 | Today's code: pods A and B both run `LLEN` (0), A seeds and takes W, then B seeds | B's seed puts W back while A holds it; after A returns W the list holds **2 copies**, so two bundles can use W at once |
