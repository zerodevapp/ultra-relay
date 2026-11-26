# Bounded resubmission

One bad user operation can keep a bundle failing forever. Every failed attempt
returns all of that bundle's user operations to outstanding, the builder packs
the same ones into the same bundle on the next tick, and nothing limits the
number of attempts. We bound this with a resubmit limit, we make the bundle
simulation run from an executor address so it matches the real transaction, and
we retry a failing user operation in isolation so it cannot take its
bundle-mates down with it.

## The incidents

- **ZER-1350 (Arbitrum Sepolia, Nov 24-25 2026).** A paymaster rejects any
  `tx.origin` (the sender of the transaction) that is not on its allowlist, but
  accepts an empty one so that gas estimation works. Our bundle simulation
  (`getFilterOpsResult`) passed no sender, so the user operation always passed
  simulation and always reverted on-chain. After each revert,
  `processRevertedBundle` re-simulated (still without a sender) and resubmitted
  it, about once a second. About 11,000 reverted bundles drained the only
  executor wallet and blocked every v0.7 user operation on that relay for about
  20 hours.
- **ZER-1010 (Polygon, Jul 9 2026).** About 52 valid user operations from 9
  projects stayed in the retry loop with one bad bundle-mate until the instance
  was redeployed four days later. The exact failure path is unknown because the
  logs had expired.

## Mirror-upstream policy

We mirror upstream Alto where we can, so that future merges stay small. We
diverge only where mirroring would break a goal of this change, and each
divergence is recorded below and in a code comment that says
`see ADR 0006`. The reference is pimlicolabs/alto `main` at a30e96b
(2026-11-20).

## Decisions

### D1. Count everything except our own infrastructure failures

A deny-list of resubmit reasons (`INFRASTRUCTURE_FAILURE_REASONS`, next to
`resubmitUserOps`) does not count toward the limit and does not trigger
isolation. Every other reason, including reasons added later, is a counted
failure.

| Resubmit site | Reason | Counts? |
|---|---|---|
| `sendBundleToExecutor`, nonce or fee fetch failed | `Failed to get nonce and gas parameters for bundling` | no |
| `recoverFailedSend`, no wallet acquired | `wallet_acquisition_failed` | no |
| `Executor.bundle` result | `insufficient_funds` | no |
| `Executor.bundle` result, send catch | `send_transport_error` | no |
| `rotateStuckBundle`, detach write failed | `stuck_bundle_detach_failed` | no |
| `Mempool.process`, `onBundle` threw | `bundle_handoff_failed` | no |
| `processRevertedBundle` | `sibling_op_reverted` | yes |
| `Executor.bundle` result | `generic_error` (execution rejections, and any other send error) | yes |
| `Executor.bundle` result | `oversized_bundle` | yes |
| `recoverFailedSend`, wallet acquired | `send_bundle_unexpected_error` | yes |

Why: the bundling tick runs every 100 ms to 1 s. A limit that counted our own
infrastructure failures would empty the queue during a two-second RPC outage,
and that would drop valid user operations because of our fault. Upstream
counts every reason, so this is a deliberate divergence.

Trade-off accepted: the nonce and fee fetch failure (ZER-1010 "path 1") stays
uncapped. It sends no transaction, burns no gas, and fails every bundle equally
instead of trapping specific user operations.

