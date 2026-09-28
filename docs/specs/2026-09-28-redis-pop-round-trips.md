# Pop outstanding userOps in one Redis round trip

- **Status:** locally validated optimization; original Lua fee conversion rejected and corrected below. Implementation and production verification remain outstanding.
- **Date:** 2026-09-28
- **Branch:** `feat/redis_rtt_optimization` (based on `ba8d4cf`, the head of PR #78)
- **Affects:** relays that run with `enable-horizontal-scaling` and a Redis endpoint. The original production analysis identifies Ostium (`srv-d9obrkvlk1mc73897rvg`, Arbitrum One) and Base prod (`srv-cu81pel6l47c739toh50`). Their current deployment state was not independently queried in this audit. The pass-loop change also affects in-memory relays.

## 0. Implementation contract and audit verdict

The round-trip reduction is validated against source at `ba8d4cf29d15e09350f7363261734fe468badac7` and real Redis. Implement the corrected script in §3, not the original base-16 conversion. Production latency and win-rate claims are hypotheses, not acceptance tests.

**Allowed implementation files:**

| File | Required change |
|---|---|
| `src/store/createRedisOutstandingStore.ts` | Add the exact §3.1 script, command typing/registration, replace `pop()`, remove only the two newly unused helpers |
| `src/mempool/mempool.ts` | Make only the four edits in §3.2 |
| `src/store/createRedisOutstandingStore.script.test.ts` | Add real-Redis contract tests from §5.1 |
| `src/mempool/mempool.test.ts` | Update four assertions and add the §5.2 regressions |
| `.github/workflows/lint.yaml` | Add a test Redis service and set `REDIS_URL` on the existing unit-test step |

Do not change `OutstandingStore`/`MempoolStore`, Redis key/member formats, queue `add`/`remove`/`peek`/`popConflicting`, caps, carry ownership, nonce ordering, scheduling, deployment values, or dependencies. Do not implement batch pop, Redis Cluster support, atomic writers, or corrupt-data repair. Keep existing TypeScript deserialization and error logging. Never commit or push; stage only.

**Fresh evidence, 2026-09-28:** Node 22.21.1, ioredis 5.4.1, standalone Redis 8.6.1, isolated Unix socket; no production Redis access. The companion [audit harness](./2026-09-28-redis-pop-round-trips.audit.cjs) reproduces the store checks; [results](./2026-09-28-redis-pop-round-trips.evidence.json) record the assertions and wire traces.

| Claim | Verdict / measured evidence |
|---|---|
| One-bundle traversal goes from `6n + 6` to `n + 3` | Confirmed: n=1: 12→4; n=4: 30→7; n=12: 78→15 socket writes, each waiting for the previous response |
| Original Lua preserves all fee scores | **False:** at `2^80`, old score is `1.2089258196146292e24`, original Lua score is `1.8446744073709552e19`. The original conversion saturates above unsigned-long range |
| Corrected Lua matches ordinary sequential behavior | 40 deterministic seeds, 3,296 operations/state comparisons, 1,689 pop attempts; returned records and complete Redis state match. Fees include values above 64 bits |
| Concurrent pops are exclusive | Two consumers drain 40 same-slot operations: 40 unique hashes, no remaining queue/index keys |
| Old pop can damage a completed concurrent add | Confirmed by pausing at exact transaction boundaries: one schedule loses the slot; another leaves a stale ready entry |
| Atomic pop fixes every writer race | **False:** pausing `add` between its read and `EXEC` still leaves its new member indexed but unreachable |
| Pop is always one request | **False:** cold socket sends `EVAL`, warm socket `EVALSHA`; `SCRIPT FLUSH` causes `EVALSHA`→`EVAL`, two requests |
| Invalid-member behavior is unchanged | **False:** valid JSON rejected by Zod can be deleted before TypeScript rejects it. See §3.4 |
| General multi-bundle cost is `6n + 2b + 4` | **False:** carry short-circuits peeks. T1 has 11 peeks for 7 pops / 3 bundles, not 13 |
| Production milliseconds and win-rate gains are established | Not independently verified: raw BetterStack exports and order-pairing dataset were not supplied or fetched |

Source-copy checks also confirm the four assertion changes in §5.2. See §5.3 for the exact validation commands and results. These prototypes did not modify production source files.

## 1. Summary

The shared Redis queue imposes serial network waits in the bundling pass. Removing them is justified by code and local execution. The original production analysis below suggests they dominate pass time, but does not independently establish that attribution.

- **Cost per successful pop:** a nonempty 2-request `peek()` followed by a 4-request `pop()`, excluding carry reevaluation and other store operations. A clean one-bundle 12-op drain takes 78 queue-traversal round trips.
- **Reported burst cost:** the original analysis estimates about 2.6ms per round trip; 9+ op passes have 181ms median and 246ms p95.
- **Reported association:** in the Sep 25 sample, ops waiting over 100ms won 25% of races, versus 64% below 50ms. This is correlation, not proof that reducing queue waits will produce the same win-rate change.

This change has two parts:

1. **Atomic pop.** Replace `RedisOutstandingQueue.pop()` with one Lua script. It takes one round trip in steady state and runs atomically.
2. **No per-op peeks.** Remove the two per-iteration `peekOutstanding()` calls from `Mempool.process()`. The pass learns that the queue is empty from the pop itself.

A clean drain goes from `6n + 6` queue-traversal round trips to `n + 3`. For 12 ops that is 78 → 15. Preconditions and exceptions are in §3.5. Unverified predicted p50 pass times:

| Pass | Today | Expected |
|---|---|---|
| Ostium burst, 9+ ops | 181ms | ~40ms |
| Ostium quiet, 1 op | 13ms | ~5ms |
| Base prod, 1 op | 9.2ms | ~4ms |

The atomic pop also closes two windows in which today's pop damages a concurrent write. One loses an op; the other can stop bundling on an entry point (§2.7).

## 2. Why: evidence

**Provenance boundary:** production numbers in this section are retained from the original spec, not newly verified facts. That analysis names BetterStack UR source 1169629, window Sep 25 13:55 → Sep 28 07:58 UTC, Ostium build `76d896d4d4`, and other relays `main-78574d8`. These are different builds from the audited source. It describes pairing Ostium orders against Pimlico's by order id in calldata and joining UserOperationEvents. If both report success, it assigns the win to the first inclusion, treating the later one as a no-op. Reproduction needs exported rows, chain receipts/calldata, pairing code, and explicit ordering by block number, transaction index, and log index; those artifacts are absent.

### 2.1 Reported queue wait correlates with burst outcomes

Data: the Sep 25 burst (19:56–20:00 UTC), 167 Ostium orders sent to both us and Pimlico. Each order is joined by userOpHash to UR's `outstandingMs`, which runs from "added to mempool" to "accepted by a bundling pass".

| Queue wait | Ops | We won | Lost by ≥1 block |
|---|---|---|---|
| under 50ms | 88 | 63.6% | 12.5% |
| 50–100ms | 47 | 55.3% | 21.3% |
| 100–200ms | 23 | 34.8% | 56.5% |
| over 200ms | 9 | **0%** | 100% |

The table implies 90 wins / 167 orders = 53.9%. Replacing the 8 wins among the slowest 32 orders with `32 × 56/88` gives about 12.4 additional wins, or 7.4 percentage points. This is an illustrative counterfactual, not a causal estimate or mathematical upper bound; load and competing keeper behavior can confound the association.

### 2.2 Pass scheduling contributes to queue wait

- **Passes on one pod run back to back.** `autoScalingBundling()` awaits `getBundles()` and only then arms the next tick (`scheduleNextTick`, `src/executor/executorManager.ts`). Ostium's interval is 50ms (`min-bundle-interval` = `max-bundle-interval` = 50).
- **`processingAt` is stamped when a pass accepts the op** (accept branch of `Mempool.process()`). Wait can include residual pass time, time until the next tick, and work before acceptance. Arrivals may join the current pass or be popped by another pod. Budget/skip paths and event-loop lateness add other delays; the three terms are not an exact per-op decomposition.
- **Quiet hours vs burst:**

  | | Pass | Queue p95 |
  |---|---|---|
  | Quiet | ~13ms | 53ms (about the interval) |
  | Sep 25 burst | p95 275ms / 256ms (two pods) | 177ms / 257ms (208ms overall) |

### 2.3 Reported pass times are consistent with Redis overhead

Only two relays use the Redis queue. The startup line `Using redis for outstanding, processing, submitted mempools` appears for Base prod (56 starts) and Ostium (68 starts). All 35 other relays log `Using memory for outstanding…` (Sep 19–28). The pass code is the same everywhere. Here is `[timing] bundling.getBundles`, p50 ms, with the number of passes in parentheses:

| Relays | 1 op | 2 ops | 3–4 ops | 5–8 ops | 9+ ops |
|---|---|---|---|---|---|
| In-memory queue | 0.9 (54,197) | 1.6 (911) | 2.3 (180) | 6.8 (17) | — |
| Base prod (Redis) | 9.2 (41,233) | 14.0 (1,534) | 19.5 (353) | 31.6 (87) | 77.7 (76) |
| Ostium outside the burst (Redis) | 13.1 (1,394) | 17.0 (21) | 20.5 (7) | 138 (2) | — |
| Ostium, Sep 25 burst (Redis) | 15.0 (12) | 19.4 (7) | 32.5 (12) | 80.9 (4) | 181.4 (7) |

Passes that end with 0 ops are excluded. They take 60–85ms on every kind of relay, in-memory included, so that time comes from another path.

The cross-relay difference is consistent with Redis wait overhead, but does not rule out CPU, payload size, safe-mode validation, chain, or load differences. The local command trace independently establishes the removable waits; production profiling must establish their share of elapsed time.

### 2.4 The count: 6n + 6 round trips per pass

From the code at `ba8d4cf`:

- **`peek()`** (`src/store/createRedisOutstandingStore.ts:280`): `ZRANGE ready 0 0`, then `ZRANGE <slot> 0 0`. **2 round trips.**
- **`pop()`** (`:431`): `ZMPOP MAX`, then `ZRANGE <slot> 0 1`, then `MULTI ZREM HDEL [HDEL] EXEC`, then `ZADD ready` or `DEL <slot>`. **4 round trips.**
- **`Mempool.process()`** (`src/mempool/mempool.ts:791`) makes these calls:
  - a peek for `firstOp` (line 805);
  - a peek in the outer `while` for each bundle (838);
  - for each op, a peek in the inner `while` (915) and then a pop (931);
  - at the end, one inner peek and one outer peek that find the queue empty.

For one bundle of n ops: `2 + 2 + n × (2 + 4) + 1 + 1 = 6n + 6`.

**Original measurement report, not rerun:** real Redis 8.6.1 behind a proxy holding each request for 5ms; commands issued in one tick were grouped. The original harness was not attached. The fresh audit instead records actual socket writes and RESP commands, verifying the round-trip counts below without asserting the old proxy wall times. These pass rows replay queue calls only, not full `Mempool.process()` or asynchronous processing-store writes.

| Call | Round trips | Commands | Original reported proxy elapsed time |
|---|---|---|---|
| `peek()` | 2 | 2 | |
| `pop()` | 4 | 7 | |
| `add()` | 2 | 6 | |
| Lua pop (this spec) | 1 | 1 | |
| Pass, 1 op: today → proposed | 12 → 4 | 15 → 4 | 90 → 31ms |
| Pass, 4 ops | 30 → 7 | 42 → 7 | 220 → 51ms |
| Pass, 12 ops | 78 → 15 | 114 → 15 | 573 → 109ms |

**The reported Base model fits** within 0–3ms using 0.76ms per round trip. This is a fitted model, not an independent RTT measurement; bucket-average operation counts and bucket-median duration also need not describe the same pass:

| Ops (average in bucket) | Predicted `(6n + 6) × 0.76ms` | Measured p50 |
|---|---|---|
| 1 | 9.1 | 9.2 |
| 2 | 13.6 | 14.0 |
| 3.3 | 19.4 | 19.5 |
| 6.1 | 32.2 | 31.6 |
| 15.5 | 75.0 | 77.7 |

### 2.5 The fitted per-trip cost is higher in the reported burst

- **Ostium outside the burst:** 13.1ms ÷ 12 ≈ **1.1ms** per round trip.
- **Ostium, Sep 25 burst:** passes with 9+ ops average 10.7 ops, which is 70 round trips, and take 186ms on average. That's ≈ **2.6ms** per round trip.

Each await only resumes when the pod's event loop gets to it. The analysis reports up to about 20 arrivals/second plus concurrent block processing. Fewer awaits reduce exposure to such delay; whether the gain grows with load needs measurement, not division of elapsed pass time by a fitted request count.

### 2.6 Alternative explanations and changes not proven necessary

- **Wallets.** Reportedly every burst pass had budget 10 and built at most 3, with wallet wait at most 5–7ms. That suggests wallet supply was not the main bottleneck in this window; it does not establish that ops never wait for wallets.
- **A third pod.** Another puller retains the same per-pop cost but could increase throughput. It has not been experimentally ruled out; changing pod count is outside this optimization.

### 2.7 Side effect: today's pop is not atomic

`pop()` reads the slot (`ZRANGE`), writes in a separate MULTI, and then `DEL`s the slot in a fourth round trip. An `add()` for the same sender and nonce key that lands in between is damaged.

**Original reproduction report (timing counts not independently rerun).** The popping connection used a 10ms proxy; a second connection wrote the follow-up at 41 times, from 0 to 60ms into the ~47ms pop. Fresh deterministic reproductions are in §0 / Appendix A; do not treat the table as measured failure probabilities:

| | Follow-up op kept | Follow-up op lost | Stale ready entry (bundling stops) |
|---|---|---|---|
| Today's pop | 24 | 9 | 8 |
| Lua pop (this spec) | 40 | 1 | 0 |

The three outcomes:

- **Lost.** The write lands between `ZRANGE` and `EXEC`. The op goes into the set with no ready entry, and the `DEL` then removes the set. `userOpHashLookup` still maps the op, so `isInMempool` reports it as queued, but it's never bundled.
- **Stale entry.** The write lands between `EXEC` and `DEL`. It adds a ready entry, and the `DEL` removes the set behind it. `peek()` reads the *lowest*-fee ready entry (`ZRANGE 0 0`, although its comment says "highest"). If the stale entry has the lowest fee, `peek()` returns nothing while other ops are ready. `process()` then returns `[]` at its first line on every tick, until an op with a lower fee arrives.
- **The one Lua loss.** Here the pop itself was atomic. The problem is the write's own two round trips: `add()` reads the lowest nonce, then writes, and the pop ran in between. The same gap exists today. Making `add()` atomic closes it (§8).

**Exposure (reported production sample):**

- **The sampled Ostium burst does not show same-slot successors:** reportedly 167 ops from 1 sender on 167 keys. That does not prove all future traffic, retries, or replacements are immune.
- **Base prod can.** It serves many senders, and any sender that queues more than one op on the same nonce key is exposed. I haven't measured how many do.
- **No sign it has happened:** from Sep 21 to 28, no included op on either relay waited more than 5s in the queue (worst: 1.7s on Base, 1.1s on Ostium). A lost op is never included, though, so this data can't rule loss out.

## 3. Change

### 3.1 Atomic pop script

File: `src/store/createRedisOutstandingStore.ts`.

Add this script as a module constant after imports. This is the corrected script exercised by the fresh audit. Preserve raw stored JSON for both `ZREM` and the return value; never re-encode with `cjson.encode` or reconstruct a member in TypeScript.

```ts
// Atomic pop for valid records on standalone Redis. In steady state, the
// highest-fee ready slot's lowest-nonce op is removed with its hash-index
// entry, and the slot is re-ranked by its next op's fee or deleted.
// KEYS[1] ready queue    (zset: pending-ops key -> maxFeePerGas of its lowest nonce)
// KEYS[2] hash lookup    (hash: userOpHash -> pending-ops key)
// KEYS[3] factory lookup (hash: sender -> userOpHash of its deployment op)
// Returns the popped member exactly as stored, or nil when nothing is ready.
const POP_OUTSTANDING_SCRIPT = `
local pendingOpsKey, ops
repeat
    local top = redis.call('ZPOPMAX', KEYS[1])
    if #top == 0 then
        return false
    end
    pendingOpsKey = top[1]
    ops = redis.call('ZRANGE', pendingOpsKey, 0, 1)
    -- An entry whose ops set is empty is stale; ZPOPMAX already dropped it.
until #ops > 0

local current = cjson.decode(ops[1])
redis.call('ZREM', pendingOpsKey, ops[1])
redis.call('HDEL', KEYS[2], current.userOpHash)

local sender = current.userOp.sender
if redis.call('HGET', KEYS[3], sender) == current.userOpHash then
    redis.call('HDEL', KEYS[3], sender)
end

if #ops > 1 then
    local nextOp = cjson.decode(ops[2])
    -- Keep the 0x prefix. Explicit base 16 uses strtoul and saturates
    -- above unsigned-long range, whereas stored fees can be uint256.
    local fee = tonumber(nextOp.userOp.maxFeePerGas)
    redis.call('ZADD', KEYS[1], fee, pendingOpsKey)
else
    redis.call('DEL', pendingOpsKey)
end

return ops[1]
`
```

Declare the command's type, using ioredis v5's documented module augmentation (add `type Result` to the existing `ioredis` import):

```ts
declare module "ioredis" {
    interface RedisCommander<Context> {
        popOutstandingOp(
            readyOpsQueueKey: string,
            userOpHashLookupKey: string,
            factoryLookupKey: string
        ): Result<string | null, Context>
    }
}
```

Register it in the `RedisOutstandingQueue` constructor, right after `this.redis = new Redis(redisEndpoint, {})` (line 191):

```ts
this.redis.defineCommand("popOutstandingOp", {
    numberOfKeys: 3,
    lua: POP_OUTSTANDING_SCRIPT
})
```

Replace the body of `pop()` (lines 431–485):

```ts
async pop(): Promise<UserOpInfo | undefined> {
    const member = await this.redis.popOutstandingOp(
        this.readyOpsQueue.keyPath,
        this.userOpHashLookup.keyPath,
        this.factoryLookup.keyPath
    )
    return member ? deserializeUserOpInfo(member) : undefined
}
```

`RedisSortedSet.popMax()` and `RedisSortedSet.delete()` were only used by the old `pop()`, so remove them. `RedisSortedSet.popMin()` was already unused before this change; leave it.

Notes on the script:

- **Ordering.** Choose highest ready score, then lowest slot score. Preserve Redis tie ordering: lexicographically greatest slot key wins equal ready scores (`ZPOPMAX`); lexicographically smallest raw member wins equal nonce scores (`ZRANGE`). Do not sort by sender, hash, or decoded nonce. Nonce scores already use `Number(nonceSeq)`; changing their precision is out of scope.
- **Keys and topology.** Fixed keys are passed as `KEYS`, but the slot key is discovered from the ready set. This works on the tested standalone server. Redis documentation requires all accessed keys to be explicit even for standalone deployments; this design is a deliberate restriction to tested, non-clustered Redis deployments, not a portable scripting pattern. `new Redis(url)` alone does not establish the server topology. Confirm the actual deployment supports this access pattern before rollout; do not claim Cluster/proxy support. [Redis scripting key requirements](https://redis.io/docs/latest/develop/programmability/eval-intro/#script-parameterization)
- **Fee precision.** Required score is `Number(nextUserOp.userOp.maxFeePerGas)`. Use exactly `tonumber(nextOp.userOp.maxFeePerGas)`, retaining its serialized `0x` prefix. The original `tonumber(string.sub(hex, 3), 16)` passes the original 60-bit test but saturates above unsigned-long range. Redis's embedded Lua implementation calls `strtoul` for explicit nondecimal bases. Fresh tests cover 60-, 66-, 81-, 128-, and 256-bit inputs; §5 expands boundaries. Do not clamp to safe integers or convert uint256 through a decimal Lua integer. [Redis Lua conversion source](https://github.com/redis/redis/blob/7.2/deps/lua/src/lbaselib.c#L47-L72)
- **Redis version.** Keep the existing operational floor Redis 7; this change does not declare a lower supported version. Local evidence used 8.6.1. CI must exercise Redis 7 as specified in §5. `cjson` is provided by Redis, not by ioredis-mock.
- **Script cache.** Installed ioredis 5.4.1 `built/Script.js` sends `EVAL` on the first use of a socket, then `EVALSHA`. After `SCRIPT FLUSH`, the same socket sends `EVALSHA`, receives `NOSCRIPT`, then sends `EVAL`: two round trips. Use `defineCommand` as written, outside a pipeline/MULTI. Add no manual cache loader or retry loop. Cache recovery is covered; arbitrary network-failure/exactly-once guarantees are not. [ioredis custom commands](https://github.com/redis/ioredis#lua-scripting)
- **Atomicity.** Other commands cannot interleave inside a successful script. This is not rollback on runtime errors and does not make the read/write sequences in `add` or `remove` atomic. Empty/stale handling loops over stale entries in this invocation; cost is O(number of stale entries encountered), and Redis is blocked while it runs. Do not introduce a fixed skip limit that makes `false` mean something other than exhaustion.

### 3.2 Pass loop

File: `src/mempool/mempool.ts`, `process()`. Make four edits, without restructuring. Line numbers refer to the baseline; use method/statement anchors after inserting code.

Next to `let breakLoop = false` (line 813):

```ts
        let breakLoop = false
        // Set by the first pop that finds nothing ready. The loops used to
        // re-check with a peek before every pop, which on the Redis queue
        // cost two extra round trips per op; the pop already reports empty.
        let outstandingEmpty = false
```

Both loop conditions, the outer one (lines 836–839) and the inner one (913–916):

```ts
-            while (
-                carriedUserOpInfo ||
-                (await this.store.peekOutstanding(entryPoint))
-            ) {
+            while (carriedUserOpInfo || !outstandingEmpty) {
```

```ts
-                while (
-                    carriedUserOpInfo ||
-                    (await this.store.peekOutstanding(entryPoint))
-                ) {
+                while (carriedUserOpInfo || !outstandingEmpty) {
```

The empty pop (lines 930–934):

```ts
                         const poppedUserOpInfo =
                             await this.store.popOutstanding(entryPoint)
                         if (!poppedUserOpInfo) {
+                            outstandingEmpty = true
                             break
                         }
```

Everything else in `process()` stays as is: the first `peekOutstanding` at line 805, the carry slot, `seenOps`, the nonce-slot rule, the caps, `maxBundleCount`, `onBundle`, and `finally`.

### 3.3 What does not change

- **Store operations:** `peek()`, `add()`, `remove()` and `popConflicting()`.
- **Redis data:** the key layout and the member format. Pods on the old and new builds can share one Redis during a rolling deploy.
- **The first `firstOp` peek.** It keeps an idle tick at 1 round trip and keeps T15a's "no pop on an empty store".
- **The in-memory queue**, and the `OutstandingStore` and `MempoolStore` interfaces.

### 3.4 Behaviour differences (deliberate)

1. **Factory lookup.** Today's pop deletes `factoryLookup[sender]` whenever the popped op is a deployment. The script deletes it only if the entry points at the popped op. The two differ only when a sender has two deployment ops queued; there, today's pop drops tracking of the one still queued. This also avoids re-implementing `isDeployment()` in Lua.
2. **Stale ready entries are skipped** and dropped, instead of making the pop return nothing. The new loop treats an empty pop as "queue empty", so a stale entry at the top must not end the pass early.
3. **The pass ends at its first `undefined` pop.** This includes another pod draining the queue and errors swallowed by `createMempoolStore.popOutstanding`. Finish and hand over any nonempty current bundle, then return. `outstandingEmpty` is local to one `process()` invocation; the next pass retries normally. Arrivals after that observation, including arrivals during `onBundle`, wait for a later pass. The configured 50ms interval is not a hard pickup deadline: event-loop delay, later entry points, budgets, and other pods affect it.
4. **Malformed data is not behavior-equivalent.** Supported input is a valid `UserOpInfo` serialized by the existing writer, with the documented Redis key types. Preserve the existing TypeScript deserializer and wrapper logging; do not claim rollback or silently catch errors inside Lua:
   - Invalid JSON in the current member: `ZPOPMAX` has removed readiness; `cjson.decode` fails before member/index deletion. The slot and index remain orphaned, as in the old current-member parse failure.
   - Valid JSON with a Zod-invalid field not read by Lua, such as `addedToMempool: "bad"`: Lua removes the member/index, then TypeScript throws. Old pop throws before those deletions. This changed failure boundary was reproduced.
   - Invalid next-member JSON: current-member removal can already have occurred when decoding the successor fails; the caller receives no operation, and the successor remains without readiness. Lua errors do not undo writes.
   - Corrupt-data repair/full Zod validation in Lua is outside this patch. These are explicit limitations, not successful-pop cases. A rollout encountering such errors must stop and investigate stored data rather than blindly retrying the mutating script.
5. **A lost reply makes the pop at-least-once.** ioredis defaults to `autoResendUnfulfilledCommands: true`. If the socket drops after Redis ran the script but before the reply arrived, ioredis resends it on reconnect (as a full `EVAL`); the script runs again and pops the next op. The first op is deleted from its slot and the hash index, is never returned, and nothing is logged. Reproduced in review against Redis 8.6.1 through a reply-dropping proxy. This is not a regression: the baseline's non-idempotent `ZMPOP` loses an op under the same fault and leaves it stranded (indexed, unreachable, resubmission rejected as "Already known"), whereas the new pop leaves consistent state and the op can be resubmitted. Do **not** set `autoResendUnfulfilledCommands: false` as a mitigation: in ioredis 5.4.1 the in-flight promise is then never settled, `process()` awaits forever and the pod stops bundling. See §8.5.

### 3.5 Round trips: exact scope

| Step | Today | After |
|---|---|---|
| Idle tick (empty queue) | 1 | 1 |
| First peek | 2 | 2 |
| Initial outer-loop nonempty peek | 2 | 0 |
| Per op | 6 | 1 |
| End of pass | 2 | 1 |
| **Clean drain total** | **6n + 6** | **n + 3** |

Here `n` is successful pop attempts, not necessarily accepted userOperations. This table assumes no competing consumer, concurrent arrival, stale entry, skip/requeue, error, budget/prior-slot/repeat exit, or cache miss. Each popped operation is accepted, possibly after one carry across a cap. Carry short-circuits both loop peeks, so adding a bundle does not add two round trips in this case. For T1, `n=7`, `b=3`: 11 nonempty/empty peek calls collectively cost 20 trips, and 7 pops cost 28: **48→10**, not 52→10.

For other paths, count calls rather than applying this formula: old nonempty peek=2, empty peek=1, successful pop=4, empty pop=1; a stale-slot old pop may cost 2. New successful/empty pop=1 in steady state, plus cache recovery if needed. `addOutstanding` requeues, processing writes, validation RPCs, entity reads, and executor work are not included. There is no unconditional per-pass latency formula.

## 4. Expected impact

The prediction uses the §2.4 model: pass ≈ (n + 3) × round-trip cost, plus packing CPU (taken from the in-memory relays).

| Metric | Today | Expected |
|---|---|---|
| Base prod, 1-op pass p50 | 9.2ms | ~4ms |
| Base prod, 9+-op pass p50 | 77.7ms | ~20ms |
| Ostium, 1-op pass p50 (quiet) | 13.1ms | ~5ms |
| Ostium, 9+-op pass p50 (burst) | 181ms | ~40ms |
| Ostium, queue wait p95 (burst) | 208ms | ~100ms (50ms interval + ~50ms pass) |

- **Win rate:** the §2.1 counterfactual is about 7.4 points; no guaranteed improvement or upper bound has been demonstrated.
- **Quiet hours:** queue wait there is already close to the 50ms interval, so don't expect a quiet-hour win-rate change.
- **Network protocol overhead:** decreases from a typical 9 client commands (peek plus nondeployment pop) to one script request. The script still executes Redis commands and JSON decoding on the server, including an extra factory `HGET`; Redis CPU/load reduction is not established.

## 5. Tests

### 5.1 Script tests against a real Redis (new)

**File:** `src/store/createRedisOutstandingStore.script.test.ts`.

**Why a real Redis:** ioredis-mock can run Lua (through fengari) but has no `cjson`. So these tests run against a real Redis at `REDIS_URL` and are skipped when it isn't set (`describe.skipIf(!process.env.REDIS_URL)`). Existing tests keep using the mock.

**Isolation and lifecycle (mandatory):**

- Do not add `vi.mock("ioredis")` to this file or modify the existing mock tests. Construct clients inside hooks in the enabled suite, never at module scope; an absent `REDIS_URL` must open no connection.
- Use `redisKeyPrefix: "pop-script-test-" + randomUUID()` with `chainId: 1` for each test. Use `getRedisStorePrefix(config)` to derive actual keys. The address/nonce suffix remains exactly as in `getPendingOpsKey()`; use `toHex(nonceKey)`.
- Keep a separate inspection client. Await `PING` on both clients before instrumentation. Do not count authentication, ready checks, seed writes, cleanup, or inspection commands as pop requests.
- The test may access the private client only via `store as unknown as { redis: Redis }`. Do not expose a new production accessor or export the script for tests. Call the public `store.pop()` in all implementation assertions.
- In `afterEach`, `SCAN MATCH <unique-prefix>:*` and delete only this test's keys, then disconnect all clients in `finally`. Never `FLUSHALL` or `FLUSHDB`. Since the cache test uses `SCRIPT FLUSH`, `REDIS_URL` must name a disposable test server, never a shared/prod server. Run this file's tests sequentially.

Use the existing `makeUserOpInfo` shape in `createRedisOutstandingStore.test.ts`, copied into the new file with fixed `addedToMempool: 1000` and arguments for `sender`, `nonce`, `maxFeePerGas`, and `initCode`. Hashes must be distinct, 32-byte padded hex. For 0.7/0.8 fixtures, use the same common fields, replace `initCode`/`paymasterAndData` with `factory`, `factoryData`, `paymaster`, `paymasterData`, `paymasterVerificationGasLimit`, and `paymasterPostOpGasLimit` (all `null` for nondeployment). Use entry points `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`, `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, and `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` respectively.

**CI:** add a Redis service to the job that runs `pnpm run test:unit` (`.github/workflows/lint.yaml`):

```yaml
    services:
      redis:
        image: redis:7.2-alpine
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
```

Add the following `env` to the existing `Run unit tests` step (not a second unit-test command). Do not change other steps:

```yaml
      - name: Run unit tests
        run: pnpm run test:unit
        env:
          REDIS_URL: redis://127.0.0.1:6379
```

**Cases:**

| Test | Exact setup and required assertions |
|---|---|
| Empty queue | On a fresh prefix, `pop()` returns `undefined`; snapshot before/after is `{}`. This still sends one script request |
| Priority, nonce, rerank | A0 fee=30, A1 fee=1, B0 fee=20, C0 fee=10; A0/A1 share sender+nonce key, sequences 0/1. Pop hashes must be A0, B0, C0, A1, then undefined. After A0, ready[A]=1 and hash[A0] is absent. After A1, A slot is absent. Run for all three versions |
| Ties | Give two slots identical ready scores; expect lexicographically greatest full slot key first. For two raw members with equal nonce score, expect lexicographically smallest member first. Do not substitute numerical nonce sorting |
| Byte preservation | Add an unknown top-level field to a stored member by raw `ZREM`/`ZADD`, preserving its score. Pop returns the schema-parsed operation, the exact raw member disappears, and the hash index is cleared. Do not serialize the parsed return to determine the removal target |
| Stale entries | Insert two missing slot keys with scores above one live slot. One pop returns the live hash and removes both stale ready members. A queue containing only stale members returns undefined and has no ready key afterward |
| Known first-peek limitation | Insert a missing slot below a live slot. `peek()` still returns undefined; direct `pop()` returns the live operation. This pins the remaining limitation rather than silently widening scope to fix `peek()` |
| Fee precision | For each fee below, add head A0 and successor A1 in one slot, pop A0, then assert `Number(await redis.zscore(readyKey, slotKey)) === Number(fee)`. Compare numeric doubles, not decimal string formatting |
| Factory matching | For deployment A0 whose sender index equals A0 hash, pop deletes the sender field; absent lookup is harmless. For index pointing at deployment A1, popping A0 retains A1's hash, then popping A1 removes it. Test v0.6 `initCode` and v0.7/0.8 `factory` forms |
| One request | Warm a connected client's command once, seed outside the measurement, spy on `sendCommand`, call public `pop()` exactly once, assert one invocation. Repeat for an empty queue. Use the audit's socket trace if testing actual wire command names; `sendCommand` sees ioredis commands before its lazy EVAL rewrite |
| Cache loss | Warm command, seed one op, `SCRIPT FLUSH` on the inspection client, reset spy, then pop. Expect the seeded op exactly once, two `sendCommand` calls, and next pop undefined. This is a recovery exception to the steady-state count |
| Two consumers | Two queue instances with the same prefix/entry point, 40 sequential operations in one slot, concurrent drain loops. Combined returned hashes equal all 40 seeded hashes exactly once; all queue/index keys are gone |
| JSON failure | Replace one stored member with invalid JSON while retaining ready/index. `pop()` rejects; ready entry is gone but slot member and hash index remain |
| Zod failure after mutation | Replace only `addedToMempool` with `"bad"` in otherwise valid stored JSON. `pop()` rejects; current member and hash index are already gone. Keep wrapper logging unchanged |
| Invalid successor | Valid A0 followed by invalid JSON at nonce score 1. Pop rejects; A0 member/index removed, invalid successor retained, ready entry absent. This documents the unsupported corrupt-data boundary |

Required fee corpus:

```ts
const fees = [
    0n, 1n,
    (1n << 53n) - 1n, 1n << 53n, (1n << 53n) + 1n,
    0xfffffffffffff7bn,
    (1n << 64n) - 1n, 1n << 64n, (1n << 64n) + 1n,
    0x20000000000000001n,
    1n << 80n,
    (1n << 128n) - 1n,
    (1n << 256n) - 1n
]
```

**Deterministic state-equivalence regression:** reuse the generator and `state()` normalizer in the companion audit, with a frozen reference pop implementing baseline `ba8d4cf` (not a call to the new implementation). `referencePop` must use `ZMPOP`, fetch first two raw members, parse current through `userOpInfoSchema`, execute `MULTI` factory cleanup if deployment + raw `ZREM` + hash `HDEL`, then rerank from the parsed successor or `DEL` the slot. Copying the old class body without its private helpers will not compile; use the test's Redis client and explicit key paths.

- Seeds 1..40. PRNG state updates with `(Math.imul(state, 1664525) + 1013904223) >>> 0`.
- For each seed: 12 slots = 6 senders × 2 nonce keys, zero initial sequences, 60 actions. A PRNG value modulo 3 equal to 0 means pop; otherwise add using another PRNG value modulo 12 as slot, then another value shifted left 40 bits as fee. Nonce is `(BigInt(slot % 2) << 64n) + BigInt(sequence[slot]++)`; hashes are `seed * 100 + actionIndex + 1` padded to 32 bytes. Drain to the first undefined afterward.
- Apply each action to reference and candidate prefixes, comparing complete returned parsed records and state after every action. Normalize only each run's prefix in keys and hash values. Sort hash entries/key names; preserve raw sorted-set members and scores in rank order. Do not normalize away unknown JSON fields, scores, factory fields, or missing keys.
- This exact generator produced **3,296 actions/state comparisons and 1,689 pop attempts** in the fresh audit. Factory differences and malformed/stale cases are tested separately because equivalence is not expected there. Do not reuse the original spec's unprovided 3,068-step generator/count.

### 5.2 Pass-loop tests (existing harness, in-memory store)

**File:** `src/mempool/mempool.test.ts`. The pass now learns the queue is empty from one extra pop instead of a peek. That changes exactly four assertions:

| Test | Today | After |
|---|---|---|
| T1, drains the backlog across gas caps: `popOutstanding` calls | 7 | 8 |
| T2, drains the backlog across byte caps: `popOutstanding` calls | 4 | 5 |
| T4, holds the carry without re-reading the emptied store: `popOutstanding` calls | 4 | 5 |
| onBundle, "hands a bundle over before the pass packs the next": `pops` | `[4, 7, 7]` | `[4, 7, 8]` |

Notes on those four:

- **T4:** the extra pop comes after the carried op is accepted. T4's other check, that nothing reads the store while the op is carried, still holds.
- **onBundle:** bundle 3 takes op 7 from the carry, then one pop finds the queue empty. Update the comment ("pops nothing") to match.

Passes that end on `breakLoop` or `maxBundleCount` keep their counts: T5, T9, the nonce-chain tests and the budget tests.

**New tests:**

- **"reads the store with one peek per pass":** seed T1's seven ops and expect exactly 1 `peekOutstanding` call. Today it's 11.
- **"an empty pop ends the pass":** a store whose `peekOutstanding` reports an op while `popOutstanding` returns `undefined` (another pod got there first). The pass returns `[]` after one pop and doesn't loop.

Append these tests in the same file, reusing its existing helpers. The rejected second peek makes the regression fail promptly instead of creating an infinite microtask loop on the old code. Do not use wall-clock sleeps/timeouts to prove termination.

```ts
describe("Redis round-trip pass contract", () => {
    it("uses one peek across all bundles", async () => {
        const { mempool, storeSpies } = await harnessSeededWith(sevenGasOps())
        vi.clearAllMocks()

        expect(bundleIds(await mempool.getBundles())).toEqual([
            [1, 2, 3], [4, 5, 6], [7]
        ])
        expect(storeSpies.peekOutstanding).toHaveBeenCalledTimes(1)
        expect(storeSpies.popOutstanding).toHaveBeenCalledTimes(8)
    })

    it("stops after an empty pop and retries on the next pass", async () => {
        const { mempool, storeSpies } = await harnessSeededWith([
            makeUserOpInfoV06(1)
        ])
        storeSpies.popOutstanding.mockResolvedValueOnce(undefined)
        storeSpies.peekOutstanding
            .mockResolvedValueOnce(makeUserOpInfoV06(1))
            .mockRejectedValue(new Error("unexpected second peek"))

        expect(await mempool.getBundles()).toEqual([])
        expect(storeSpies.popOutstanding).toHaveBeenCalledTimes(1)
        expect(storeSpies.peekOutstanding).toHaveBeenCalledTimes(1)

        storeSpies.peekOutstanding.mockRestore()
        expect(bundleIds(await mempool.getBundles())).toEqual([[1]])
    })

    it("hands over a partial bundle after an empty pop", async () => {
        const { mempool, storeSpies } = await harnessSeededWith([
            makeUserOpInfoV06(1), makeUserOpInfoV06(2)
        ])
        storeSpies.popOutstanding
            .mockResolvedValueOnce(makeUserOpInfoV06(1))
            .mockResolvedValueOnce(undefined)
        const onBundle = vi.fn()

        expect(bundleIds(await mempool.getBundles(undefined, onBundle)))
            .toEqual([[1]])
        expect(onBundle).toHaveBeenCalledTimes(1)
        expect(storeSpies.popOutstanding).toHaveBeenCalledTimes(2)
    })
})
```

Existing T15a must still make zero pops on an empty initial peek. Preserve all other assertions, including carry ownership during throws, prior-slot nonce guards, bundle budgets, versions, `onBundle` ordering, and exactly-once cleanup.

### 5.3 Ordered implementation and completion gates

1. **Record baseline:** run the focused unit tests below; inspect the current source against the baseline anchors. The historical audit harness intentionally refuses a changed store, so run it before implementation if reproducing §0.
2. **Write real-Redis regressions first:** ordinary successful-pop command count must fail on old code (multiple requests), and high-fee score must fail with the original Lua snippet. Tests skipped for missing `REDIS_URL` do not count as validation. Add the pass tests before changing `process()`; the one-peek check fails on baseline (11 versus 1).
3. **Implement §3.1 exactly:** add corrected Lua/typing/registration and replace pop. Remove only `RedisSortedSet.popMax()` and `RedisSortedSet.delete()`; retain `popMin()` and `RedisHash.delete()`. Run real-Redis tests.
4. **Implement §3.2 exactly:** change both conditions, add the flag, set it on undefined pop. Update only the four specified existing assertions/comment. Run the entire mempool test file.
5. **Wire CI:** add the §5.1 service and unit-step environment. Verify the Redis script test executes rather than skips on Redis 7.2. Do not substitute ioredis-mock.
6. **Run final gates from repository root:**

```sh
# Baseline / focused loop and existing mock coverage:
pnpm --dir src test:unit mempool/mempool.test.ts store/createRedisOutstandingStore.test.ts

# REDIS_URL must point to a disposable server provided by the implementer/CI.
REDIS_URL=redis://127.0.0.1:6379 pnpm --dir src test:unit store/createRedisOutstandingStore.script.test.ts
REDIS_URL=redis://127.0.0.1:6379 pnpm --dir src test:unit
pnpm --dir src exec tsc --noEmit --incremental false
pnpm exec biome check src/store/createRedisOutstandingStore.ts src/store/createRedisOutstandingStore.script.test.ts src/mempool/mempool.ts src/mempool/mempool.test.ts
git diff --check
```

7. **Review and stage:** verify `process()` has exactly one `peekOutstanding(entryPoint)` call, inspect the five-file implementation diff, then `git add` those five paths. No commit/push. Do not add the audit's temporary source copies or logs to production source.

**Audit results already obtained, not substitutes for future implementation gates:** baseline focused suite **83/83**; corrected prototype against original assertions **79 pass / 4 expected failures**; after exactly those assertion updates plus the three tests above, full prototype suite **280/280**. All three new tests also fail against the original loop: 11 peeks instead of 1, an unexpected second peek after the initial snapshot, and 3 pops instead of 2 on the partial-bundle case. Baseline and prototype `tsc --noEmit --incremental false` both exit 0. Prototype ran in `/private/tmp/ur-pop-spec-audit-yzhfwwgf`; local real-Redis assertions are in the companion evidence file. Redis 7.2 CI execution, full §5.1 coverage, actual production wall-time gains, and rollout were not performed during this spec audit.

## 6. Rollout

**Pre-checks (read-only).** Run these against each relay's Redis: Ostium's Render service, the EKS values in `deployments/ultra-relay-arbitrum-ostium.values.yaml`, and Base prod.

1. **Topology and permissions:** verify Redis ≥7, standalone topology, and support for reading a slot key obtained from the ready set. `redis-cli -u "$REDIS_ENDPOINT" EVAL "return 1" 0` returning `1` is only a basic scripting probe, not complete ACL/topology validation. Confirm `EVAL`/`EVALSHA` and all inner commands (`ZPOPMAX`, `ZRANGE`, `ZREM`, `HGET`, `HDEL`, `ZADD`, `DEL`) are permitted on the queue's keys. Run the corrected script test against an isolated instance with the deployment's Redis version and policy; never use production for `SCRIPT FLUSH` or test seeds.
2. **Existing stale entries.** A successful script on valid keys removes the two pop-owned windows in §2.7. Stale entries may still exist or be created by unchanged writers/old pods. A stale *lowest*-rank entry still makes the initial `peek()` return nothing and prevents the new pop from running. Count these for each entry point (this scans the whole ready set in one server-blocking script; schedule accordingly):

   ```
   redis-cli -u "$REDIS_ENDPOINT" EVAL "local n=0 for _,k in ipairs(redis.call('ZRANGE',KEYS[1],0,-1)) do if redis.call('EXISTS',k)==0 then n=n+1 end end return n" 1 "<prefix>:outstanding:pending-queue:<entryPoint>"
   ```

   The prefix is `ostium:42161` in the checked-in Ostium configuration (`redis-key-prefix: ostium`). When unset or `alto`, it is just the chain id (`getRedisStorePrefix`). If non-zero, stop rollout and have an operator inspect/recheck each candidate before repair. A snapshot alone does not justify deleting a ready entry that a concurrent writer may have made live.

**Order:**

1. Ostium first. It has a single tenant, so the on-chain win-rate method gives a clean before and after.
2. Hold for one weekday burst (19:57 UTC; 20:57 UTC from Nov 1).
3. Then Base prod.

**Rolling deploy:** formats are compatible, so no migration is needed. This is not proof of race-free mixed execution: old pops and all existing add/remove sequences remain non-atomic. Full writer concurrency safety is not a claim of this patch.

**Rollback:** redeploy the previous build. No data migration is needed; rollback does not repair pre-existing or newly observed orphaned data.

## 7. Verification after deploy

These are proposed observation targets, not pre-deployment proof or merge gates. Retain raw exports and query parameters. Compare the same relay, version, pass-size distribution, pod count, traffic window, and arrival load; collect several bursts. Track Redis CPU/script duration and event-loop lateness alongside network-sensitive timings.

1. **Pass time by op count.** Rerun the §2.3 query (Appendix B).

   | Relay, pass size | Today p50 | Expected p50 |
   |---|---|---|
   | Ostium, 1 op | 13.1ms | ≤ 6ms |
   | Base prod, 1 op | 9.2ms | ≤ 5ms |
   | Base prod, 5–8 ops | 31.6ms | ≤ 15ms |

2. **Burst, Ostium weekday 19:56–20:00 UTC:**
   - `outstandingMs` p95: 208ms today, expected ≤ ~110ms.
   - `bundling.getBundles` p95: 256–275ms today, expected ≤ ~80ms.
3. **Errors/correctness:** no new unhandled `Failed to pop from outstanding mempool` or script errors; no increase in orphaned/stale keys, missing hashes, or duplicate accepted operations. A handled `NOSCRIPT` followed by successful fallback is expected after cache loss, not itself a correctness failure.
4. **Win rate:** reproduce on-chain pairing with raw receipts/calldata and compare against the reported 53.9% only after validating that baseline. The original analysis claims ±6–7 points of nightly noise; that estimate was not independently verified.

## 8. Out of scope and follow-ups

1. **Atomic `add()` and `remove()`.**
   - *What it fixes:* both read, then write in separate round trips. The original timing sweep reported one remaining add race; the fresh audit reproduces it deterministically. This is not an exhaustive inventory of races. `remove()` can also restore readiness based on a stale read.
   - *Latency gain:* making `add()` one script also cuts it from 2 round trips to 1. That's on the ingress path, which is part of UR validation time (burst p95 ~275ms).
   - *How:* the same technique. The "lowest nonce" check can compare set scores (the nonce sequence), so no JSON parsing is needed.
2. **Batch pop (k ops per round trip).**
   - *Gain:* it would take a 12-op pass from 15 round trips to about 4, saving roughly another 30ms in the burst.
   - *Why not now:* ops held in a local buffer are invisible to the other pod. The skip, nonce-slot and cap paths would also have to hand buffered ops of the same slot back, to keep nonce order.
   - *When:* revisit only if §7 shows passes still matter.
3. **`peek()` reads the lowest-fee entry** although its comment says highest, and a stale lowest entry blocks every pass. Unchanged writers/old pods can still create one. Fix `peek()` separately, or derive the version from the first pop in a separately reviewed change. **Recommended before the Ostium and Base rollout** (implementation review, 2026-09-28): a stale lowest entry stops the pass before the new pop can skip it, so it can erase the latency gain this change targets. `remove()` of a non-head op racing a pop of the head in the same slot is one way to create one; ties on fee-homogeneous chains make "lowest" likely.
4. **A third Ostium pod.** Reassess with §7 data. After this change, each puller costs 1 round trip per op.
5. **Idempotent pop (exactly-once under reply loss).** Closes §3.4 item 5. Pass a per-call token as `ARGV[1]` (ioredis resends the same command object, so the resend carries the same token); after a successful pop the script stores the member under a short-TTL result key for that token, and returns the stored member if the key already exists. Zero extra round trips. Needs a spec amendment because it adds a Redis key.
6. **Fail-fast script probe and pop-failure metric.** `createMempoolStore.popOutstanding` turns every error into `undefined`, which the pass now reads as "queue empty". On a Redis that refuses scripts (ACL without `@scripting`, managed tiers that disable `EVAL`, Cluster or key-routing proxies that reject the undeclared slot key) every pop fails, ingress keeps accepting ops, and nothing is bundled on that entry point; only an error log shows it. Until this lands, treat §6 pre-check 1 as a **hard rollout gate**. Then add a startup probe (for example `SCRIPT LOAD` plus one run against a throwaway prefix) and a counter on pop failures that can page.
7. **Test hygiene and public identifiers.** The real-Redis suite is enabled by the generic `REDIS_URL` and runs a server-wide `SCRIPT FLUSH`; rename the switch to something deliberate (for example `ALTO_TEST_REDIS_URL`, updating `.github/workflows/lint.yaml`) so a developer shell pointing `REDIS_URL` at a shared server cannot trigger it. The repository is public: consider removing production service ids, key prefixes and log-table names from checked-in specs.

## Appendix A: reproduce the fresh evidence

Run from repository root **before changing the store source**. The harness pins that file to `ba8d4cf` and refuses a modified version; it exercises the current baseline implementation plus the corrected §3.1 Lua and a reconstructed original conversion. It writes only its UUID-prefixed test keys, deletes those keys afterward, and closes all clients. It also flushes the disposable server's script cache to test recovery.

Requires installed project dependencies, Redis server/CLI, and Node (recorded run used 22.21.1). This shell starts a private Unix-socket Redis, bounds startup waiting, records evidence, and shuts down only that server:

```sh
audit_dir="$(mktemp -d /tmp/ur-pop-audit.XXXXXX)"
redis-server --port 0 --unixsocket "$audit_dir/redis.sock" \
  --save '' --appendonly no --dir "$audit_dir" \
  --daemonize yes --pidfile "$audit_dir/redis.pid"
trap 'redis-cli -s "$audit_dir/redis.sock" SHUTDOWN NOSAVE >/dev/null 2>&1 || true' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  redis-cli -s "$audit_dir/redis.sock" PING >/dev/null 2>&1 && break
  sleep 0.1
done
redis-cli -s "$audit_dir/redis.sock" PING >/dev/null || exit 1
AUDIT_REDIS_SOCKET="$audit_dir/redis.sock" AUDIT_OUTPUT_DIR="$audit_dir" \
  pnpm exec node docs/specs/2026-09-28-redis-pop-round-trips.audit.cjs
printf 'Evidence: %s/evidence.json\n' "$audit_dir"
```

Expected exit 0 with `completed: true`, counts 12→4 / 30→7 / 78→15, and the §0 fee/race/state-equivalence results. This is a historical audit runner, not the eventual production-code regression suite; implement §5.1 to test the final class directly.

The runner intercepts actual socket `write()` calls after connection readiness and parses their RESP command names. Its sequential replay has no other in-flight requests; each measured write therefore corresponds to one dependent request/response batch. This does not establish wall-clock RTT under load.

The race tests use exact boundaries, not timers: intercept old pop's `multi.exec()`, run a same-slot add through a second client immediately before or after that EXEC, then resume. For the remaining writer race, intercept add's EXEC, atomically pop the old head, then let add write its successor. Complete state checks distinguish missing data, stale readiness, and an indexed but unreachable successor.

### Original proxy methodology (retained for provenance only)

- **Setup:** `redis-server` 8.6.1 on localhost, plus a small TCP proxy. The proxy delivers each client-to-server chunk a fixed 5ms (or 10ms) after it arrives, keeping order.
- **Code under test:** the original analysis reported a tsx script importing `createRedisOutstandingQueue` and the original proposed Lua. That harness is not supplied; its claim of broad fee equivalence was disproved above.
- **Counting round trips:** wrap the client's `sendCommand`. Commands issued in the same synchronous tick count as one round trip; that's how a MULTI goes out.
- **Pass sequences:** they replay the store calls `process()` makes for one bundle with no cap hit.
  - *Today:* `peek; while (peek) { while (peek) pop }`.
  - *Proposed:* `peek; while (pop) {}`.
- **Race sweep (§2.7):**
  1. Seed slot S with nonce 0.
  2. Start a pop through the 10ms proxy.
  3. After *t* ms, add nonce 1 for S over a direct connection, then add an op with a higher fee in another slot.
  4. Classify: was the nonce-1 op popped later (kept); did `peek()` return nothing (stale entry); otherwise lost.

## Appendix B: production queries

Pass time by op count (§2.3, §7):

```sql
SELECT grp, multiIf(ops = 0, '0', ops = 1, '1', ops = 2, '2', ops <= 4, '3-4', ops <= 8, '5-8', '9+') ob,
       count() passes, round(quantile(0.5)(ms), 1) p50_ms, round(quantile(0.95)(ms), 1) p95_ms,
       round(sum(ms) / greatest(sum(ops), 1), 1) ms_per_op
FROM (SELECT multiIf(raw LIKE '%srv-d9obrkvlk1mc73897rvg%' AND toHour(dt) = 19 AND toMinute(dt) BETWEEN 56 AND 59 AND toDayOfWeek(dt) <= 5, 'ostium weekday burst',
                     raw LIKE '%srv-d9obrkvlk1mc73897rvg%', 'ostium rest',
                     raw LIKE '%srv-cu81pel6l47c739toh50%', 'base prod (redis)', 'memory-queue relays') grp,
             JSONExtract(raw,'userOpCount','Int64') ops, JSONExtract(raw,'ms','Float64') ms
      FROM s3Cluster(primary, t187081_ultra_relay_base_prod_s3)
      WHERE _row_type=1 AND dt >= '<from>' AND dt < '<to>' AND raw LIKE '%[timing] bundling.getBundles%')
GROUP BY grp, ob ORDER BY grp, ob
```

Which relays use the Redis queue (§2.3):

```sql
SELECT substring(JSONExtractString(raw,'hostname'),1,24) svc,
       countIf(raw LIKE '%Using redis for outstanding%') redis_starts,
       countIf(raw LIKE '%Using memory for outstanding%') memory_starts
FROM s3Cluster(primary, t187081_ultra_relay_base_prod_s3)
WHERE _row_type=1 AND dt >= '<from>' AND dt < '<to>'
  AND (raw LIKE '%Using redis for outstanding%' OR raw LIKE '%Using memory for outstanding%')
GROUP BY svc ORDER BY svc
```

Queue wait against the race outcome (§2.1): pull `userOpHash` and `outstandingMs` from the `included in tx` lines for the burst window. Then join on `topics[1]` of the EntryPoint `UserOperationEvent` in our transactions, and classify each order against Pimlico's op for the same order id.
