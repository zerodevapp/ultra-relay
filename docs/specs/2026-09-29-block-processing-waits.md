# Stop block processing from waiting on work mined bundles don't need

- **Status:** source-validated optimization; corrected implementation contract below. Production latency estimates are unverified. No production implementation is part of this audit.
- **Date:** 2026-09-29
- **Audited code:** `e2c872badac3d682f60e2415b8716ae82d40e84e` (local HEAD). The executor, bundle, gas-price, monitoring, and receipt-status files match `401becd7fe57ab6d09ce982faab3c39521d40e26`. Deployment identity was not independently checked.
- **Affects:** the common block-processing path. Serial I/O savings apply when statuses use Redis (`enableHorizontalScaling && redisEndpoint`) and/or receipts use Redis (`enableRedisReceiptCache && redisEndpoint`). In-memory receipts/statuses have no network round trip. The original analysis names Ostium and Base prod; their runtime configuration was not queried.

## 0. Audit verdict and implementation boundary

The two dependency changes are justified: included/reverted processing does not consume the shared fee result, and included userOperations currently run sequentially. Implement §§4–6, including the corrected outer error barrier. Do not treat the original latency model as a measured outcome.

| Original claim | Verdict and source |
|---|---|
| Every nonempty run waits for receipts and both fee values before handling bundles | **Validated:** `ExecutorManager.handleBlockInner` has a three-way `Promise.all` |
| Included userOperations wait for earlier status writes | **Validated:** `BundleManager.processIncludedBundle` awaits cache and `processIncludedUserOp` inside a `for...of`; `Monitor` issues one Redis `SET ... EX` when Redis status storage is enabled |
| Start handling each mined bundle as soon as its own receipt arrives | **Too strong:** `BundleManager.getBundleStatuses` still waits for every bundle, and each `getBundleStatus` waits for current and previous hashes. This change removes only the fee barrier |
| Fee estimation is uncached because refresh interval is zero | **Wrong reason:** `tryGetNetworkGasPrice` calls `innerGetGasPrice` directly regardless of refresh interval. `getBaseFee` does use that interval |
| Fee estimation always makes two Alchemy calls | **Conditional:** installed viem 2.27.0's ordinary EIP-1559 path fetches a block then a priority fee. Chain overrides, legacy mode, Polygon handling, fallbacks and transport retries differ; provider identity is deployment-specific |
| Reverted bundles always fetch their own base fee | **False:** they use `0n` in legacy mode, otherwise `block?.baseFeePerGas`, and only fetch when absent |
| Reverted bundles have the same serial per-op loop | **False:** rejected ops use an unawaited async `map`; recovery/simulation is awaited. Leave that separate error-handling issue untouched |
| Receipt cache is always in memory; only Redis status users benefit | **False:** `createReceiptCache` also supports Redis independently of horizontal scaling |
| Awaiting receipt caching proves persistence before status processing | **False for Redis:** `createRedisReceiptCache.set` catches serialization, write and timeout errors and fulfills. The contract preserves the cache attempt before status processing, not successful persistence |
| Each op costs 11–21ms because of event-loop delay | **Unproven attribution:** a fitted association is not a component latency measurement; the referenced Redis spec itself labels its 2.6ms figure an estimate |
| Parallel processing costs exactly one wait/round trip | **False literally:** it overlaps independent waits; command count remains N, Redis still executes commands, and cache/log/metric/reputation CPU work remains |
| RPC count is unchanged | **False, even per run:** one shared gas-method call and one shared base-fee-method call remain, but reverted fallback can race the shared cache fill and issue another block RPC. Faster runs can also admit more ticks |
| `opsClosed = 0` means nothing was pending | **False:** a run may contain only `not_found` bundles. Existing transaction-to-block joins cannot distinguish these cases |
| `submittedMs` measures receipt detection/status completion | **False:** `computeInclusionTimings` uses run-start `blockReceivedTimestamp - submittedAt`; the current run's receipt/fee/status waits are excluded |
| Moving fee waits leaves all error/guard behavior unchanged | **False:** with outer `Promise.all`, a failed mined branch can release the guard while a sibling still awaits fees. §4.1 drains all started branches before rethrowing |
| Source equality proves deployed build, production tables, benchmark, and 50–100ms target | **Not verified:** raw exports, pairing code, original proxy benchmark and deployment evidence were not supplied or accessible through available connectors |

**Allowed implementation files:**

| File | Required edit |
|---|---|
| `src/executor/executorManager.ts` | Shared fee promise, drain all bundle branches, local summary type, return counts, add `timed` summary |
| `src/executor/bundleManager.ts` | Replace only the included-bundle serial loop with per-op `allSettled` and deterministic rethrow |
| `src/executor/executorManager.test.ts` | Extend existing harness and add §6.1 cases |
| `src/executor/bundleManager.test.ts` | Add §6.2 cases using the real included-bundle path |
| `src/executor/executorManager.ts` (Amendment §9.1) | `sendBundleToExecutor`: track the bundle only after submitted bookkeeping settles |
| `src/mempool/mempool.ts` (Amendment §9.2) | `markUserOpsAsSubmitted`: drain every op before rethrowing |
| `src/executor/executorManager.test.ts`, `src/mempool/mempool.test.ts` | Add §9.3 cases |

No new dependencies, config flags, concurrency pool, batch Redis API, timeout, retry, receipt-fetch strategy, public API, Redis format, deployment edit or generic promise helper. Do not change `potentiallyResubmitBundle`, replacement/rotation/quarantine, `getBundleStatuses`, `processRevertedBundle`, `processIncludedUserOp`, `freeSubmittedBundle`, `Monitor`, or receipt-cache implementations. Keep existing watcher/watchdog/flashblocks triggers and `finally` guard reset. Never commit or push; stage only.

## 1. Intended behavior

1. Start one shared fee promise concurrently with the existing aggregate receipt lookup.
2. After **all status lookups** resolve, included and reverted branches start without waiting for shared fees. Only `not_found` branches await that promise.
3. Finish an included bundle only after every op's cache/status processing settles. Await the cache attempt before status processing and preserve cleanup-before-ops order; Redis cache persistence remains best effort.
4. Finish a block run only after every started bundle branch settles. Propagate a rejection after draining; keep fee-only background work caught.
5. Emit exact successful-run counts, including an all-zero empty run.

