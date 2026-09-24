# Spec: time the bundling pass, split processing into stages, and hand bundles over as they are built

Status: Part A ready to implement; Part B conditional on measurements and the failure-handling requirements below
Repo: `ultra-relay`
Validated against: local `HEAD` and `origin/main` at `49d2db2` (Sep 24 2026, PR #76), branch `feat/bundle_wait_flow`. Line numbers below refer to that commit. Recheck these symbols if implementing against a newer base. This review changes the spec only; production attribution remains unverified (§2.4).

Two parts, in this order:

- **Part A – instrumentation.** No behaviour change. Adds timing logs and per-op timestamps so the inclusion log breaks `processingMs` into four stages.
- **Part B – streaming hand-over.** Behaviour change. The bundling pass hands each bundle to the executor as soon as it is built, instead of collecting every bundle of the pass first.

Part A stands on its own and should be deployed first (see §9), so one burst is measured with the current behaviour before Part B changes it.

## 1. Summary

Every tick (`ExecutorManager.autoScalingBundling`, `src/executor/executorManager.ts:138`) runs one **bundling pass**: `mempool.getBundles(budget)` pops ops from the queue and packs them into bundles. Only when the pass returns does the tick hand the bundles to `sendBundleToExecutor`, which grabs a wallet, fetches gas and nonce, simulates, and broadcasts.

Since PR #66 (`3bef454`), each entry point can build up to `max(1, min(maxBundleCount ?? walletCount, walletCount))` bundles per tick. With 10 configured wallets this is up to 10 **per entry point**, not per tick across all entry points. `getBundles` runs the entry-point passes concurrently with `Promise.all`, then flattens results in configured entry-point order. A completed bundle waits for every entry point to finish. That delay lands in its ops' `processingMs`.

In the Sep 23 burst (the first with #66), burst `processingMs` p50 was 405ms against ~300–330ms on earlier weekdays, with normal quiet-hour processing (294ms) and a normal Alchemy broadcast (250ms). Two plausible contributors fit these supplied figures; neither is established as the cause, and they are not exhaustive:

1. **Pass length.** Finished bundles wait for the rest of the pass.
2. **Wallet contention.** Pods using the same Redis endpoint, key prefix and chain share the wallet queue. If both have the reported 10-wallet configuration and one busy entry point, one simultaneous pair of ticks can dispatch 20 bundles. This is not a global concurrency bound: more active entry points and outstanding dispatches from previous ticks add waiters. Wallets remain held through inclusion/reconciliation (or failure recovery), not just until broadcast. Waiting for a wallet also counts in `processingMs`.

Part A separates these durations for included ops with a complete timestamp chain. Part B removes the explicit wait for the remaining pass; it can also change wallet contention and packing cost through overlap. Gas/nonce RPCs, simulation, store latency and event-loop scheduling remain possible contributors. Aggregate medians cannot isolate their costs.

## 2. Background

### 2.1 What is measured today

`processIncludedUserOp` (`src/executor/bundleManager.ts:270–310`) logs `userOp … included in tx …` with:

| Field | Definition | Stamped where |
|---|---|---|
| `validationMs` | `addedToMempool − receivedAt` | `receivedAt`: RPC handler entry; `addedToMempool`: `mempool.add` (`mempool.ts:451`) |
| `outstandingMs` | `processingAt − addedToMempool` | `processingAt`: when the pass picks the op (`mempool.ts:1063`) |
| `processingMs` | `submittedAt − processingAt` | `submittedAt`: `markUserOpsAsSubmitted` (`mempool.ts:103`), after the broadcast returned |
| `submittedMs` | block seen − `submittedAt` | |

`processingMs` therefore spans: rest of the pass → hand-over → wallet wait → gas/nonce lookups → simulation → broadcast → processing-store removal. `submittedAt` is assigned after `removeProcessing`, before `addSubmitted` and monitor updates; it does not measure all post-broadcast bookkeeping or confirmation on-chain. Work before `processingAt` (including candidate selection/validation) belongs to `outstandingMs`. Nothing currently splits processing.

Existing per-call timing lines (`[timing] <step>` via `timed()`, `src/utils/timed.ts`): `preBundle.networkGasPrice`, `preBundle.baseFee`, `preBundle.getTransactionCount`, `filterOps`, `sendHandleOpsTransaction`, `handleBlock`, and the validation steps. There is none around `getBundles` and none around `getWallet`.

### 2.2 How a wallet is obtained

`senderManager.getWallet()`:

- Redis (`createRedisSenderManager.ts:75–110`, used by the Ostium instance): pops from a shared Redis list; when the list is empty it sleeps **100ms** and retries. Each empty pop adds a 100ms sleep plus Redis and scheduling latency. Clusters near 100ms increments support contention but are not proof: slow Redis or event-loop scheduling can also lengthen `getWallet`.
- Memory (`createMemorySenderManager.ts:26`): waits on a semaphore.

### 2.3 Reported Sep 23 burst (first burst on #66), 19:56–20:00 UTC, 167 ops

| | Sep 15–21 weekdays | Sep 23 |
|---|---|---|
| Queue wait (`outstandingMs`) p50 / p95 / max | 152–175 / 516–676 / 769–1,139ms | 75 / 207 / 496ms |
| `processingMs` p50 | 301–331ms | **405ms** |
| Broadcast (`eth_sendRawTransaction`) p50 | 210–251ms | 250ms |
| Quiet-hour `processingMs` p50 that day | ~305–324ms | 294ms |
| Time to inclusion p50 / p95 | 733–801 / 1,115–1,316ms | 742 / 992ms |

### 2.4 Validation evidence and limits (Sep 24 review)

| Claim | Evidence / verdict |
|---|---|
| A completed bundle waits for the remaining pass | Confirmed in `ExecutorManager.autoScalingBundling` and `Mempool.getBundles`/`process`; a local probe using the real tick and `getBundles` methods held the second entry point open and observed zero executor calls until it resolved. |
| Wallet acquisition can add ~100ms retry steps | Confirmed in `createRedisSenderManager.getWallet`. The budget uses total configured wallets, not currently available wallets. |
| Two pods share wallets in the checked-in Ostium deployment | `deployments/ultra-relay-arbitrum-ostium.values.yaml` specifies two replicas, horizontal scaling, prefix `ostium`, and two entry points. This is intended configuration, not proof of the Sep 23 runtime, wallet count or active entry points. Wallet keys come from a secret; this review did not read it. |
| The 405ms p50 is caused by pass length or wallets | Unproven. §2.3 contains supplied aggregates; no raw logs or reproducible query/export accompanied them. The reported normal broadcast median does not exclude slower simulation, gas/nonce RPCs, store removal or tails. |
| A synchronous callback `try/catch` handles executor errors | False. A local probe of the real `sendBundleToExecutor` rejected at `getWallet` without entering its internal recovery; the synchronous caller catch did not run. An unhandled rejection triggers shutdown in `src/cli/setupServer.ts:392`. Part B must close this gap (§B3). |
| The proposed due-time metric detects a slow previous pass | False. The timer is armed after packing and dispatch. A local probe with a 500ms pass and a 200ms interval scheduled the next tick 700ms after the previous start. It could fire exactly on time. Use pass duration for this cost. |

Validation run: `pnpm --dir src test:unit mempool/mempool.test.ts executor/executorManager.test.ts executor/senderManager/createRedisSenderManager.test.ts` — **89 tests passed** (60 mempool, 26 executor-manager, 3 Redis sender-manager). Three additional temporary assertion probes checked the barrier, wallet rejection and timer scheduling against unchanged source. These validate current behavior, not the proposed implementation or production causality.

Before interpreting a production comparison, preserve the actual query/export, sample counts, deployed revision/image, replica count, active entry points, wallet count, Redis namespace and host/service filters. The historical Render hostname filter in §8 must not silently exclude a later Kubernetes deployment.

## 3. Goals and non-goals

### Goals

- G1. Measure how long each bundling pass takes, and how many bundles and ops it produced.
- G2. For each included op with a complete, ordered timestamp chain, split `processingMs` into: time until its bundle was complete, time until the bundle reached the executor, wallet acquisition, and time from wallet acquisition to the first `submittedAt`. Report breakdown coverage; legacy/instant-path records can legitimately lack it.
- G3. Detect a timer callback that fires late relative to when its timer was armed, using a monotonic clock. Pass duration separately reveals slow packing; this is not a fixed-rate scheduler or proof of a specific event-loop stall.
- G4. (Part B) Start each bundle's executor work as soon as that bundle is complete. Preserve packing rules and per-entry-point order for a fixed queue/state. Concurrent arrivals, requeues and chain-state changes can alter later bundle contents or end the pass earlier (§D9).

### Non-goals

- N1. Changing packing rules, caps, the per-entry-point `max-bundle-count` budget or the interval formula. Part B intentionally changes global dispatch order to completion order; actual scheduling and bundle membership can differ under concurrent state changes.
- N2. Changing wallet-pool size or the Redis 100ms retry delay. If Part A shows wallet wait is the problem, that is a separate change.
- N3. New Prometheus metrics. Logs only. (`walletsProcessingTime` in `src/utils/metrics.ts:221` is defined but never observed; leave it alone.)
- N4. Changing RPC call sites or response schemas. `debug_bundler_sendBundleNow` keeps `getBundles(1)` without a callback and awaits dispatch itself. `pimlico_sendUserOperationNow` constructs a bundle directly and lacks `processingAt`/`bundledAt`, so it gets no four-stage breakdown. Both receive shared executor timing logs; Part B's wallet-failure recovery applies to all callers.
- N5. Any other log line's level or content.

## 4. Design decisions and reasoning

**D1. Per-op timestamps on `UserOpInfo`, reported in the existing inclusion log; no new per-op log lines.**
The inclusion log already carries the stage breakdown and is what the analysis queries read. Adding fields avoids new per-op lines, but serialization and the new pass/wallet logs still have overhead. Check latency and log volume after Part A.

**D2. Three new stamps: `bundledAt`, `dispatchedAt`, `walletAcquiredAt`.**
With the existing `processingAt` and `submittedAt` they split `processingMs` into four adjacent stages that sum exactly to it:

```
processingAt ─ bundleBuildMs ─► bundledAt ─ handOffMs ─► dispatchedAt ─ walletWaitMs ─► walletAcquiredAt ─ submissionMs ─► submittedAt
```

- `bundleBuildMs`: op picked → its bundle complete (rest of that bundle's packing).
- `handOffMs`: bundle complete → `sendBundleToExecutor` entered. Includes waiting for remaining packing across entry points, carry write-back, result aggregation and tick logging/accounting before dispatch. Part B removes that barrier, so this should usually be near zero.
- `walletWaitMs`: executor entry → wallet acquired. Dominated by `getWallet`, with small context/timing-log overhead. The separate monotonic `bundle.getWallet` line isolates that call. Approximate 100ms steps support, but do not establish, an empty Redis pool.
- `submissionMs`: wallet → first `submittedAt` (gas/nonce lookups, `filterOps`, transaction send and processing-store removal). This is not raw `eth_sendRawTransaction` latency or on-chain confirmation. Keep existing RPC timing lines to separate these substeps.

**D3. `bundledAt` is assigned every time the pass places the op; `dispatchedAt` and `walletAcquiredAt` use `??=` (first value on that record wins), like `submittedAt`.**
`processingAt` is assigned at every pick, so `bundledAt` must be too. `submittedAt` is first successful submission of that record, not first attempted send. Normal `resubmitUserOps` rebuilds the record via `mempool.add`, preserving only `receivedAt` and reentry metadata; all processing-stage stamps start fresh. Rotation passes existing records back into the executor, so `??=` retains the original submission cycle. Direct outstanding write-backs can retain metadata; Redis outstanding serialization also preserves schema fields. D4 suppresses incomplete or inconsistent chains rather than inventing a duration. The breakdown does not measure later replacement/rotation attempts; per-call `bundle.getWallet` logs do.

**D4. The four-stage breakdown is emitted only when existing `processingMs` is defined and all five stamps exist and are in order** (`processingAt ≤ bundledAt ≤ dispatchedAt ≤ walletAcquiredAt ≤ submittedAt`). Otherwise the four fields are omitted and the existing fields are unchanged. Keep timestamps in epoch milliseconds to match existing lifecycle fields; use `performance.now()` only for call/timer durations. Wall-clock adjustments or mixed-version records may suppress the breakdown. Do not clamp negative values or fill missing stamps.

**D5. Pass timing is logged by hand, not through `timed()`.** The line needs the pass's result (bundle and op counts), which `timed()` cannot know. It keeps the `[timing] <step>` message and `step` / `ms` fields so existing queries match it.

**D6. Idle ticks stay quiet.** The tick runs several times a second around the clock. A successful pass line is logged only when the pass produced a bundle, or took ≥ 50ms without producing one (including passes that skip/drop every candidate). Failures always get a warning timing line. The late-tick line is logged only when the tick ran ≥ 50ms after it was due.

**D7. (Part B) Streaming is an optional synchronous ownership-transfer callback on `getBundles`/`process`; the return value is unchanged.**
`getBundles(maxBundleCount?, onBundle?)`. The pass calls `onBundle(bundle)` synchronously the moment a bundle is complete, then continues. On successful completion, the full array is still returned. The callback must be a synchronous function returning `void`; TypeScript also permits assigning an async function to a void-returning callback, so explicitly prohibit that usage. The production wrapper starts the internally recovered executor promise without returning it. Contract:

- Existing callers without a callback keep their return/dispatch behavior. Preserve all 60 current mempool tests, apart from explicit timing assertions added here.
- The tick still needs the counts for the interval formula.
- Normal callback return transfers ownership to the executor; it must not mutate `entryPoint`, `version` or the bundle's `userOps` membership. Timestamp mutation is allowed. The production callback starts the async executor method and returns immediately; do not await wallet/network work in the packing loop.
- A callback may throw only **before** accepting ownership. On such a failure, log, requeue that bundle through `resubmitUserOps`, and propagate the error; `process`'s existing `finally` restores its carry. Do not silently continue with abandoned processing records. A callback that launches work and then throws violates this internal contract.
- Async failure is a separate boundary: synchronous `try/catch` cannot catch a rejected executor promise. Move wallet acquisition inside the executor's recovery guard in Part B (§B3); that method owns operational failures for every caller. Merely adding `.catch(logger.error)` would hide the rejection while leaving user operations stranded.

**D8. (Part B) The returned array is informational only for a callback caller.** The automatic tick must not send from it again. Without a callback it remains the dispatch list for existing callers. Callback order follows completion across entry points; returned-array order remains configured entry-point order, with per-entry-point bundle order preserved. There is no global `callbacks[i] === returned[i]` guarantee.

**D9. (Part B) Concurrent state changes are part of the behavior change.** Bundle 1 may be resubmitted, included or dropped while later bundles are being packed. Re-popping its hash hits `seenOps`, returns it with `reentered` and ends that entry-point pass; a future pass may pick it again. `slotsInPriorBundles` still prevents splitting one sender/nonce-key chain across bundles within that pass, even if the predecessor lands early. These guards are local to one pass, not cross-pod or cross-tick locks. Existing guard tests are useful but do not exercise streaming executor callbacks; add explicit overlap tests (§7.2). Exact production bundle membership/count is not promised.

**D10. Errors after a partial hand-over cannot roll it back.** If later packing or carry write-back rejects, earlier callbacks already own their bundles. Never dispatch returned/accumulated bundles as a fallback and never requeue those already handed over. Preserve existing pass-error propagation and carry cleanup. This spec does not fix the pre-existing unowned partial-bundle paths on arbitrary packing/store failures, nor the tick stopping after an uncaught pass failure; those remain separate recovery work. A failed pass must get a timing failure log rather than disappear from duration analysis. `Promise.all` does not cancel sibling entry-point passes: another entry point can still invoke its callback after `getBundles` rejects. Its executor retains ownership as usual; rejection is not a quiescence signal.

## 5. Part A – instrumentation

### A1. `src/types/schemas.ts` – add the stamps

In `userOpInfoSchema` (l.796), after `processingAt`, add:

```ts
    // Stage stamps that split processingMs in the inclusion log:
    // bundledAt when the op's bundle is complete in the bundling pass,
    // dispatchedAt when sendBundleToExecutor takes the bundle, and
    // walletAcquiredAt when it has obtained an executor wallet. All optional
    // so records serialized before this change keep deserializing.
    bundledAt: z.number().optional(),
    dispatchedAt: z.number().optional(),
    walletAcquiredAt: z.number().optional(),
```

Extend the existing comment above `receivedAt` (l.800–803) to mention the three new stamps in the same sentence style.

### A2. `src/mempool/mempool.ts` – stamp `bundledAt` when a bundle completes

In `process()`, the block at l.1071–1076 reads:

```ts
                if (currentBundle.userOps.length > 0) {
                    bundles.push(currentBundle)
                    for (const slot of currentBundleSlots) {
                        slotsInPriorBundles.add(slot)
                    }
                }
```

Replace with:

```ts
                if (currentBundle.userOps.length > 0) {
                    // Assigned (not ??=) like processingAt: stamped every
                    // time the pass places the op, so a re-picked record
                    // cannot carry a stale value.
                    const bundledAt = Date.now()
                    for (const userOpInfo of currentBundle.userOps) {
                        userOpInfo.bundledAt = bundledAt
                    }
                    bundles.push(currentBundle)
                    for (const slot of currentBundleSlots) {
                        slotsInPriorBundles.add(slot)
                    }
                }
```

The ops in `currentBundle.userOps` are the same objects passed to `store.addProcessing` and later to the executor. Both store backends keep the `UserOpInfo` reference in local memory; Redis processing/submitted indexes serialize the underlying `userOp`, not these lifecycle stamps. The executor spreads records into the tracked submitted bundle, preserving the stamps. Outstanding serialization parses `userOpInfoSchema`, so the optional fields must be declared there. Do not add extra store writes solely to persist timings; this is not cross-process crash recovery.

### A3. `src/executor/executorManager.ts` – stamp `dispatchedAt`, time `getWallet`, stamp `walletAcquiredAt`

In `sendBundleToExecutor` (l.292), the start reads:

```ts
        const { entryPoint, userOps, version } = userOpBundle
        if (userOps.length === 0) {
            return undefined
        }

        return await runWithLogContext(
```

Insert between the early return and `return await runWithLogContext(`:

```ts
        // First value wins (??=), like submittedAt, so the inclusion-log
        // breakdown stays with the original submitted record even if the
        // bundle is later rotated back through here.
        const dispatchedAt = Date.now()
        for (const userOpInfo of userOps) {
            userOpInfo.dispatchedAt ??= dispatchedAt
        }
```

Inside the `runWithLogContext` callback, the wallet line (l.311) reads:

```ts
                const wallet = await this.senderManager.getWallet()
```

Replace with:

```ts
                const wallet = await timed(
                    this.logger,
                    "bundle.getWallet",
                    { entryPoint, bundleSize: userOps.length },
                    () => this.senderManager.getWallet()
                )
                const walletAcquiredAt = Date.now()
                for (const userOpInfo of userOps) {
                    userOpInfo.walletAcquiredAt ??= walletAcquiredAt
                }
```

`timed` is already imported from `@alto/utils` in this file. On a `getWallet` failure it logs `[timing] bundle.getWallet failed` at `warn` and rethrows. Part A intentionally preserves today's failure behavior (acquisition is outside the `try`, and a fire-and-forget rejection can trigger shutdown). Do not call this safe internal recovery; Part B must move the timed acquisition inside the guard (§B3).

The `runWithLogContext` wrapper already puts `flow: "bundle"` and `userOpHashes` on every line logged inside it, so the new timing line identifies its bundle without extra fields.

### A4. `src/executor/executorManager.ts` – time the pass and detect late ticks

Add two constants next to `SCALE_FACTOR` / `RPM_WINDOW` (l.26–27):

```ts
// Pass timing is logged for every pass that produced a bundle; an empty pass
// is logged only when it took at least this long, so idle ticks stay quiet.
const EMPTY_PASS_LOG_THRESHOLD_MS = 50
// Log timer-callback lateness. A slow previous pass delays timer arming
// and is measured by passMs, not by this threshold.
const TICK_LATE_LOG_THRESHOLD_MS = 50
```

Change the method signature to `async autoScalingBundling(tickDueAt?: number)`. Only its timer supplies this monotonic due time; constructor/manual-to-auto calls omit it. Capturing the due time in the timer callback avoids stale shared state across mode changes. Do not add `nextTickDueAt` as a field or change timer cadence/lifecycle.

Replace the body of the `runWithLogContext` callback in `autoScalingBundling` (l.143–187) with:

```ts
            if (tickDueAt !== undefined) {
                const lateMs = performance.now() - tickDueAt
                if (lateMs >= TICK_LATE_LOG_THRESHOLD_MS) {
                    this.logger.info(
                        { step: "bundling.tickLate", lateMs },
                        "[timing] bundling.tickLate"
                    )
                }
            }

            const now = Date.now()
            this.opsCount = this.opsCount.filter(
                (timestamp) => now - timestamp < RPM_WINDOW
            )

            // Bounded per entry point so a deep queue cannot hold the whole
            // tick. Every bundle beyond the wallet count only queues for a
            // wallet with its ops parked in processing, so the wallet count
            // is the ceiling and max-bundle-count can only lower it. Without
            // a bound, sustained arrivals keep getBundles() from ever
            // returning and nothing gets submitted.
            const walletCount = this.senderManager.getAllWallets().length
            const bundleBudget = Math.max(
                1,
                Math.min(this.config.maxBundleCount ?? walletCount, walletCount)
            )

            const passStart = performance.now()
            let bundles: UserOperationBundle[]
            try {
                bundles = await this.mempool.getBundles(bundleBudget)
            } catch (err) {
                this.logger.warn(
                    {
                        step: "bundling.getBundles",
                        ms: Number((performance.now() - passStart).toFixed(2)),
                        bundleBudget,
                        err: err instanceof Error ? err.message : String(err)
                    },
                    "[timing] bundling.getBundles failed"
                )
                throw err
            }
            const passMs = Number((performance.now() - passStart).toFixed(2))

            const userOpCount = bundles.reduce(
                (sum, bundle) => sum + bundle.userOps.length,
                0
            )
            if (
                bundles.length > 0 ||
                passMs >= EMPTY_PASS_LOG_THRESHOLD_MS
            ) {
                this.logger.info(
                    {
                        step: "bundling.getBundles",
                        ms: passMs,
                        bundleBudget,
                        bundleCount: bundles.length,
                        userOpCount
                    },
                    "[timing] bundling.getBundles"
                )
            }

            if (bundles.length > 0) {
                // Count total ops and add timestamps
                this.opsCount.push(...new Array(userOpCount).fill(Date.now()))
            }

            // Send bundles to executor
            for (const bundle of bundles) {
                this.sendBundleToExecutor(bundle)
            }

            const rpm = this.opsCount.length

            // Calculate next interval with linear scaling
            const nextInterval: number = Math.min(
                this.config.minBundleInterval + rpm * SCALE_FACTOR, // Linear scaling
                this.config.maxBundleInterval // Cap at configured max interval
            )

            if (this.bundlingMode === "auto") {
                const dueAt = performance.now() + nextInterval
                setTimeout(
                    () => this.autoScalingBundling(dueAt),
                    nextInterval
                )
            }
```

Apart from the optional method parameter, everything outside the quoted block (the `runWithLogContext({ flow: "bundling" }, …)` wrapper and its comment) stays as it is. `performance` is the Node global already used by `timed`. A failure line has no complete counts; distinguish it from successful pass samples. Neither this change nor Part B adds a global wallet-waiter limit or prevents pre-existing overlapping loops caused by repeated mode-switch calls.

### A5. `src/executor/bundleManager.ts` + new `src/executor/inclusionTimings.ts` – the breakdown

Create `src/executor/inclusionTimings.ts`:

```ts
import type { UserOpInfo } from "@alto/types"

export type InclusionTimings = {
    inclusionTimeMs: number
    totalMs: number
    validationMs: number | undefined
    outstandingMs: number | undefined
    processingMs: number | undefined
    submittedMs: number | undefined
    bundleBuildMs: number | undefined
    handOffMs: number | undefined
    walletWaitMs: number | undefined
    submissionMs: number | undefined
}

// Stage durations for the inclusion log. The first six are the existing
// fields, moved here unchanged. The last four split processingMs
// (processingAt -> submittedAt) into adjacent stages that sum to it exactly;
// they are emitted only when every stamp is present and in order, so a
// re-picked or rotated record never reports a negative stage.
export function computeInclusionTimings(
    userOpInfo: UserOpInfo,
    blockReceivedTimestamp: number
): InclusionTimings {
    const {
        receivedAt,
        addedToMempool,
        processingAt,
        bundledAt,
        dispatchedAt,
        walletAcquiredAt,
        submittedAt,
        reentered
    } = userOpInfo

    const inclusionTimeMs = blockReceivedTimestamp - addedToMempool
    // totalMs spans the op's whole life (receivedAt survives resubmission);
    // validationMs is suppressed for reentered records, whose restamped
    // addedToMempool would make the delta span the entire prior cycle.
    const totalMs = blockReceivedTimestamp - (receivedAt ?? addedToMempool)

    const hasBreakdown =
        processingAt !== undefined &&
        processingAt !== 0 &&
        bundledAt !== undefined &&
        dispatchedAt !== undefined &&
        walletAcquiredAt !== undefined &&
        submittedAt !== undefined &&
        submittedAt !== 0 &&
        processingAt <= bundledAt &&
        bundledAt <= dispatchedAt &&
        dispatchedAt <= walletAcquiredAt &&
        walletAcquiredAt <= submittedAt

    return {
        inclusionTimeMs,
        totalMs,
        validationMs:
            receivedAt && !reentered ? addedToMempool - receivedAt : undefined,
        outstandingMs: processingAt ? processingAt - addedToMempool : undefined,
        processingMs:
            processingAt && submittedAt ? submittedAt - processingAt : undefined,
        submittedMs: submittedAt
            ? blockReceivedTimestamp - submittedAt
            : undefined,
        bundleBuildMs: hasBreakdown ? bundledAt - processingAt : undefined,
        handOffMs: hasBreakdown ? dispatchedAt - bundledAt : undefined,
        walletWaitMs: hasBreakdown
            ? walletAcquiredAt - dispatchedAt
            : undefined,
        submissionMs: hasBreakdown ? submittedAt - walletAcquiredAt : undefined
    }
}
```

The six existing expressions are copied verbatim from `bundleManager.ts:283–307` (truthiness checks included) so their output is byte-for-byte what it is today. Biome may reflow the formatting; keep the expressions.

In `bundleManager.ts`, `processIncludedUserOp` (l.270–310) currently destructures the stamps and builds the log object inline. Replace l.279–310 with:

```ts
        const { userOpHash, userOp, submissionAttempts } = userOpInfo

        const timings = computeInclusionTimings(
            userOpInfo,
            blockReceivedTimestamp
        )
        const { inclusionTimeMs, totalMs } = timings
        this.logger.info(
            {
                userOpHash,
                transactionHash,
                ...timings,
                submissionAttempts
            },
            `userOp ${userOpHash} included in tx ${transactionHash} after ${totalMs}ms (${submissionAttempts} submission attempts)`
        )
```

Add the import `import { computeInclusionTimings } from "./inclusionTimings"`. Keep `userOp` destructured only if it is used further down in the function (it is used today; check before removing). `inclusionTimeMs` is still used at l.340 (`inclusionTimeMs / 1000`); keep that line unchanged. Pino drops `undefined` values, so the emitted line has exactly the fields it has today plus the four new ones when present.

## 6. Part B – hand bundles over as they are built

### B1. `src/mempool/mempool.ts`

**`getBundles` (l.749):**

```ts
    public async getBundles(
        maxBundleCount?: number,
        onBundle?: (bundle: UserOperationBundle) => void
    ): Promise<UserOperationBundle[]> {
        const bundlePromises = this.config.entrypoints.map(
            async (entryPoint) => {
                return await this.process({
                    entryPoint,
                    maxGasLimit: this.config.maxGasPerBundle,
                    minOpsPerBundle: 1,
                    maxBundleCount,
                    onBundle
                })
            }
        )
        …unchanged…
```

**`process` signature (l.770–780):** add `onBundle?: (bundle: UserOperationBundle) => void` to both the destructured parameter and its type.

**Hand-over point.** In the block from A2, after the `slotsInPriorBundles` loop and inside the same `if`, add:

```ts
                    // Hand the bundle over now, while the pass goes on to the
                    // next one, so its executor work (wallet, gas, simulate,
                    // broadcast) does not wait for the rest of the pass. The
                    // callback owns the bundle on normal return. A callback
                    // may throw only before accepting ownership. Requeue that
                    // bundle and let the existing finally restore the carry.
                    // Async executor recovery belongs to sendBundleToExecutor.
                    if (onBundle) {
                        try {
                            onBundle(currentBundle)
                        } catch (err) {
                            this.logger.error(
                                {
                                    err,
                                    userOpHashes: currentBundle.userOps.map(
                                        (userOpInfo) => userOpInfo.userOpHash
                                    )
                                },
                                "onBundle callback threw"
                            )
                            await this.resubmitUserOps({
                                entryPoint,
                                userOps: currentBundle.userOps,
                                reason: "bundle_handoff_failed"
                            })
                            throw err
                        }
                    }
```

Order inside the `if` is therefore: stamp `bundledAt` → `bundles.push` → update `slotsInPriorBundles` → `onBundle`. The callback runs before the outer loop's next `await`.

Update the comment on `slotsInPriorBundles` (l.797–802) to say dispatch/execution can overlap across bundles; keep the same guard. Callback return must not await wallet acquisition, submission or recovery. A failed recovery write must surface as a failure, not be counted as a successful hand-over.

### B2. `src/executor/executorManager.ts` – the tick

In the A4 block, replace:

```ts
                bundles = await this.mempool.getBundles(bundleBudget)
```

inside the A4 `try` with:

```ts
                // Each completed bundle starts executor work immediately.
                // The returned array supplies counts, never a second dispatch.
                bundles = await this.mempool.getBundles(
                    bundleBudget,
                    (bundle) => {
                        void this.sendBundleToExecutor(bundle)
                    }
                )
```

and delete:

```ts
            // Send bundles to executor
            for (const bundle of bundles) {
                this.sendBundleToExecutor(bundle)
            }
```

Nothing else in the tick changes. The `[timing] bundling.getBundles` line now measures a pass whose bundles are already in flight; CPU/event-loop contention with executor work can change `passMs`. `void` documents deliberate non-awaiting; it does not handle a rejection. B3 is required before this is ready to ship.

### B3. `src/executor/executorManager.ts` – own wallet-acquisition failure

Inside `sendBundleToExecutor`'s `runWithLogContext` callback:

- Declare `let acquiredWallet: Account | undefined` and `let bundleSubmitted = false` before `try`.
- Move the timed `const wallet = await getWallet` call **and** `walletAcquiredAt` stamping into that `try`. Set `acquiredWallet = wallet` immediately after acquisition, before stamping. Keep the existing non-optional `const wallet` for the success path and RPC closures; keep `dispatchedAt` at method entry.
- In the existing catch log use `executor: acquiredWallet?.address`. If `!bundleSubmitted`, release `acquiredWallet` only when defined, then invoke the existing `resubmitUserOps` recovery for the original `userOps` even when acquisition failed. Keep the existing recovery-error logging and return `undefined`.
- Preserve the submitted/tracked ownership check: never requeue a bundle already tracked. Preserve known failure handling and first-stamp semantics.

This is a narrowly scoped behavior change in Part B, shared by auto dispatch, debug/instant RPC dispatch and rotation. Do not change sender-manager APIs or add recovery in the automatic callback: one recovery owner prevents double requeue. Add the failure regression in §7.4; successful-path timing tests alone cannot prove this boundary.

## 7. Tests

For implementation, run `pnpm test:unit` from the repo root (Vitest, files under `src/**/*.test.ts`), `pnpm exec tsc --noEmit -p src/tsconfig.json`, and `pnpm lint` (Biome). Record any pre-existing failures separately; add no new failures/warnings. Format only changed TypeScript files with `pnpm exec biome format --write <files>`; avoid repository-wide rewrites. `pnpm test` (e2e) needs Anvil and is not required for this change. Documentation-only review uses source/probe validation and `git diff --cached --check`, not the implementation acceptance suite.

### 7.1 New: `src/executor/inclusionTimings.test.ts` (Part A)

Fixture: `addedToMempool: 1000, receivedAt: 900, processingAt: 1100, bundledAt: 1130, dispatchedAt: 1190, walletAcquiredAt: 1290, submittedAt: 1500`, `submissionAttempts: 0`, any `userOp`/`userOpHash`; `blockReceivedTimestamp = 1760`.

1. **Full breakdown:** `validationMs 100, outstandingMs 100, processingMs 400, submittedMs 260, bundleBuildMs 30, handOffMs 60, walletWaitMs 100, submissionMs 210, inclusionTimeMs 760, totalMs 860`. Assert `bundleBuildMs + handOffMs + walletWaitMs + submissionMs === processingMs`.
2. **Missing one new stamp** (delete `dispatchedAt`): the four breakdown fields are `undefined`; the six existing fields are unchanged from case 1.
3. **Out of order** (`walletAcquiredAt: 1150`, before `dispatchedAt`): the four breakdown fields are `undefined`; the six existing fields are unchanged.
4. **Reentered** (`reentered: true`): `validationMs` is `undefined`; everything else as case 1.
5. **No `receivedAt`:** `validationMs` `undefined`, `totalMs === inclusionTimeMs`.
6. **Legacy record** (only `addedToMempool` and `submissionAttempts`): `outstandingMs`, `processingMs`, `submittedMs` and the four new fields are `undefined`; `inclusionTimeMs` and `totalMs` are computed.

### 7.2 `src/mempool/mempool.test.ts` (Parts A and B)

Use the existing harness (`makeHarness`, `seedOutstanding`, `sevenGasOps`, `bundleIds`, `outstandingIds`, `silentLogger`, `storeSpies`). `sevenGasOps()` packs as `[[1,2,3],[4,5,6],[7]]` (see T1).

Part A:

7. **`bundledAt` stamped per bundle.** `vi.spyOn(Date, "now")` returning `2000, 2001, 2002, …` on successive calls. After `getBundles()`, every op in a bundle has the same `bundledAt`, `bundledAt >= processingAt` for each op, and the three bundles have strictly increasing `bundledAt`.
8. **Existing T6 metadata tests still pass** (`"processingAt" in restored` is `false` for the carried-back op; add `expect("bundledAt" in restored).toBe(false)` to T6-A).

Part B (new `describe("Mempool.getBundles onBundle")`):

9. **Called once per bundle, in order, with the same objects.** `getBundles(undefined, onBundle)` on `sevenGasOps()`: `onBundle` called 3 times; `bundleIds(calls) === [[1,2,3],[4,5,6],[7]]`; `calls[i] === returned[i]` (identity).
10. **Called before the pass packs the next bundle.** Inside `onBundle`, record `storeSpies.addProcessing.mock.calls.length`. At call 1 it is 3, at call 2 it is 6, at call 3 it is 7.
11. **Called before the budget exit's write-back.** `getBundles(1, onBundle)`: `onBundle` called once with `[1,2,3]`; at that moment `storeSpies.addOutstanding` has not been called; after return it has been called once (the carried op 4 written back, as T5 already asserts).
12. **A callback that throws before accepting ownership fails visibly.** Throw on the first bundle and spy on/stub `resubmitUserOps`. Assert one error line, one recovery call for that bundle, propagation of the error, no further callbacks, and exactly one carry write-back for op 4. A recovery rejection must also surface. Do not test for silent continuation or assume the returned array can rescue failed hand-overs.
13. **Not called on an empty queue.** `getBundles(undefined, onBundle)` with nothing seeded: `[]` returned, `onBundle` not called.
14. **Existing packing tests still pass without a callback.** Add these streaming regressions:

    - **Overlap:** block packing of bundle 2 with a deferred promise; bundle 1's callback must already have run while `getBundles` remains pending. Resolve the gate and assert one callback per completed bundle. No real sleeps.
    - **Two entry points:** hold the first configured entry point while the second finishes. The second callback fires first; returned array still lists the first entry point first. Assert per-entry-point budgets and identity by bundle, not by global array index.
    - **Mid-pass reentry:** from the first callback, arrange for one emitted hash to be written back and popped again before the pass ends. Assert no second callback for that hash in this pass, `reentered` is retained and the op remains outstanding once. Exercise a serialized copy as well as an in-memory record.
    - **Nonce guard:** streaming still returns a same-sender/nonce-key successor to outstanding without dispatching it in a second bundle of the pass.
    - **Later packing failure:** after one callback, reject subsequent packing; the already handed bundle is not requeued or sent again, and the carried op is restored exactly once. Assert the error still propagates. With two entry points, also reject one while the other is gated; releasing the sibling may still dispatch its bundle after `getBundles` rejects, with no duplicate dispatch/recovery.

Tests 9–11 use one entry point. Snapshot arrays/counts inside the callback; retaining only an object reference can hide later mutation. The callback must not mutate bundle membership.

### 7.3 `src/executor/executorManager.test.ts`

**`makeTick` (l.562):** add `logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }` to the stub and expose it. Update `AutoScalingBundling` to `(tickDueAt?: number) => Promise<void>`; expose the real prototype method on stubs used to fire timer callbacks. Restore spies/timers in `afterEach`/`finally` (this file currently has only `beforeEach` cleanup).

Part A:

15. **Pass timing logged with counts.** `getBundles` resolves `[{ userOps: [{}] }, { userOps: [{}, {}] }]`. After the tick, `logger.info` was called with an object matching `{ step: "bundling.getBundles", bundleBudget: 10, bundleCount: 2, userOpCount: 3, ms: expect.any(Number) }` and message `"[timing] bundling.getBundles"`.
16. **Quiet when the pass is empty and fast.** `getBundles` resolves `[]`: no `logger.info` call with `step: "bundling.getBundles"`.
17. **Logged when an empty pass is slow.** `vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(80)` (two calls: start and end); `getBundles` resolves `[]`: logged with `bundleCount: 0` and `ms: 80`.
18. **Late timer logged.** Fix `performance.now()` at 1000 and call the method with `tickDueAt = 880`: assert `{ step: "bundling.tickLate", lateMs: 120 }` and message `"[timing] bundling.tickLate"`. Moving `Date.now()` alone must not change lateness.
19. **On-time/direct tick quiet.** Lateness below 50ms produces no line; a direct call without `tickDueAt` produces none. Test threshold boundaries (49ms quiet, 50ms logged) and an initial/manual-to-auto call after a long pause without a stale due time.
20. **Next due time captured in auto mode.** Use fake timers and a controlled monotonic clock; config `minBundleInterval: 100, maxBundleInterval: 100`. A 500ms pass arms its timer for 100ms after completion, not after the previous tick's start. Invoke the captured callback on time: no lateness line. Manual mode arms no timer. Restore all timers/spies after the test.
21. **`opsCount` still counts every op:** with the case-15 bundles, `manager.opsCount.length === 3`. Also reject `getBundles`: assert one failure timing with the original error and elapsed duration, no successful counts line, and rejection preserved.

Part B (update the five existing `autoScalingBundling` tests, l.580–637):

22. The four budget tests change `toHaveBeenCalledWith(10)` / `(4)` / `(1)` to `toHaveBeenCalledWith(10, expect.any(Function))` etc.
23. Replace **"hands every returned bundle to the executor"** with **"hands each bundle to the executor as the pass reports it"**:
    ```ts
    getBundles.mockImplementation(async (_budget, onBundle) => {
        onBundle(bundleA)
        await Promise.resolve()
        expect(sendBundleToExecutor).toHaveBeenCalledTimes(1)
        onBundle(bundleB)
        return [bundleA, bundleB]
    })
    ```
    After the tick: `sendBundleToExecutor.mock.calls.map(([b]) => b)` equals `[bundleA, bundleB]` and `toHaveBeenCalledTimes(2)` (no second dispatch from the returned array).

### 7.4 New: `sendBundleToExecutor` stamps and failure handling (Parts A/B), in `src/executor/executorManager.test.ts`

Call the prototype method on a stub, as the `autoScalingBundling` tests do:

```ts
const sendBundleToExecutor = (
    ExecutorManager.prototype as unknown as {
        sendBundleToExecutor: (bundle: unknown) => Promise<unknown>
    }
).sendBundleToExecutor
```

Stub fields the method reaches: `logger` (info/warn/error `vi.fn()`), `senderManager.getWallet` (resolves `{ address: "0xexecutor" }`), `senderManager.markWalletProcessed`, `gasPriceManager.tryGetNetworkGasPrice` (resolves `{ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }`), `config.legacyTransactions: true` (so `getBaseFee` returns `0n` without reaching `gasPriceManager.getBaseFee`), `config.publicClient.getTransactionCount` (resolves `0`), `executor.bundle` (resolves `{ success: true, userOpsBundled: <the same userOp objects>, rejectedUserOps: [], transactionRequest: {}, transactionHash: "0xtx" }`), `bundleManager.trackBundle: vi.fn()`, `startWatchingBlocks: vi.fn()`, `mempool.markUserOpsAsSubmitted: vi.fn()`, `mempool.dropUserOps: vi.fn()`, `metrics.bundlesSubmitted.labels: () => ({ inc: vi.fn() })`, and `getBaseFee: ExecutorManager.prototype.getBaseFee`.

Bundle: `{ entryPoint: "0xep", version: "0.6", submissionAttempts: 0, userOps: [{ userOpHash: "0xa", …minimal }, { userOpHash: "0xb", … }] }`.

24. **Stamps set in order.** Control `Date.now()` and hold `getWallet` on a deferred promise. Before releasing it, assert dispatch stamps exist and wallet stamps do not. Release it with a later time, then assert `dispatchedAt <= walletAcquiredAt` and common stamps for both ops. Use valid typed operation/address fixtures from existing tests; avoid real sleeps.
25. **First value wins.** Pre-set `userOps[0].dispatchedAt = 1` and `walletAcquiredAt = 2`; after the call they are still `1` and `2`, while `userOps[1]` got fresh stamps.
26. **Wallet wait is timed.** `logger.info` was called with an object matching `{ step: "bundle.getWallet", entryPoint: "0xep", bundleSize: 2, ms: expect.any(Number) }` and message `"[timing] bundle.getWallet"`.
27. **Empty bundle untouched.** `userOps: []` returns `undefined` without calling `getWallet` or stamping anything.
28. **Submission propagation (Part A).** Capture the bundle passed to `trackBundle` and ops passed to `markUserOpsAsSubmitted`; verify all new stamps survive the executor's copy/increment of `submissionAttempts`. Reproduce the real submitted-stamp behavior or invoke the real method on a store stub. Confirm the ordered stages sum to `processingMs`. Test that requeue via `mempool.add` starts fresh while retaining `receivedAt`, and that a rotation preserves the old successful chain.
29. **Wallet rejection (Part A versus B).** Reject `getWallet`. Part A must log the failed timing and retain its rejection behavior. Part B must resolve `undefined`, log the failure, requeue exactly once, never release an unacquired wallet and never start gas lookup/execution. In Part B, invoke through the real streaming callback as well as directly; assert no unhandled rejection. Include a later pre-submit failure with an acquired wallet and a post-track failure: one release/requeue for the former, none for the latter.

For §7.1 also test each missing stamp, equal adjacent timestamps, each reversed boundary, and a legacy rotated record whose new executor stamps follow an old `submittedAt`; the latter must omit all four new fields. Keep existing truthiness behavior at timestamp zero; do not accidentally emit a new breakdown when legacy `processingMs` is absent. Add a schema/serialization round-trip for all three new stamps and a legacy record with them absent; reuse valid operation fixtures.

## 8. Verification after deploy

Historical query coordinates supplied with this spec: BetterStack source 1169629 (`t187081_ultra_relay_base_prod_s3` / `_logs`), hostnames `srv-d9obrkvlk1mc73897rvg-%`. Verify the live source, chain/service, hosts, revision and pod coverage before reuse. The checked-in Ostium deployment is Kubernetes/Arbitrum and has two entry points; the historical hostname filter is not sufficient evidence that the same population is being measured. Do not compare different deployments as if only Part B changed.

Use matched weekday burst windows (reported as 19:56–20:00 UTC in September), traffic volume/mix, configured caps, active entry points, wallet/replica count and node provider. Recheck the traffic schedule after daylight-saving changes; do not encode the reported seasonal UTC shift as an invariant. Attach the query and sample counts to the rollout report. Use Part A immediately before Part B as the primary comparison; §2.3 is historical context, not a latency acceptance threshold.

After **Part A** (at least one representative burst on current dispatch behavior):

1. **Coverage and selection.** Count all included ops, ops with `processingMs`, and ops with all four new fields, grouped by deployment/host and entry point where attributable. Report missing breakdowns separately (legacy, instant path, retries/rotation, inconsistent clocks). Report failures/drops/requeues alongside included successes; inclusion-only samples exclude operations still stuck or dropped. Separate first-submission and retry populations using `submissionAttempts` and correlated logs; do not assume it counts all lifetime retries after `resubmitUserOps` resets the record.
2. **Stage split.** Compute p50/p95/max of `bundleBuildMs`, `handOffMs`, `walletWaitMs`, `submissionMs` on the same eligible cohort. Assert their row-wise sum equals `processingMs`. Never add/subtract independent p50/p95 values. Report the fraction of eligible ops with `handOffMs >= 50` and with `walletWaitMs >= 100`, including their processing tails.
3. **Pass length.** From successful `[timing] bundling.getBundles` lines, report duration and bundle/op counts; count failed lines separately. `passMs` starts before an op's `processingAt`, may include other entry points and uses a different clock. Do not expect it to equal `bundleBuildMs + handOffMs`; compare trends, not equality or unrelated percentiles.
4. **Wallet acquisition.** Compare per-call `bundle.getWallet` timings and per-op `walletWaitMs`. The former weights bundles/attempts; the latter weights included ops, so percentiles need not match. Correlate long waits with existing Redis pool/slow-store and block-reconciliation logs. Approximate 100ms steps support contention; free-wallet Redis latency is measured, not assumed to be 1–5ms.
5. **Timer delay.** Count `bundling.tickLate` and max `lateMs`. This measures delay after arming; a long preceding pass increases start-to-start cadence without necessarily producing any late line. Correlate with `handleBlock` timings without declaring it the cause from coincidence alone.
6. **Other stages/regressions.** Correlate large `submissionMs` with pre-bundle RPC, `filterOps`, send and store-removal timings where available. Compare `outstandingMs`, `totalMs` (original request to observed inclusion), inclusion/error/drop rates and bundle sizes. Keep `inclusionTimeMs` separate for reentered records because `addedToMempool` resets.

**Decision gate for Part B:** proceed only if complete-chain coverage is representative and the pass barrier is material. Proposed rollout trigger: at least 50% of eligible burst ops have `handOffMs >= 50ms`, with eligible counts/coverage and tails recorded. This is a decision threshold, not proof of the whole Sep 23 regression; adjust it explicitly in the rollout report if workload requirements differ. If wallet/submission stages dominate and hand-over is small, retain Part A and investigate those costs instead. Do not infer that adding wallets or dividing budgets will help without measuring throughput and held-wallet time.

After **Part B**:

7. `handOffMs` p50 should be near 0–5ms. If not, investigate callback scheduling/logging. Success also requires no material regression in matched `totalMs` p50/p95, `outstandingMs`, error/drop/requeue rates or queue drain. The old 300–330ms processing median and 742ms inclusion median are reference values, not promises.
8. Compare **all four** stage distributions and coverage: earlier dispatch can change `walletWaitMs`, packing cost and RPC contention. A lower hand-over duration alone does not establish end-to-end improvement.
9. Preserve configured caps, exactly-once hand-over per built bundle, per-entry-point budgets and within-pass nonce guards. Do not require exact bundle counts or a universal maximum of three ops: caps depend on gas/bytes and operation mix. Check matched distributions and conservation instead.
10. No `onBundle callback threw`, new unhandled rejections or stranded processing records in the observed window. Any such event, duplicate hand-over, lost operation or material end-to-end regression blocks promotion and triggers reverting Part B. Confirm earlier handed bundles still have an owner if a later pass fails.

## 9. Rollout

- Part A first, as its own change. Preserve successful dispatch and existing failure behavior, apart from new logs/stamps. Observe at least one representative weekday burst; if coverage or traffic is inadequate, collect more before drawing a conclusion.
- Part B is a second, explicitly requested change on top of Part A after the §8 decision gate. Include B3 wallet-failure recovery and streaming failure/overlap tests; do not ship the callback alone.
- No configuration changes. Revert Part B to restore batch dispatch while retaining Part A measurements. Reverting Part A removes the extra fields/logs; optional fields keep old records readable, but an older writer/parser can strip new fields, so mixed-version intervals are excluded from complete-chain comparisons.

## 10. Instructions for the implementer

- Validated checkout is already `feat/bundle_wait_flow` at `49d2db2`. Recheck branch/base and working-tree changes before implementation; do not switch branches, create a branch or discard user work merely because the original draft named another checkout.
- Implement Part A completely (code and its tests in §7), stage, and report. Do not pull B3's behavioral recovery change into instrumentation. Implement Part B, including B3 and its tests, only when asked on top of Part A.
- **Do not commit.** Stage changed files with `git add` and report what is staged; the user reviews and commits.
- Follow repo `AGENTS.md`/`CLAUDE.md` conventions: `pnpm`, Biome formatting (4-space indent, no semicolons, 80-column lines), Vitest, `userOp`/`userOpInfo` naming. Format changed TypeScript files only, then run §7 checks.
- Touch only the files named in §5–7. Do not reformat, rename or refactor neighbouring code. Do not change `debug_bundler_sendBundleNow`, `pimlico_sendUserOperationNow`, the sender managers, the store, or `metrics.ts`.
- No AI attribution anywhere (code comments, commit messages, PR text).
- If anything in the code contradicts this spec, stop and report it rather than guessing.

## 11. Implementation amendments (plan critique, Sep 24)

Adopted before implementing Part A. Where these differ from the snippets above, these win.

1. **A5 replacement range.** Replace the whole `this.logger.info(…)` statement in `processIncludedUserOp`. It ends at `bundleManager.ts:311`, not 310; replacing only l.279–310 leaves a stray `)`.
2. **A4 empty-pass threshold.** Compare the unrounded elapsed time with `EMPTY_PASS_LOG_THRESHOLD_MS`; round only the logged `ms`, so a 49.999ms empty pass stays quiet as D6 requires:

    ```ts
    const passElapsedMs = performance.now() - passStart
    const passMs = Number(passElapsedMs.toFixed(2))
    …
    if (bundles.length > 0 || passElapsedMs >= EMPTY_PASS_LOG_THRESHOLD_MS) {
    ```

    Add to §7.3: an empty pass of 49.999ms logs nothing; exactly 50ms logs.
3. **§7.2 case 7b – stale `bundledAt` is overwritten.** Seed a record that already carries an old `bundledAt`, run `getBundles()`, and assert it now holds the new bundle timestamp. Cases 7–8 alone would also pass with a wrong `??=` implementation (D3).
4. **§7.3 case 21 – failure-line assertion.** The failure line carries `err` as the message string (as `timed()` does). Assert `err: error.message` in the log object, and separately assert the tick rejects with the original error object.
5. **Note, no change.** `src/tsconfig.json` excludes test files, so `tsc --noEmit` does not typecheck test fixtures; Vitest does not either.