`send_transport_error` is returned when the send fails with a `TimeoutError`,
with an `HttpRequestError` that has no status (a network failure), a status of
500 or more, or a status of 408 or 429, or with a JSON-RPC rate-limit code
(429, `-32005` from `LimitExceededRpcError`, or QuickNode's `-32007`). These
are the same codes viem's own retry logic treats as transient. A rejected send
spends no gas, so counting a rate limit would only drop valid user operations.
Any other 4xx (for example a gateway 413) stays `generic_error` and counts, so
a deterministic rejection is still bounded.

`oversized_bundle` counts, because isolation re-packs the user operation and a
lone user operation over the cap is already dropped.

### D2. Isolation, plus a successor hold

A retried user operation (one popped from outstanding with
`submissionAttempts > 0`) is always bundled alone. In `Mempool.process`, if a
retried user operation meets a bundle that already has others, it is carried to
the next bundle and the current one closes. If it is accepted into an empty
bundle, the bundle closes right after it. So a non-retried user operation never
shares a bundle with a retried one. Upstream has neither isolation nor the
successor hold, so both are fork-only.

The literal `submissionAttempts > 0` test is used instead of a separate "has
failed" flag, to stay with the reused counter (M2). One consequence: a user
operation that was sent, then came back through an infrastructure failure, is
isolated even though that reason does not count. It already had trouble
on-chain, and isolation only costs it bundle sharing. A user operation that was
never sent and comes back through an infrastructure failure keeps 0 and is not
isolated.

Isolation alone creates a problem. Two user operations from one sender, with
nonces N and N+1, in one failed bundle would go out in separate bundles, and
N+1 could be simulated before N lands and be dropped as `AA25 invalid account
nonce`. So the builder also applies a successor hold.

**What the hold does.** Before bundling a user operation, the builder checks
whether its exact predecessor (same sender, same nonce key, sequence minus 1)
is still processing or submitted. If so, the user operation and every later
user operation of its nonce slot wait for a later tick. They are held, not
dropped.

**Scope.** The hold applies to every user operation whose nonce sequence is
above 0, not only retried ones. This was a user decision after the plan
critique. Three cases need it:

1. A failed bundle with N and N+1 splits under isolation (above).
2. A new N+1 that arrives while a retried N is isolated would otherwise go out
   on the next tick, before N lands, and be dropped as `AA25`.
3. Today, when a bundle cap splits one sender's chain across ticks, the later
   user operation is dropped as `AA25` in the same way. The hold fixes that too.

A sequence of 0 never triggers a lookup, because `nonce - 1` would wrap into
the previous nonce key.

**Cost.** One predecessor lookup per user operation taken from the queue whose
nonce sequence is above 0, unless its exact predecessor is in the bundle being
built. On Redis relays that is about one round trip, because the processing and
submitted lookups run in parallel and each is one script call. On memory relays
it is an in-memory scan of the in-flight user operations. When the lookup says
pending, there may also be a background on-chain read (see the chain-nonce check
below).

**Isolation at the bundle budget.** When a pass reaches its bundle budget
while a retried user operation is carried for isolation, the builder opens one
extra bundle for it (at most one extra per pass per entry point). The extra
bundle carries only the isolated user operation. If that user operation is held
or skipped instead of accepted, the pass ends, and no fresh user operations
enter the extra bundle. Why: review found that on a single-wallet relay the
budget is one bundle per pass, so the retried user operation was pushed back
every tick and never sent. Cost: the extra bundle waits for a wallet.

**How a pass behaves.**

- The lookup is the mempool-store method `hasPendingPredecessor`. Only a
  conflicting-nonce match counts. On Redis relays it also sees other pods'
  in-flight user operations.
- The lookup is skipped when the exact predecessor is in the bundle being
  built, so consecutive nonces still pack together. It must be the exact
  predecessor: nonce N can be back in outstanding while N+1 is still in
  processing, and N+2 must not join N's bundle in that case.
- If the lookup throws, the store logs the error and answers "pending", so the
  user operation is held and not lost, and the pass does not fail.
- Held user operations are set aside and written back to outstanding once, at
  the end of the pass (in the `finally`). Writing a held user operation back at
  once would let the store hand it back in the same pass, the repeat guard
  would end the pass, and a sender with a chain in flight could stall every
  other sender on every tick. Setting it aside also stops a later nonce of the
  same slot from slipping past.
- A pass holds at most 256 user operations (`MAX_HELD_USEROPS_PER_PASS`). On
  the next hold the pass ends, like the bundle budget, and the write-back runs.
  Held user operations make no bundles, so without this bound sustained
  arrivals in held slots could keep one pass running forever.

**Chain-nonce check (user decision after the Task 5 review, reworked after the
PR review).** When the store says the predecessor is pending,
`isPredecessorPending` consults the on-chain nonce,
`EntryPoint.getNonce(sender, nonceKey)` at `latest`. If the on-chain sequence is
at or past the candidate's sequence, the predecessor has landed and the
candidate is not held. Why: on multi-pod Redis relays, a deploy or crash leaves
orphaned processing and submitted entries, and they are evicted lazily, only
after 2 hours (processing) or 24 hours (submitted). Without the check, a
sender's next user operation could be held for up to 24 hours.

The read runs in the background, so a slow node cannot stall the pass:

- A cached answer answers at once. A "landed" answer (on-chain sequence at or
  past the candidate's) is honored for 60 seconds
  (`CHAIN_NONCE_LANDED_TTL_MS`). A "not landed" answer is honored for 1 second
  (`CHAIN_NONCE_CACHE_TTL_MS`) and then read again.
- With no usable cached answer, the candidate is held and a `getNonce` read
  starts without being awaited: at most one per nonce slot, and at most 16 in
  flight (`MAX_CONCURRENT_CHAIN_NONCE_READS`).
- The cache is bounded at 1,024 entries (`MAX_CHAIN_NONCE_CACHE_ENTRIES`).
- If a read fails, the candidate stays held.
- The release happens on a later pass, not the one that started the read.

Safety: the chain nonce only grows, except under a chain reorganization. A
stale "not landed" answer can therefore only hold a candidate longer. A stale
"landed" answer could release a user operation early only after a reorg, and
the cost is `AA25` at bundle simulation. Limit: with more than about 80 slots
held at once behind predecessors that are genuinely in flight, some slots may
wait for a read place.

**Known gaps, accepted.** A successor taken from the queue in any of these
windows escapes the hold:

- (a) While a bundle is marked submitted, each user operation leaves processing
  a few milliseconds before it enters submitted.
- (b) After an on-chain revert, `processRevertedBundle` removes the bundle's
  user operations from submitted before its re-simulation (100 ms or more).
  They return to outstanding only after that. This matters only right after the
  predecessor's own bundle reverted. Closing it would mean reworking how
  reverted bundles release their user operations.
- (c) A held user operation is in no store for the rest of its pass (a popped
  user operation is in no store during its pass), so its successor can be
  bundled. On multi-pod Redis relays another pod can do it. A single instance
  has the same window, but an identical resend is normally rejected `AA25` by
  ingress validation. A same-nonce replacement that arrives during the pass can
  also pass the conflict checks.
- (d) Stuck-bundle rotation detaches the predecessor from submitted for
  seconds before the replacement is broadcast, so a held successor can be
  released and then dropped `AA25`. This is not a regression versus `main`.

**Hold-cap starvation, accepted.** If 257 or more held successors sort ahead of
a runnable user operation, and their predecessors have not landed, every pass
ends at the hold cap before it reaches the runnable one. This needs about 26
senders with 10 queued successors each.

**Two supporting changes** make sure a predecessor still in outstanding always
comes out of the queue first, so it never needs a hold:

1. The memory outstanding store sorts each nonce slot's backlog by nonce
   sequence. `add` meant to do this but sorted a mapped copy and discarded the
   result, so the backlog stayed in insertion order. A resubmit that re-added
   N+1 before N would make N+1 the head. Upstream already sorts in place. The
   Redis store keeps a sorted set and is unaffected. This matters in
   production: the Arbitrum Sepolia relay runs the memory store.
2. `resubmitUserOps` re-adds the user operations of one nonce slot one at a
   time, in nonce order. Different slots still run in parallel. Before, all
   were re-added in parallel, and between leaving processing and entering
   outstanding a user operation is in no store, so N+1 could be re-added,
   popped and bundled while the hold could not see N.

### M1. Simulation sender: mirror upstream

The bundle simulation sets `account` to the first configured executor key,
through `getEthCallSender` in `senderManager/index.ts`, as upstream does since
pimlicolabs/alto#817. It is not the wallet that actually sends the bundle.
Both the normal bundling path and `processRevertedBundle` go through
`getFilterOpsResult`, so both pick it up.

Trade-off accepted: a paymaster that allowlists some but not all of our
executors would pass simulation from key 0 while a bundle from another key
reverts. Our pods share one key list, so allowlists cover all our executors or
none, and the limit and isolation bound the damage in the remaining case. Key 0
is always a wallet this pod can send from: the sender manager trims the list to
`maxExecutors` from the front. An empty key list can only come from a config
file (the CLI flag is required and its comma-separated form needs at least one
key); the bundler logs a warning at startup in that case, because no bundle
can be sent and simulation would run without a sender.

### M2. The counter: mirror upstream

We reuse the per-user-operation `submissionAttempts` field, as upstream's
`max-resubmits` (pimlicolabs/alto#617) does, instead of adding a field. It
keeps its increments (+1 on each successful send, +1 on each replacement) and
is now carried forward through `resubmitUserOps`; before, `mempool.add` reset
it to 0. A counted resubmit checks first, then increments: if
`submissionAttempts >= maxResubmits` the user operation is dropped, otherwise
it is re-added with `submissionAttempts + 1`. An infrastructure-failure
resubmit carries the value unchanged and never drops.

Side effect, also upstream behavior: the inclusion log line and the
`userOperationsSubmissionAttempts` histogram now show the total across retry
cycles instead of the count since the last re-add.

### M3. The flag: mirror upstream's name

`--max-resubmits`, as upstream, in the executor options group next to
`max-stuck-attempts-before-rotation` (as upstream does). It is an integer with
a minimum of 0; 0 drops a user operation at its first counted failure.
Divergence: the default is 7, where upstream's is unset (unlimited), as
ZER-1010 asks for a bound. It sits just above a full stuck-bundle cycle: 1 send,
4 fee bumps and 1 rotation send make 6 attempts with the default
`max-stuck-attempts-before-rotation` of 5, so a user operation that went
through that cycle still gets one retry before the limit drops it. We keep
upstream's single counter rather than adding a separate failure counter, to
keep the diff against upstream small so later upstream merges stay easy; the
higher default is how we absorb fee bumps instead. The help text states that
only counted failures count and that the value should stay above
`max-stuck-attempts-before-rotation` + 1.

### M4. The drop metric: mirror upstream

`ultra_relay_user_operations_dropped_total{reason}` (upstream:
`alto_user_operations_dropped_total`) is incremented in `dropUserOps` for every
dropped user operation, not only limit drops. The fork had no drop metric.

Divergence: upstream labels it with the raw reason. Our drop reasons can carry
decoded revert data, which would give an unbounded set of label values.
`dropReasonLabel` normalizes it: `MAX_RESUBMITS_REASON` (`max resubmits
reached`, upstream's exact string) as is; otherwise the AA error code from
`getAAError`, such as `AA25` or `AA33`; otherwise `other`. The full reason
stays in the drop log line. Each relay serves one chain, so there is no `chain`
label. The drop emits the existing `dropped` event and the client status
`rejected`, as upstream does; ZER-1010's suggested `failed_onchain` is not used.

## Mirror and diverge

| Area | Upstream | Ours | Why |
|---|---|---|---|
| Simulation sender | first executor key (#817) | mirrored, no `version` parameter | our fork has one key list |
| Counter | reuse `submissionAttempts`, check then increment (#617) | mirrored | smaller merge surface |
| Flag name | `max-resubmits` | mirrored | |
| Drop reason string | `max resubmits reached` | mirrored | |
| Drop counter | generic, in `dropUserOps` | mirrored | |
| Flag default | unset (unlimited) | 7 | ZER-1010 asks for a bound; above a full stuck-bundle cycle |
| Failures counted | every reason | all but infrastructure failures | valid user operations must survive our own outage |
| Isolation | none | retried user operations go alone | one bad user operation must not fail its bundle-mates |
| Successor hold | none | every nonce sequence above 0 | isolation would otherwise cause `AA25` drops |
| Isolation at the budget | none | one extra bundle per pass for an isolated carry | a single-wallet relay would never send it |
| Re-add order | parallel | nonce order per nonce slot | the hold cannot see a user operation in no store |
| Metric label | raw reason | AA code, limit reason or `other` | bounded label set |

## Worked numbers for the default of 7

Submission attempts is "sends + replacements + counted failures", not a plain
attempt count, so the limit acts earlier than 7 tries.

- **Reverts on-chain every time:** each send adds 1 and each revert resubmit
  adds 1, so the reverts happen at 1, 3, 5 and 7; the fourth revert sees
  7 >= 7 and drops. Dropped at the fourth on-chain revert.
- **Send rejected every time (`generic_error`, no successful send):** 0, 1, …,
  6, then the eighth rejection sees 7 >= 7 and drops. Dropped at the eighth
  rejection. Transport failures and rate limits never count.
- **Stuck, then replaced:** a full stuck-bundle cycle (send, 4 fee bumps,
  rotation send) reaches 6. The first counted failure after it re-adds at 7
  and the user operation gets one isolated retry; a second counted failure
  drops it.

## Relationship to ADR 0001

ADR 0001's rule that guardrails must never reject or drop a valid user
operation covers the bundle-cap guardrails only. The resubmit limit is a
separate, deliberate limit that can drop a user operation after repeated
counted failures.

Isolation is also the post-send splitter that ADR 0001's layer 3 considered and
did not build. After an oversize rejection, each user operation is now retried
in isolation.

## Alerting

Alert when the limit drops user operations, for example:

```
sum by (instance) (rate(ultra_relay_user_operations_dropped_total{reason="max resubmits reached"}[5m])) > 0
```

## Known follow-ups

- **ADR 0004's requeue-write loss is still open.** A failed requeue write can
  lose a user operation silently: `resubmitUserOps` removes the processing and
  submitted records before re-adding, and the store logs and swallows a failed
  outstanding write. This change does not fix it.
- **A store error inside an awaited resubmit** in `sendBundleToExecutor`
  triggers a second resubmit through `recoverFailedSend`, counted as
  `send_bundle_unexpected_error`.
- **Arrival validation still simulates without a sender.** Upstream #826 moved
  v0.6 validation to an executor sender. Consider mirroring it separately.
- **No stale-user-operation expiry, and `insufficient_funds` is never
  counted.** That is right for an empty wallet, but the same error also occurs
  when one user operation makes a bundle cost more than the wallet holds. Such
  a bundle is put back whole, uncounted and not isolated, so the user operation
  retries without limit and can keep its bundle-mates in the loop with it. This
  predates this change. Follow-up: an age limit, and an alert such as
  `sum by (instance) (rate(ultra_relay_user_operations_resubmitted_total{reason="insufficient_funds"}[5m])) > 0`
  sustained for several minutes.
- **Bound wallet waiters across ticks.** Isolation increases the bundle count
  while wallets are busy, so waiters for a wallet can pile up across ticks.
- **A resend after a cap drop gets a fresh budget.** By design, as upstream: a
  dropped user operation that the client sends again starts at 0.
- **ZER-1350's operational items** are not code here: the gateway block, more
  executor wallets, top-up, and low-balance and failed-bundle alerts.