This removes serial dependencies. It does not establish a production millisecond target or win-rate effect. Earlier cleanup may affect later submissions indirectly; the already-mined transaction's ordering cannot change.

## 2. Current flow and preserved boundaries

- Normal `watchBlocks` triggers `handleBlock`; `emitMissed: false` and the guard mean some blocks are skipped. Client polling defaults to `blockTime / 4` (`src/cli/handler.ts`); 250ms follows from the 1000ms default, not a verified Ostium deployment value.
- The stale-block watchdog and flashblocks interval can invoke the same path without a block. Their callbacks catch rejections; the normal watcher's async callback does not.
- Empty runs stop the watcher and return before any receipt/fee call.
- Each nonempty run snapshots pending bundles, starts aggregate receipt lookup and both fee calls, then awaits all three. Bundle branches run concurrently after that barrier.
- `getBundleStatuses` preserves input index order. `getBundleStatus` looks up every current/previous transaction hash, suppresses individual receipt-RPC failures to `undefined`, then chooses success before revert. Receipt parsing can still throw.
- Included cleanup removes tracking synchronously, awaits wallet release, then awaits submitted-store removal. Only then do cache, inclusion log, status write, metrics, event invocation and reputation updates run, sequentially across ops today.
- Redis receipt caching has an existing 100ms timeout and catches errors, unlike Redis status writes. Cache `set` fulfillment does not prove persistence. Its timeout races the Redis promise without cancelling the command, so a write can remain in flight after the bundle handler returns (`src/receiptCache/createRedisReceiptCache.ts`, `src/utils/asyncTimeout.ts`).
- `processIncludedUserOp` logs **before** status write, so an inclusion log is not proof that status persistence succeeded. Events are invoked without awaiting delivery. Reputation increments are synchronous; ops can share sender/paymaster/factory state, so “independent” means no required ordering between their completed per-op actions, not disjoint state.
- Reverted handling uses the supplied block's base fee when available, awaits simulation/recovery, and launches rejected-op checks without waiting for them. Its returned promise does not mean every reverted op has reached terminal status.
- Without a supplied block fee, reverted handling calls `GasPriceManager.getBaseFee` independently. With refresh enabled and an empty queue, the baseline shared fee fetch can populate that queue before the handler starts. Removing the barrier permits both calls to observe the empty queue and fetch a block. The deterministic audit reproduces one baseline RPC versus two candidate RPCs with the real gas methods and memory queue; reverted simulation is stubbed out. A warm cache can instead be read earlier, before an in-flight update. Shared fee results are not direct handler inputs, but cache timing is observable.
- `potentiallyResubmitBundle` is synchronous and may launch replacement/rotation work in the background. The run awaits the decision, not transaction submission completion.

## 3. Original reported evidence — not independently reproduced

All production values and proxy-benchmark numbers in this section are retained for provenance, not certified measurements. Validation here used source and deterministic deferred-promise checks (§6.4), not production Redis/RPC or BetterStack access. Reproduction requires raw log exports, exact filters and quantile definitions, transaction receipts, deployment configuration, and the original benchmark program.

**Sources:**

- Production data: BetterStack UR source 1169629, Ostium (`srv-d9obrkvlk1mc73897rvg`, two pods).
- Bursts: Sep 25 19:56–20:00 UTC (pods `76d896d4d4-*`) and Sep 28 19:56–20:00 (pods `7c76cccfdf-*`).
- Quiet hours: Sep 28 21:00 → Sep 29 02:00.
- Mined blocks and op counts come from our transactions on-chain (EntryPoint v0.6 `UserOperationEvent`s).

### 3.1 Reported runs are longer in the sampled bursts

`[timing] handleBlock` (one line per run):

| Window | Pod | Runs | Total run time | p50 | max |
|---|---|---|---|---|---|
| Sep 28 burst | hzsgl | 28 | 2,775ms | 56ms | 557ms |
| Sep 28 burst | vqtxk | 27 | 3,303ms | 50ms | 495ms |
| Sep 25 burst | 2q8s7 | 40 | 2,952ms | 30ms | 440ms |
| Sep 25 burst | 7hgr5 | 31 | 2,199ms | 29ms | 456ms |
| Quiet, 5 hours | hzsgl | 62 | 2,057ms | 32ms | 153ms |
| Quiet, 5 hours | vqtxk | 53 | 1,224ms | 25ms | 120ms |

- **Concentration:** on Sep 28, all 55 burst runs fall inside 19:57:50–19:58:20. The supplied totals divide to **9.25% and 11.01% of elapsed wall time** during those 30 seconds. Awaited I/O is included; these are not CPU utilization measurements.
- **p95 by burst:** Sep 25 284ms; Sep 28 464ms (hzsgl 474, vqtxk 425); quiet 67–110ms.

### 3.2 Run time grows with the number of ops the run closes out

**Method:**

1. For each pod, list its runs by the `blockNumber` on the timing line.
2. Map each of our transactions to the pod that processed it, using the `included in tx` lines.
3. Map each transaction to its block and op count, from on-chain data.
4. Assign each transaction to the pod's first run whose block is at or after the transaction's block.

All 57 (Sep 25) and 53 (Sep 28) bundles were assigned.

| Ops closed by the run | Sep 25: runs, p50 | Sep 28: runs, p50 | Quiet: runs, p50 |
|---|---|---|---|
| no ops assigned by the join (pending state unknown) | 34, 0ms | 21, 0ms | 64, 0ms |
| 1 | 8, 40ms | 7, 113ms | 50, 41ms |
| 2–3 | 10, 65ms | 6, 68ms | 1, 34ms |
| 4–6 | 10, 154ms | 13, 158ms | — |
| 7+ | 9, 193ms | 8, **310ms** | — |

Least-squares fit over runs that closed at least one bundle:

| Burst | Fit | r | Runs |
|---|---|---|---|
| Sep 25 | ms = 44 + **16.7 × ops** | 0.55 | 37 |
| Sep 25 (with bundles as a second term) | ms = 27 + 28.3 × bundles + **10.8 × ops** | | |
| Sep 28 | ms = 79 + **20.0 × ops** | 0.42 | 34 |
| Sep 28 (with bundles as a second term) | ms = 82 − 3.6 × bundles + **20.6 × ops** | | |

