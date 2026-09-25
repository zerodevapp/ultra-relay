# Streaming bundle hand-off

Each bundling tick runs one pass: `mempool.getBundles` packs userOps into
bundles for every entry point concurrently. Before this change the tick waited
for the whole pass to finish and only then handed the bundles to the executor,
so a bundle that was complete early waited for every other bundle of the pass
(across all entry points). That wait lands in its userOps' `handOffMs` (see
ADR 0003). We now hand each bundle to the executor the moment it is built.

Rollout gate: deploy ADR 0003's stage timings first and enable this only if
a measured traffic burst shows the hand-off wait is material (at least half of
eligible burst userOps with `handOffMs >= 50ms`).

## Hand-over contract

`getBundles(maxBundleCount?, onBundle?)` calls `onBundle(bundle)`
synchronously the moment a bundle is complete, after it is recorded in the
pass's sender/nonce guard, then keeps packing. The contract:

- **The callback is synchronous and returns void.** The tick's callback starts
  `sendBundleToExecutor` without awaiting it. An async callback is not allowed:
  nothing would observe its rejection.
- **Normal return transfers ownership** of the bundle to the executor. The
  returned array is kept for callers without a callback and for counts; the
  tick never dispatches from it.
- **A callback may throw only before accepting ownership.** That bundle alone
  is requeued (`bundle_handoff_failed`) and the error propagates; the pass's
  existing cleanup restores its carried op. Bundles already handed over are
  never requeued or sent again, even if later packing fails.
- **Callers without a callback are unchanged.** `debug_bundler_sendBundleNow`
  still takes the returned bundle and sends it itself.

Consequences we accept:

- Dispatch order is completion order across entry points, not configured
  order. Per-entry-point order and budgets are unchanged.
- Executor work now overlaps packing. A handed-over bundle can be requeued,
  included or dropped while later bundles of the same pass are packed. If a
  requeued userOp is popped again in that pass, the existing repeat guard ends
  that entry point's pass early and the next tick picks it up. The same-pass
  sender/nonce guard still keeps one sender's nonce chain out of two bundles.
- `Promise.all` does not cancel sibling entry-point passes, so after
  `getBundles` rejects a sibling can still hand over a bundle. Its executor
  owns it as usual.

## Executor recovery

The tick's callback starts `sendBundleToExecutor` without awaiting it and adds
no recovery of its own. That is safe because `sendBundleToExecutor` recovers
every failure itself and always resolves, wallet acquisition included, and
requests the shutdown explicitly for a wallet this instance does not own (see
ADR 0004). Streaming makes that the normal dispatch path, so nothing is
requeued twice and no rejection is left unhandled.
