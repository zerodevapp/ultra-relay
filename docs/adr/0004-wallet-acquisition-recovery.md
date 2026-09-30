# Wallet acquisition recovery

`sendBundleToExecutor` waits for an executor wallet, then prices, simulates and
broadcasts the bundle. Its recovery `try` frees the wallet and requeues the
userOps on any unexpected throw, but wallet acquisition ran before that `try`.
The bundling tick starts `sendBundleToExecutor` without awaiting it, so a
failed `getWallet` (such as a Redis error on the pop) escaped as an unhandled
rejection. That shuts the process down and left the bundle's userOps parked in
processing. We move acquisition inside the recovery guard.

## Acquisition inside the recovery guard

A failed acquisition frees nothing (no wallet was taken), requeues the userOps
once under the reason `wallet_acquisition_failed`, and resolves `undefined`.
The recovery lives in one place, `recoverFailedSend`, for every caller: the
tick, stuck-bundle rotation and the two RPC methods (which still turn
`undefined` into their existing errors). It always resolves, so no caller
needs recovery of its own and nothing is requeued twice.

`ultra_relay_user_operations_resubmitted_total` gains a `reason` label (every
reason is a fixed string), so a wallet pool that keeps failing shows up as a
steady `wallet_acquisition_failed` rate instead of a quiet requeue every tick.
Alert on it, for example:

```
sum by (instance) (
  rate(ultra_relay_user_operations_resubmitted_total{reason="wallet_acquisition_failed"}[5m])
) > 0
```

sustained for a few minutes.

## A wallet this instance does not own shuts the process down

*Superseded by ADR 0006: pods now leave other pods' wallets in the pool and never shut down for them.*

The Redis sender manager pops an address from the queue shared by all pods and
throws `WalletNotFoundError` when it is not one of this instance's keys. The
popped address is not pushed back, and the queue is only seeded at startup when
empty. Retrying that error every tick would discard one shared address per
attempt: during an executor-key rotation, with old and new pods overlapping on
one queue, the pool would empty within seconds, nothing would restart to
re-seed it, and every pod would wait for a wallet forever while health checks
still pass.

So for this error the userOps are requeued, then `recoverFailedSend` calls the
`requestShutdown` dependency, which `setupServer` wires to the existing
graceful shutdown. The restart re-seeds the queue. The request is explicit
rather than an unhandled rejection, so it works on every path: before this
change the RPC methods and stuck-bundle rotation caught the error, returned
or logged it, and never restarted. `ExecutorManager` requests the shutdown
once; later foreign pops during the shutdown are requeued the same way.

Every other acquisition failure, such as a Redis error on the pop (which
consumes no address), gets the recover-and-requeue behaviour above.

`resubmitUserOps` also catches and logs a failed drop of a userOp whose re-add
was refused; that drop was never awaited and could shut the process down.

## Known follow-ups

- *Startup and periodic membership repair and foreign-wallet handling: resolved
  by ADR 0006. Automatic recovery of in-use reservations and of Redis data loss
  remains deferred; retirement, uncertain checkouts and data loss require its
  runbooks.*
- **A failed requeue write can lose a userOp silently**: `resubmitUserOps`
  removes the processing/submitted records before re-adding, and the store
  logs and swallows a failed outstanding write. The fix must keep the userOp
  recoverable, not just rethrow.
- **The gas/nonce failure branch can release a wallet twice** if its requeue
  rejects; the second release can free a wallet another bundle has since
  acquired. Fresh Redis checkout handles (ADR 0006) stop that old release from
  freeing a newer checkout; the caller bug itself and the in-memory path remain
  follow-up work.
- **Other paths still end in an unhandled rejection**: a failed bundling pass
  stops the tick, `replaceTransaction` is launched without a catch, and block
  watcher failures are not consumed.