The fitted coefficients associate an additional op with **11–21ms**, conditional on this assignment and model. They do not isolate status-write time. Bundles already run concurrently, so the longest per-bundle chain, receipt parsing, cache pruning, logging and other load can affect the fit. The known assignment of two bundles to a 0ms run shows the join is imperfect.

### 3.3 Event-loop delay is a plausible contributor, not an isolated cause

- The earlier `2026-09-28-redis-pop-round-trips` spec reports approximately 1ms quiet / 2.6ms burst estimates, and explicitly says 2.6ms is inferred rather than a measured Redis RTT. Subtracting this estimate from the regression coefficient cannot identify event-loop wait time.
- **Reported late timers coincide with these runs.** The bundling timer logs `bundling.tickLate` when it fires late. On Sep 28 it fired late **18 times in the peak 30 seconds, by 50–199ms**. **16 of those 18** fall inside a block-processing run of 150ms or more on the same pod, or within 50ms of its end.
- **Original local benchmark report, not rerun:** the real `Monitor` status store (`src/mempool/monitoring.ts`), against Redis 8.6.1 behind a proxy adding a 2ms round trip, median of 15. Background load was simulated with back-to-back synchronous chunks on the same event loop.

  | Event loop | 1 op | 4 ops, one at a time vs parallel | 9 ops, one at a time vs parallel |
  |---|---|---|---|
  | Idle | 3ms | 12 vs 3ms | 30 vs 3ms |
  | Busy, 5ms chunks | 5ms | 20 vs 5ms | 45 vs 5ms |
  | Busy, 20ms chunks | 20ms | 80 vs 20ms | **180 vs 20ms** |

  Sequential writes create dependent I/O waits. Concurrent writes can overlap those waits; replies and continuations need not complete in one event-loop turn or one round trip. The reported benchmark is consistent with this mechanism; its unavailable program/output cannot independently validate the table or production attribution.

### 3.4 Fee fetches can dominate the initial barrier

The baseline run waits for the slowest of three fetches (§2). The original analysis reports these durations for block-processing calls (`flow = "block"` on `upstream RPC` lines), next to Alchemy's own reported time:

| Window | Method | Calls | Ours p50 / p90 / p95 | Alchemy p95 |
|---|---|---|---|---|
| Quiet | `eth_getTransactionReceipt` | 67 | 16 / 29 / 48ms | 6ms |
| Quiet | `eth_getBlockByNumber` | 241 | 13 / 25 / 38ms | 5ms |
| Quiet | `eth_maxPriorityFeePerGas` | 62 | 15 / 30 / 40ms | 5ms |
| Sep 25 burst | `eth_getTransactionReceipt` | 69 | 19 / 64 / 96ms | 8ms |
| Sep 25 burst | `eth_getBlockByNumber` | 153 | 13 / 52 / 82ms | 5ms |
| Sep 25 burst | `eth_maxPriorityFeePerGas` | 40 | 23 / 122 / 132ms | 6ms |
| Sep 28 burst | `eth_getTransactionReceipt` | 67 | 19 / 65 / 77ms | 7ms |
| Sep 28 burst | `eth_getBlockByNumber` | 130 | 13 / 45 / 67ms | 4ms |
| Sep 28 burst | `eth_maxPriorityFeePerGas` | 35 | **38 / 178 / 232ms** | 5ms |

- **Every run with bundles in flight waits for it.** The reported counts are 35 calls vs 34 assigned nonempty runs on Sep 28, 40 vs 37 on Sep 25, and 62 vs 51 in quiet hours. These counts are unequal and do not establish one-to-one attribution; the join also does not identify all runs with pending bundles.
- **On the ordinary EIP-1559 path, the gas-price leg is `getBlock` followed by `eth_maxPriorityFeePerGas`.** The original analysis adds marginal quantiles as follows:

  | | Gas-price leg | Receipt | Difference |
  |---|---|---|---|
  | Quiet, p50 | ~28ms (13 + 15) | 16ms | ~12ms |
  | Sep 28 burst, p50 | ~51ms (13 + 38) | 19ms | ~32ms |
  | Sep 28 burst, p90 | ~223ms (45 + 178) | 65ms | ~158ms |

  Sums or differences of marginal quantiles are not quantiles of sums or differences. These arithmetic illustrations cannot establish median/p90 savings or identify the slowest leg of a particular run. A per-run trace is required.
- **Nothing a mined bundle does needs these values.** The gas price and base fee go only to `potentiallyResubmitBundle` (`executorManager.ts:802–808`). Reverted bundles resolve base fee independently: legacy zero, supplied block fee, then manager fallback (`processRevertedBundle`).

### 3.5 What these waits cost today

For every mined bundle:

- **Wallet release waits for fees.** Cleanup starts after the three-way barrier. Removing it advances cleanup only when fee work finishes later than aggregate receipt work; no fee-barrier saving exists when receipts are already the slowest leg. The amount is not measured by the marginal-quantile subtraction above.
- **Later ops' statuses are recorded late.** The serial dependency is real. Applying the 11–21ms regression coefficient to `(k - 1)` gives an unverified illustration (~90–170ms for nine ops), not observed per-op completion times.
- **The next run is held up.** The next block's run can't start until this one ends. That delays noticing bundles mined meanwhile: the gap from stored `submittedAt` to the next processing run's start (`submittedMs`) is p95 **354ms** in the Sep 28 burst vs **281ms** in quiet hours (p50 259 vs 261).

Reported wallet wait p95 was 13ms in the Sep 28 burst, max 56ms. This sample alone does not rule out wallet pressure. Earlier release can provide headroom for subsequent submissions; its effect on win rate is unmeasured.

### 3.6 What the evidence does not show

- **Block processing is not proven to be what congests the event loop.** Elapsed time includes I/O waits. The reported runs coincide with delayed timers (§3.3), but the CPU-heavy work at the peak hasn't been identified. That needs an event-loop delay monitor and a CPU profile (§8).
- **No direct effect on an already-mined transaction.** Resource release and shorter guarded runs can affect later work; no win-rate conclusion follows without measurement.

## 4. Exact implementation contract

