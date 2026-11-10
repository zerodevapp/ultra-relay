# Inclusion stage timings

The inclusion log reports `processingMs`: the time from the bundling pass
picking a userOp to its bundle transaction being submitted. That one number
hides several very different waits: the rest of the bundling pass, the hand-off
to the executor, waiting for an executor wallet, and the gas/nonce lookups,
simulation and broadcast. When `processingMs` regressed during a traffic burst
there was no way to tell which of these had grown. We split it into stages,
logged on the existing inclusion line, without changing any behaviour.

## Stages

Three new optional timestamps on `UserOpInfo`, alongside the existing
`processingAt` and `submittedAt`:

```
processingAt ─ bundleBuildMs ─► bundledAt ─ handOffMs ─► dispatchedAt
             ─ walletWaitMs ─► walletAcquiredAt ─ submissionMs ─► submittedAt
```

- `bundledAt`: the userOp's bundle is complete in the bundling pass.
- `dispatchedAt`: `sendBundleToExecutor` receives the bundle.
- `walletAcquiredAt`: an executor wallet has been obtained.

The four stage durations are adjacent, so they sum exactly to `processingMs`.
`submissionMs` covers gas/nonce lookups, filtering, the send and the
processing-store removal; it is not raw broadcast latency.

## Decisions

**Report on the existing inclusion line, not new per-op lines.** The analysis
queries already read that line. The stage math lives in
`computeInclusionTimings`, a pure function, so the existing six fields are
unchanged and the new ones are directly testable.

**Emit the breakdown only for a complete, ordered chain.** All five stamps must
be present and in order (`processingAt ≤ bundledAt ≤ dispatchedAt ≤
walletAcquiredAt ≤ submittedAt`); otherwise the four stage fields are omitted.
We never clamp negative values or fill in missing stamps. Records written
before this change, the instant-bundling endpoint (which builds its bundle
directly) and wall-clock adjustments therefore report no breakdown rather than
a wrong one. Coverage is reported alongside any analysis.

**Which stamps are overwritten and which keep their first value.** Once a
userOp is placed in a bundle, that record never returns to the outstanding
queue: resubmission rebuilds it through `mempool.add` with fresh stamps
(keeping only `receivedAt`), skip/carry/conflict write-backs only touch records
that were never placed, and stuck-bundle rotation re-sends the same record. So
the stamps set at placement (`processingAt`, `bundledAt`) are simply assigned,
while `dispatchedAt`, `walletAcquiredAt` and `submittedAt` keep their first
value, so a rotated bundle keeps its original submission chain. Later
replacement or rotation attempts are visible in the per-call
`[timing] bundle.getWallet` lines, not in the breakdown. The rule is stated
once in the `userOpInfoSchema` comment.

**Two clocks.** Lifecycle stamps are epoch milliseconds (`Date.now()`), like the
existing ones, so they can be compared across the record's life. Call and
timer durations use the monotonic `performance.now()`.

**No extra store writes.** Stamps live on the in-memory records that flow
through the bundling pass and the executor. They are declared on the schema so
the Redis outstanding store's serialization keeps them, but nothing writes to
a store just to persist a timing.

## Pass and tick timing

- `[timing] bundling.getBundles` logs each bundling pass with its duration,
  budget, bundle count and userOp count. Passes run several times a second
  around the clock, so a pass that produced no bundle is logged only if it took
  at least 50ms. The threshold compares the unrounded duration; only the logged
  value is rounded. Failed passes always log a warning.
- `[timing] bundle.getWallet` times each wallet acquisition. On the Redis
  sender manager an empty pool retries every 100ms, so clusters near 100ms
  steps suggest wallet contention, though they do not prove it.
- `[timing] bundling.tickLate` logs when the tick's timer fires at least 50ms
  after it was due. Lateness is measured in the timer callback against a due
  time captured when the timer was armed, so manual or mode-switch calls are
  never measured. A long pass delays when the next timer is armed and shows up
  in the pass duration, not as lateness.

Logs only: no new Prometheus metrics.