Apply these edits in the existing classes; do not extract new modules. Code blocks marked `audit:` are executable candidates consumed by the companion audit. Existing imports suffice. `BlockRunSummary` is a local, unexported type near the other top-level declarations.

### 4.1 Remove the fee barrier and retain ownership of started branches

Add this type to `src/executor/executorManager.ts`:

<!-- audit:summary -->
```ts
type BlockRunSummary = {
    pending: number
    mined: number
    reverted: number
    notMined: number
    opsClosed: number
}
```

Replace `handleBlockInner` with:

<!-- audit:inner -->
```ts
    private async handleBlockInner(block?: Block): Promise<BlockRunSummary> {
        const blockReceivedTimestamp = Date.now()
        this.lastReconcileAt = blockReceivedTimestamp

        const pendingBundles = this.bundleManager.getPendingBundles()

        const summary: BlockRunSummary = {
            pending: pendingBundles.length,
            mined: 0,
            reverted: 0,
            notMined: 0,
            opsClosed: 0
        }

        if (pendingBundles.length === 0) {
            this.stopWatchingBlocks()
            return summary
        }

        // Start fees once, but only unresolved bundles depend on them.
        const networkFees = Promise.all([
            this.gasPriceManager.tryGetNetworkGasPrice().catch(() => ({
                maxFeePerGas: 0n,
                maxPriorityFeePerGas: 0n
            })),
            this.getBaseFee().catch(() => 0n)
        ])
        const bundleStatuses =
            await this.bundleManager.getBundleStatuses(pendingBundles)

        const results = await Promise.allSettled(
            bundleStatuses.map(async (bundleStatus, index) => {
                const submittedBundle = pendingBundles[index]

                if (bundleStatus.status === "included") {
                    summary.mined++
                    summary.opsClosed += submittedBundle.bundle.userOps.length
                    await this.bundleManager.processIncludedBundle({
                        submittedBundle,
                        bundleReceipt: bundleStatus,
                        blockReceivedTimestamp
                    })

                    // Track transaction costs for included bundles
                    this.updateTransactionCostMetrics(
                        bundleStatus.receipt,
                        submittedBundle.bundle.userOps.map(
                            (op) => op.userOpHash
                        ),
                        bundleStatus.status
                    )
                }

                if (bundleStatus.status === "reverted") {
                    summary.reverted++
                    summary.opsClosed += submittedBundle.bundle.userOps.length
                    await this.bundleManager.processRevertedBundle({
                        blockReceivedTimestamp,
                        submittedBundle,
                        bundleReceipt: bundleStatus,
                        block
                    })

                    // Track transaction costs for reverted bundles
                    this.updateTransactionCostMetrics(
                        bundleStatus.receipt,
                        submittedBundle.bundle.userOps.map(
                            (op) => op.userOpHash
                        ),
                        bundleStatus.status
                    )
                }

                if (bundleStatus.status === "not_found") {
                    summary.notMined++
                    const [networkGasPrice, networkBaseFee] = await networkFees
                    this.potentiallyResubmitBundle({
                        blockReceivedTimestamp,
                        submittedBundle,
                        networkGasPrice,
                        networkBaseFee
                    })
                }
            })
        )
        // Keep the run guard until every started branch has settled.
        const failure = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        )
        if (failure) {
            throw failure.reason
        }
        return summary
    }
```

Required semantics:

- Snapshot `pendingBundles` once. The statuses array remains index-aligned with that snapshot. Do not re-read pending bundles inside branches.
- Start both fee legs exactly once per nonempty run, with rejection fallbacks attached immediately. All `not_found` branches await the **same** `networkFees` promise. A failing gas leg gets both gas fields zero; a failing base-fee leg gets only base fee zero. Preserve the successful sibling value.
- Included/reverted branches wait for the existing aggregate status lookup, never for shared fees. All-included/all-reverted runs may finish with fees still pending. Do not add a trailing `await networkFees`, lazy-start fees after receipts, cancel requests, or reuse another run's result.
- Both fee fallbacks remain even when no branch consumes the result or receipt parsing rejects. Their bodies must not throw. Background fee work can still issue RPCs, log errors, and update the gas manager's queues; it is not side-effect free. Overlap and aggregate RPC rate may increase.
- Preserve the reverted handler's independent base-fee lookup. Do not promise identical underlying RPC counts or fee observations: its lookup can race a shared cache update (§2). This proposal accepts that timing change; deduplicating requests or reusing the shared fee would require a different contract.
- The **outer** `allSettled` is mandatory. Once statuses are available, wait for every bundle branch before fulfilling/rejecting the run, including `not_found` branches waiting on fees. Otherwise a mined failure can release the guard before a deferred resend decision runs, and a later run can decide on that same bundle again.
- Rethrow the rejected result with the lowest **input index**, preserving its exact reason. This is not the first failure in completion time. Do not wrap in `AggregateError`, swallow, retry, or add per-op logs.
- A status-lookup rejection still fails before any bundle branch starts. Shared fee rejections remain caught. A branch rejection now propagates later, after other started branches settle: this is an intentional failure-timing change.
- Do not await the background transactions launched by `potentiallyResubmitBundle`, or the rejected-op checks launched by `processRevertedBundle`. The new barrier covers the promises those existing methods return, not their detached descendants. An indefinitely pending branch still holds the guard; do not add a new timeout here.

### 4.2 Overlap included-op work after cleanup

Replace only `BundleManager.processIncludedBundle` in `src/executor/bundleManager.ts` with:

<!-- audit:included -->
```ts
    async processIncludedBundle({
        submittedBundle,
        bundleReceipt,
        blockReceivedTimestamp
    }: {
        submittedBundle: SubmittedBundleInfo
        bundleReceipt: BundleStatus<"included">
        blockReceivedTimestamp: number
    }) {
        const { bundle } = submittedBundle
        const { userOps, entryPoint } = bundle
        const { transactionHash, blockNumber, userOpReceipts } = bundleReceipt

        // Cleanup bundle
        await this.freeSubmittedBundle(submittedBundle)

        // Preserve per-op ordering while overlapping independent I/O waits.
        const results = await Promise.allSettled(
            userOps.map(async (userOpInfo) => {
                const userOpReceipt = userOpReceipts[userOpInfo.userOpHash]

                // Cache the receipt
                await this.receiptCache.set(
                    userOpInfo.userOpHash,
                    userOpReceipt
                )

                await this.processIncludedUserOp(
                    userOpInfo,
                    userOpReceipt,
                    transactionHash,
                    blockNumber,
                    entryPoint,
                    blockReceivedTimestamp
                )
            })
        )
        const failure = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        )
        if (failure) {
            throw failure.reason
        }
    }
```

Required semantics:

- Await the whole `freeSubmittedBundle` call before starting any receipt/status work. Tracking removal, wallet release, submitted-store removal and their order remain unchanged.
- Per op, await the receipt-cache `set` promise before calling the unchanged `processIncludedUserOp`. This orders the attempt; it does not strengthen the cache's best-effort persistence contract. That method preserves log → status await → metrics → appropriate event invocation → duration/attempt metrics → reputation.
- All per-op chains start without waiting for previous ops. Preserve one cache call and, when that promise fulfills, one status call per op; do not promise one Redis command or one event-loop turn per bundle.
- A **rejected cache promise** prevents that op's log/status/event/metrics/reputation work; other ops continue. An ordinary Redis cache error is caught inside `set`, so status processing still runs. A rejected status write leaves the earlier cache attempt and inclusion log intact, but skips later actions. Do not claim the receipt persisted or the rejected op completed successfully.
- Await every op chain before rejecting. If several reject, throw the reason for the lowest `userOps` index, even if another error arrived first. A sibling that never settles prevents rejection from returning; no new timeout.
- Different ops may finish out of order. Shared reputation counters remain safe because their updates are synchronous. No new ordering guarantee for external event delivery.
- Empty and single-op arrays work without special branches. An empty array still performs cleanup once.

### 4.3 Put counts on successful timing lines

Replace `handleBlock` only to add the `timed` summary option shown below; preserve the existing guard, context and `finally`:

<!-- audit:handle -->
```ts
    private async handleBlock(block?: Block) {
        // Checked before opening a context or starting the timer so overlapping
        // ticks don't emit a [timing] line for work that never ran. Synchronous
        // and before any await, so the guard is as tight as it was inside.
        if (this.currentlyHandlingBlock) {
            this.logger.debug("skipping overlapping block tick")
            return
        }

        // try/finally, else a throw in handleBlockInner leaves this set and
        // every later tick bails at the guard above.
        this.currentlyHandlingBlock = true

        // startWatchingBlocks() registers its timers inside whichever flow
        // first started the watcher, so those timers inherit that flow's log
        // context on every future tick. Open a fresh context here so block
        // handling is never attributed to one arbitrary bundle.
        try {
            await runWithLogContext({ flow: "block" }, () =>
                timed(
                    this.logger,
                    "handleBlock",
                    { blockNumber: block ? Number(block.number) : undefined },
                    () => this.handleBlockInner(block),
                    { summarize: (summary) => summary }
                )
            )
        } finally {
            this.currentlyHandlingBlock = false
        }
    }
```

Count definitions are part of the log contract:

| Field | Exact meaning on a successful run |
|---|---|
| `pending` | Length of the initial pending-bundle snapshot |
| `mined` | Number of `included` bundle statuses whose handler returned |
| `reverted` | Number of `reverted` bundle statuses whose handler returned |
| `notMined` | Number of `not_found` bundles passed to the resend decision, including decisions that do nothing |
| `opsClosed` | Sum of input op counts in included + reverted bundles; this means **retired bundle membership**, not terminal op status. Reverted ops may be resubmitted or checked asynchronously |

On success, `pending === mined + reverted + notMined`. Counts are numbers, not strings. `summarize` returns the summary object, including all zeros for an empty run. Do not change `timed` itself. Failed runs retain the existing `[timing] handleBlock failed` warning, without partial summary fields; overlapping skipped ticks emit no timing line. Transaction-cost metrics remain after each successful bundle handler, once per bundle, using the existing receipt. A successful timing line does not certify Redis receipt-cache persistence or completion of detached reverted-op checks.

## 5. Acceptance and performance interpretation

Correctness acceptance is the dependency/error/ordering contract in §4 and deterministic tests in §6, not a wall-clock benchmark threshold.

Ignoring shared CPU contention, the old included-only critical path contains `max(receipt work, gas work, base-fee work)` followed by the longest serial bundle chain. The new path contains receipt work followed by the longest concurrent per-op chain, with cleanup still preceding each bundle's ops. Real CPU, receipt parsing, memory-cache pruning, logging and Redis service time remain. Mixed runs must also drain fee-dependent branches; reverted simulation can dominate too.

The original estimates (7+ op p50 193–310ms → 50–100ms; quiet single-op 41ms → 25–30ms; per-op slope 11–21ms → 0–3ms; last of nine statuses ~90–170ms earlier) are **unverified hypotheses**, not guarantees. Earlier wallet release comes from moving the fee barrier, not from parallelizing the loop that runs after release. `submittedMs` for an op in the current run cannot improve because of shorter work later in that same run; later runs may start sooner.

## 6. Tests and implementation sequence

### 6.1 Executor manager contract tests

Extend the existing `createHarness` in `src/executor/executorManager.test.ts`; retain current call sites/defaults. Return a single captured logger, both fee mocks, `processRevertedBundle`, and a spy on the public `potentiallyResubmitBundle`. Use `vi.spyOn(executorManager, "getBaseFee")` to defer base fee even though the existing harness defaults to legacy mode. Return the gas mock from construction rather than casting private fields. The default pending bundle with an empty statuses array is not a valid summary fixture: each new test must supply exactly one status per pending bundle.

Use manually settled promises, not elapsed-time performance assertions. Attach a rejection observer to `emitBlock()` immediately when failure is expected. Drain microtasks with `await vi.advanceTimersByTimeAsync(0)` under fake timers, without advancing the watchdog deadline. Stop watching, settle all fee/op deferrals, restore spies and real timers in cleanup. Do not hide unhandled rejections with a test listener.

```ts
const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}
```

Required cases (parameterize symmetric fee failures):

| Case | Setup and assertions |
|---|---|
| E1 empty | Zero pending bundles. Watcher stops, no receipt/gas/base-fee calls; one success timing line with all five counts zero |
| E2 included | Defer **both** fees. Included handler and entire run finish first. Then reject both detached fees; no unhandled rejection |
| E3 reverted | Same as E2 with a resolving reverted-handler stub. Assert supplied `block` forwarded unchanged; shared fees are not passed to this handler. This proves the executor dependency only: the real handler can still await its own base-fee lookup/simulation |
| E4 only unmined | Two `not_found` bundles, both fee legs deferred. Resolving one leg does not invoke decisions or finish the run. Resolve the other: exactly one decision per bundle, same resolved values, one call per fee leg |
| E5 mixed | Included(2 ops), reverted(3), two not-found(1 each). Included/reverted start while fees wait; run remains pending. After fees settle: summary `{pending:4,mined:1,reverted:1,notMined:2,opsClosed:5}` |
| E6 fallbacks | Gas rejects / base fee succeeds, base rejects / gas succeeds, both reject. Verify exact independent zero fallbacks at `potentiallyResubmitBundle`, not only whether a replacement happened |
| E7 receipt failure | `getBundleStatuses` rejects. No branch handlers, failure propagates unchanged; reject detached fees afterward without unhandled rejection |
| E8 guard during fees | Mixed run with fee deferrals. A second emitted block does not trigger another status/fee fetch or timing line. First run completes only after fees and awaited handlers settle |
| E9 error and deferred decision | Included handler removes its bundle then rejects; not-found sibling still awaits fees. First run and guard stay pending. Second block is skipped. After fees resolve, sibling gets exactly one decision, then first run rejects with original error. A later block can run |
| E10 multiple errors | Two handler deferrals; reject later input first, earlier input second. Keep run pending until both settle; reject with earlier input's reason. No successful timing summary |
| E11 metrics | Cost metrics invoked only after corresponding included/reverted handler fulfills; same receipt, hashes and status, one call per successful bundle. Rejected handler has no cost update |
| E12 timestamps/triggers | Preserve `blockReceivedTimestamp` captured before waits, and no-block watchdog/flashblocks behavior. Existing watchdog, overlap, included and timing tests remain green |

E9 must fail against the original proposal that moves fee waits but retains the outer `Promise.all`. E2/E3 must fail against the unchanged baseline. Do not use `replaceTransaction` arguments to test gas fallback values: a zero estimate can legitimately make the resend decision a no-op.

### 6.2 Included bundle contract tests

Add `src/executor/bundleManager.test.ts`. Instantiate the real `BundleManager` with typed narrow dependency stubs (`ConstructorParameters<typeof BundleManager>[0]`, `unknown` assertions where necessary, no new `any`). Clear `BETTER_STACK_TOKEN` with `vi.hoisted` as existing executor tests do. Use the real in-memory receipt cache by default; B5's Redis case uses a stubbed Redis client without opening a connection. Stub monitor status writes with one deferred per distinct hash. Use valid userOperation/receipt fixtures, including `receipt.logs: []`, and a single captured logger. Spy on the memory-cache factory if cache gates are needed; do not mock `processIncludedUserOp` in these implementation tests.

| Case | Assertions |
|---|---|
| B1 five ops | With all statuses unresolved, all five writes have started. The bundle promise stays pending until the last chain settles |
| B2 cleanup gates | Defer wallet release: no submitted-store removal or per-op action. Resolve wallet, defer store removal: still no per-op action. Resolve removal: each op's receipt is cached before its status call |
| B3 status failure | Reject op 3 while op 5 remains pending. Ops 1/2/4 may finish; bundle stays pending until 5 settles, then rejects with op 3's exact reason. All five logs were emitted before writes; only successful writes have events/metrics/reputation updates |
| B4 failure order | Reject op 4 before op 2; throw op 2's exact reason after all settle. No `AggregateError` |
| B5 cache failure | Inject rejection for one op's cache promise: no log/status/event for that op; other ops complete and bundle rejects after all settle. Separately use the real Redis cache with a rejecting Redis-client stub: cache error is logged, `set` fulfills, and that op's status/actions continue. Do not mistake the injected rejection for the Redis factory's behavior |
| B6 cleanup failure | Wallet failure or submitted-store removal failure rejects without starting any per-op action; assert existing tracking/wallet side effects rather than assuming rollback |
| B7 event kinds | Success receipt invokes included event once; `success:false` receipt invokes execution-reverted event once with `reason || "0x"`. Both persist `status:"included"`; metrics/reputation counts preserved, including shared sender/paymaster |
| B8 zero/one op | Empty list does cleanup once and no op actions. Single op retains existing action order and counts |

### 6.3 Execution steps and gates

- [ ] Add E1–E12/B1–B8 using the existing test runner; run targeted tests and confirm baseline failures occur at concurrency/summary assertions, not fixture or import errors.
- [ ] Apply §4 exactly, within the four allowed files. Re-run targeted tests; resolve all failures.
- [ ] Run all unit tests once, then TypeScript and changed-file Biome checks. Record pre-existing failures separately; do not fix unrelated code.
- [ ] Inspect diff: no source changes beyond §0, no exported summary type or new dependency, no changed resend logic, no detached uncaught fee promise. Stage only those four files.

Commands from repository root:

```sh
pnpm --dir src test:unit executor/executorManager.test.ts executor/bundleManager.test.ts executor/getBundleStatus.test.ts executor/inclusionTimings.test.ts utils/timed.test.ts
pnpm --dir src test:unit
pnpm --dir src exec tsc --noEmit -p tsconfig.json
pnpm exec biome check src/executor/executorManager.ts src/executor/bundleManager.ts src/executor/executorManager.test.ts src/executor/bundleManager.test.ts
git add src/executor/executorManager.ts src/executor/bundleManager.ts src/executor/executorManager.test.ts src/executor/bundleManager.test.ts
git diff --cached --check
```

### 6.4 Audit reproduction (spec validation, not implementation)

Run from the repository root with installed dependencies:

```sh
node docs/specs/2026-09-29-block-processing-waits.audit.cjs
```

The [audit script](./2026-09-29-block-processing-waits.audit.cjs) compiles exact method snippets from §4 in memory and exercises them with deterministic deferred dependencies. It also checks baseline behavior and reproduces the rejected outer-`Promise.all` variant. It does not modify production source or contact production services; it does not measure Redis/network/event-loop latency. Runtime output is the assertion evidence. The audit is intentionally pinned to the audited baseline files, not a replacement for the implementation tests above.

The audit passed **16 deterministic checks**: baseline serial dependencies, candidate early included/reverted completion, empty/mixed summaries, shared fee values and independent fallbacks, receipt failure, input-order error selection, cleanup gates, real per-op action ordering, guard behavior, and the reverted cold-cache RPC difference (§2). The rejected outer-`Promise.all` variant produced **two resend decisions** for the same pending bundle across overlapping runs; the corrected `allSettled` variant produced **one**. Run used Node 25.9.0; no latency benchmark is implied. A separate TypeScript compiler check over virtual copies of both full source files, with the exact §4 replacements and real project configuration/dependencies, reported **zero baseline diagnostics and zero candidate diagnostics**. Production source stayed untouched.

The existing focused baseline suite passed **92 tests across four files** (`executorManager`, `getBundleStatus`, `inclusionTimings`, `timed`) during this review. Full implementation tests, full suite and TypeScript gates remain the implementer's work.

## 7. Rollout and measurement

Deployments are outside this document-edit task. After implementation passes §6, canary Ostium for a comparable weekday burst, confirm actual schedule from recent traffic, then consider Base prod. The original schedule (19:57 UTC, later 20:57 UTC) is operational context, not a validated calendar rule. Rollback restores the prior code; additive log fields require no data migration.

Before/after comparisons must record service, pod, build, configuration, traffic volume, ops per bundle and sample count. Do not pool old builds with missing fields as zero. A successful **included-only** run requires `pending > 0`, `mined = pending`, `reverted = 0`, `notMined = 0`; `notMined = 0` alone also admits reverted and empty runs.

The original BetterStack table/source names below are retained as an **unexecuted query template**. Verify raw JSON field nesting and table identity before use. Supply UTC `{from:DateTime}` and `{to:DateTime}` query parameters and filter to the deployed build/pods in the query environment.

```sql
SELECT
    pending AS bundle_count,
    pending = 0 AS empty_run,
    reverted > 0 AS has_reverted,
    notMined > 0 AS checked_unmined,
    multiIf(ops = 0, '0', ops = 1, '1', ops <= 3, '2-3',
            ops <= 6, '4-6', '7+') AS op_bucket,
    count() AS runs,
    round(quantile(0.5)(ms)) AS p50,
    round(quantile(0.95)(ms)) AS p95,
    round(max(ms)) AS maximum
FROM (
    SELECT
        JSONExtractInt(raw, 'pending') AS pending,
        JSONExtractInt(raw, 'mined') AS mined,
        JSONExtractInt(raw, 'reverted') AS reverted,
        JSONExtractInt(raw, 'notMined') AS notMined,
        JSONExtractInt(raw, 'opsClosed') AS ops,
        JSONExtractFloat(raw, 'ms') AS ms
    FROM s3Cluster(primary, t187081_ultra_relay_base_prod_s3)
    WHERE _row_type = 1 AND dt >= {from:DateTime} AND dt < {to:DateTime}
      AND raw LIKE '%srv-d9obrkvlk1mc73897rvg%'
      AND JSONExtractString(raw, 'msg') = '[timing] handleBlock'
      AND JSONHas(raw, 'pending') AND JSONHas(raw, 'mined')
      AND JSONHas(raw, 'reverted') AND JSONHas(raw, 'notMined')
      AND JSONHas(raw, 'opsClosed')
)
WHERE pending = mined + reverted + notMined
GROUP BY bundle_count, empty_run, has_reverted, checked_unmined, op_bucket
ORDER BY empty_run, has_reverted, checked_unmined, bundle_count, op_bucket
```

Measure included-only run p50/p95 by both op count and bundle count. The ~100ms target is exploratory; small samples or changed workload mean inconclusive, not pass/fail. Also monitor receipt-cache/status errors, pending-bundle age, replacement/rotation reasons, aggregate fee-RPC rate and concurrent calls. Unchanged shared method-call counts do not ensure equal RPC counts per run or per second. Track failed-run frequency and duration separately: success-only quantiles can improve when slow runs fail and disappear from the sample.

Require no new unhandled-rejection, status-persistence, duplicate-decision or wallet-reuse regressions attributable to this change before expanding rollout. Daily resend counts can change with traffic and tick frequency; compare rates and causes, not raw equality. Report `submittedMs`, `walletWaitMs` and late-timer distributions as secondary signals only. The historical 354ms submitted p95, 13ms wallet p95 and 18 late ticks are reported baselines, not hard acceptance thresholds.

## 8. Explicitly deferred issues

- Normal viem `watchBlocks` invokes callbacks without awaiting their returned promises; this project's `unhandledRejection` handler requests graceful shutdown. Watchdog/flashblocks callbacks catch errors. Do not silently add a watcher catch here; retry/recovery after cleanup needs its own design. Node emits unhandled rejection when no handler is attached within an event-loop turn ([Node process documentation](https://nodejs.org/api/process.html#event-unhandledrejection)).
- Reverted rejected-op checks are already concurrent and detached. Fix their error ownership separately; do not convert an imaginary serial loop.
- Reuse watcher block data for fee estimation, or skip fees for included-only runs, only in a separate RPC-reduction change.
- Overlap submitted-store cleanup with op processing only under a separate ownership/order contract.
- CPU profiling/event-loop delay instrumentation and transaction-cost gauge cardinality remain separate investigations. Memory-cache `set` also scans for expired entries; parallel promises do not eliminate that CPU work.

`allSettled` waits for all inputs and returns results in input order; this is why lowest-index failure selection is deterministic ([MDN reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled)). It does not wait for detached work inside those inputs.

## Appendix: original evidence provenance and limitations

The original analysis names BetterStack UR source 1169629 and Ostium service `srv-d9obrkvlk1mc73897rvg`; Sep 25/28 19:56–20:00 UTC bursts; Sep 28 21:00 → Sep 29 02:00 quiet hours. It assigns transactions to pods via `included in tx` logs and derives transaction block/op counts from EntryPoint v0.6 events on Arbitrum One.

Its join assigns a transaction to the pod's first run whose block is at or after the mined block. Delayed receipt visibility can put it in the wrong run; the original appendix reports two bundles assigned to one 0ms run. Forwarder timestamps and 50ms alignment slack also limit sub-second overlap claims. All 57/53 bundles being assigned proves join coverage, not correct run attribution.

The original benchmark reports Redis 8.6.1, a TCP proxy delaying client-to-server chunks by 2ms, real `Monitor`, median of 15, and busy synchronous chunks scheduled with `setImmediate`. Neither its program nor raw output was supplied. The new deterministic audit validates ordering, not those timing values. The [earlier Redis-pop spec](./2026-09-28-redis-pop-round-trips.md) explicitly marks production RTT estimates unverified, so it cannot independently establish event-loop delay here.

## 9. Amendment (2026-09-29): close the submission-bookkeeping race

**Why.** The deep review found, and three independent verifiers confirmed, a pre-existing race that §4.1 widens. `sendBundleToExecutor` tracks a sent bundle, then awaits `markUserOpsAsSubmitted` (per op: `removeProcessing` → `addSubmitted` → status `"submitted"`). If that bookkeeping stalls on one Redis connection while the bundle is mined, a block run can free the bundle and write `"included"` first. The late bookkeeping then re-adds a submitted record (no TTL) and overwrites the status to `"submitted"` (1h TTL). Later runs cannot repair it because the bundle is no longer tracked. Before §4.1, the fee wait happened to protect the ordering "bookkeeping finishes before fees"; the ordering "fees finish first" already lost. The reverted path has the same exposure.

**Decision.** Option B from the decision review: make the bundle visible to block processing only after its bookkeeping settles, and make the bookkeeping settle only after every op's writes settle. Rejected: a per-bundle gate awaited inside cleanup (it would hold the global run guard while waiting, so one hung write stalls every bundle), and a status-store guard (partial; leaves the orphan record and needs an atomic Redis script).

This amendment supersedes §0's "no changes outside the four files" boundary for exactly the two methods below. All other §0 prohibitions stand.

### 9.1 `ExecutorManager.sendBundleToExecutor`

Replace only the track-then-bookkeep block (currently `trackBundle` → `bundleSubmitted = true` → `startWatchingBlocks` → `await markUserOpsAsSubmitted`) with:

```ts
                    // Sent: from here a failure must not requeue the userOps,
                    // so recoverFailedSend leaves recovery to handleBlock.
                    bundleSubmitted = true

                    // Track only once the submitted bookkeeping has settled. A
                    // block run that saw the bundle earlier could free it and
                    // write "included", then this late bookkeeping would
                    // re-add it as submitted. finally: a failed write still
                    // leaves the bundle tracked, so handleBlock owns it.
                    try {
                        await this.mempool.markUserOpsAsSubmitted({
                            userOps: submittedBundle.bundle.userOps,
                            entryPoint: submittedBundle.bundle.entryPoint,
                            transactionHash: submittedBundle.transactionHash
                        })
                    } finally {
                        // Track bundle and start loop to watch blocks
                        this.bundleManager.trackBundle(submittedBundle)
                        this.startWatchingBlocks()
                    }
```

Required semantics:

- `bundleSubmitted = true` is set before the bookkeeping await, exactly as early as today relative to any throw after broadcast. A bookkeeping failure therefore still reaches `recoverFailedSend` with `bundleSubmitted === true`: no requeue, no wallet release.
- `trackBundle` and `startWatchingBlocks` run exactly once, after the bookkeeping promise settles, on both fulfilment and rejection. The rejection still propagates to the existing `catch`.
- `lastReplaced` keeps its value from record creation. Bookkeeping delay counts toward the stuck timeout; do not reset it.
- Do not change `dropUserOps`, metrics, `recoverFailedSend`, `replaceTransaction` or rotation. Replacement re-tracks without bookkeeping and is unaffected.
- Accepted cost: while bookkeeping is pending the bundle is invisible to block processing and its wallet stays held. A hang lasts until the Redis client fails the command. No new timeout.

### 9.2 `Mempool.markUserOpsAsSubmitted`

Replace the method body's `Promise.all` with a drain that rethrows the lowest-index failure after every op settles; keep the per-op chain and the success metric unchanged:

```ts
        // allSettled: a failure is rethrown only once every op's writes have
        // settled, so the caller never tracks the bundle while a sibling's
        // submitted write is still in flight.
        const results = await Promise.allSettled(
            userOps.map(async (userOpInfo) => {
                const { userOpHash } = userOpInfo
                await this.store.removeProcessing({ entryPoint, userOpHash })
                // First value wins; see the stamp rule on userOpInfoSchema.
                userOpInfo.submittedAt ??= Date.now()
                await this.store.addSubmitted({ entryPoint, userOpInfo })
                await this.monitor.setUserOpStatus(userOpHash, {
                    status: "submitted",
                    transactionHash
                })
            })
        )
        const failure = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        )
        if (failure) {
            throw failure.reason
        }

        this.metrics.userOperationsSubmitted
            .labels({ status: "success" })
            .inc(userOps.length)
```

- The success metric still increments only when every op succeeded, once, by `userOps.length`.
- `addSubmitted` still fires its Redis write without awaiting it (`createMempoolStore.ts`). That is acceptable: the later `removeSubmitted` uses the same Redis client, which runs commands in order, and by the time bookkeeping settles the add has been sent. No change to the store.
- The drain pattern repeats §4.1/§4.2's five lines; §0's "no generic promise helper" still applies.

### 9.3 Tests

| Case | File | Assertions |
|---|---|---|
| R1 | `executorManager.test.ts` | With bookkeeping held pending: not tracked, watcher not started. After it resolves: tracked once, watcher started once, send resolves with the tx hash, tracked record already has `submittedAt`. Fails on the unchanged code at "not tracked". |
| R2 | `executorManager.test.ts` | Bookkeeping rejects: send still resolves; tracked once and watcher started once, both after the bookkeeping call; no requeue, no wallet release. Fails on the unchanged code at the call-order assertion. The existing "leaves a tracked bundle to block reconciliation" test must stay green. |
| M1 | `mempool.test.ts` | Op 2 and op 3 fail while op 1's status write is pending: the call stays pending until op 1 settles, then rejects with op 2's exact reason; no success metric. Fails on the unchanged code (rejects early). |
| M2 | `mempool.test.ts` | Success: each op removed from processing, added to submitted, status `"submitted"` with the tx hash; `submittedAt` stamped; metric incremented once by the op count. |
