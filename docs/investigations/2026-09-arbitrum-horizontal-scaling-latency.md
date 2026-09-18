# Latency investigation: Arbitrum instance after horizontal scaling (September 2026)

A dedicated Arbitrum relay instance moved from one pod to two pods in
horizontal-scaling mode (Redis-backed stores, shared wallet pool) on
2026-09-11. The integration it serves races several bundlers in parallel and
counts which one lands the userOp first. Their win rate for this instance fell
from roughly 48% to 20% within a day of the change, with no error-rate change
on our side. This document records how the regression was located, what it
was, how the fix was verified, and what a separate whole-stack benchmark did
and did not add. It exists so the next "slower after scaling" report starts
from the method, not from scratch.

## 1. Locating the regression from per-stage timings

Every included userOp emits one `included in tx` log line carrying the stage
durations the executor already tracks: `validationMs`, `outstandingMs`,
`processingMs`, `submittedMs`, `inclusionTimeMs`, `totalMs`. Comparing the
quantiles of each field, grouped by time window and by pod hostname, for the
single-pod days against the two-pod days isolated the change to one stage.

| stage (p50, ms) | single pod | two pods | note |
|---|---|---|---|
| `outstandingMs` | 71 | 47 | improved: two pods drain the queue faster |
| `processingMs` | 292 | 392 | **+100 ms, uniform across quantiles** (min 86 → 191) |
| `submittedMs` (send → mined) | unchanged | unchanged | not a chain or RPC effect |
| `inclusionTimeMs` | ~613 | 713 | the +100 ms, end to end |

A uniform shift across every quantile, including the minimum, means a fixed
delay on the critical path rather than contention. Contention widens the
distribution; a sleep moves it.

## 2. Root cause: a fixed sleep in the Redis sender manager

`processingMs` covers bundle assembly up to `submittedAt`, and wallet
acquisition sits inside it. The Redis-backed `getWallet` in
`src/executor/senderManager/createRedisSenderManager.ts` looped as

```ts
while (!walletAddress) {
    walletAddress = await redisQueue.pop()
    await delay(100)
}
```

so a **successful** pop still paid the 100 ms sleep before the bundle could
be signed and sent. The in-memory sender manager uses a semaphore and has no
sleep, which is why single-pod mode never showed this. The same pattern exists
in upstream alto. A second, independent review of the attribution agreed;
the remaining Redis round-trips in this window cost a few to tens of
milliseconds, not hundreds.

Fix: PR #54 (merged 2026-09-14, `fcfd9139`). The sleep now runs only when the
pool is empty, and the `llen` read that feeds the `walletsAvailable` gauge is
fire-and-forget instead of awaited on the bundling path.

```ts
while (!walletAddress) {
    walletAddress = await redisQueue.pop()
    if (!walletAddress) {
        await delay(100)
    }
}
```

## 3. Verification after deploy

Same query, same instance, two pods before and after the deploy:
`inclusionTimeMs` p50 713 ms → 638 ms, back to the single-pod figure while
keeping both pods. `processingMs` returned to the ~300 ms band.

## 4. Cross-check against a whole-stack benchmark

Separately, an internal benchmark ran the entire stack on one machine (local
chain node, gateway, ultra-relay in Redis mode, status listener, indexer, load
generator), measured SDK-send to SDK-sees-receipt at 2 to 50 ops/s, and priced
each hop by injecting RPC and Redis delay. Two caveats govern its numbers: the
4,150 ms headline is at 25 ops/s on one box, far above the traffic any single
instance sees (production p50 totals were ~690 ms on this Arbitrum instance and
~480 ms on Base), and it measures what the SDK observes, whereas the race
benchmark above measures when the op is mined.

Its findings, checked against code and production logs:

| # | claim | verdict | relevance to this instance |
|---|---|---|---|
| 1 | The SDK learns of inclusion only on its next 1 s receipt poll; each empty poll costs several gateway DB queries | correct; nothing pushes inclusion to the client | perceived latency only, no effect on mined time |
| 2 | ~10 sequential RPC calls per bundle; 1 ms of RPC latency becomes 20–30 ms of user wait | directionally right, multiplier overstated: pre-bundle gas, nonce and base-fee reads already run in one `Promise.all`; the real chain is 7–9 calls | yes, each hosted-RPC round trip is 10–30 ms |
| 3 | Each op is fully validated twice, on `eth_sendUserOperation` and again when bundled | correct (`rpc/methods/eth_sendUserOperation.ts`, `mempool/mempool.ts`) | ~30 ms per op in production (`--safe-mode false`); the bench's 80–150 ms per validation is a bench figure and its validator mode is not stated |
| 4 | The bundle builder validates the queue serially, so 51 ops × 83 ms is a 3 s tick | correct: `process()` awaits `shouldSkip` per op | latent; ~1 op per tick today, real under bursts |
| 5 | The bundling interval pins at 1 s from 90 ops/min; the block watcher is coarse on fast chains | correct: `min(minBundleInterval + rpm × 10, maxBundleInterval)`, watcher polls at `blockTime / 4` with `--block-time` defaulting to 1000 ms | not this instance (~100 ms interval); matters on high-volume chains and any instance that leaves `--block-time` unset |
| 6 | Everything gets 3× slower past 14 ops/s | bench artifact: the local node was also the sequencer | none |

What that report could not see, because a local node answers in ~1 ms:

- the 100 ms sleep in section 2, which sat inside its "picked to broadcast"
  span and was attributed elsewhere;
- `eth_sendRawTransaction` to the hosted RPC provider on Arbitrum taking
  200–330 ms per bundle in our logs, the largest single piece of
  `processingMs` after the fix.

## 5. Open follow-ups

- **Submission latency.** 200–330 ms per `eth_sendRawTransaction` on Arbitrum
  is now the dominant term. Candidates: a direct sequencer endpoint for the
  send, or `eth_sendRawTransactionSync` where the provider supports it.
- **Redis sender manager lifecycle.** Startup re-seeds the wallet pool whenever
  the Redis list is empty, which can reissue a wallet another pod is holding
  during a rolling deploy under load. There is no lease recovery when a pod
  dies while holding a wallet; the manual path is `DEL
  <prefix>:<chainId>:sender-manager` followed by a restart.
- **Serial queue validation** (finding 4): parallelise `shouldSkip` across the
  queue, bounded, before any instance carries bursty traffic.
- **`--block-time` per instance** (finding 5): set it explicitly on fast
  chains so the watcher polls at the real block cadence.
- **Not done.** No reproduction of the race benchmark on our side and no
  client-side timing; the numbers above are all server-side stage timings.

## Method, for next time

1. Pull `included in tx` lines for the instance, extract the six stage
   fields, and compare quantiles (min, p50, p90, p99) grouped by window and
   `hostname`. A uniform shift is a fixed delay; a widened tail is contention.
2. Map the shifted stage to the code between its two timestamps before
   reading any Redis or RPC metrics.
3. Re-run the same query after the fix on the same instance and pod count.

Related: PR #51 (`--redis-key-prefix` honoured by every Redis-backed store, the
change that made two same-chain instances on one Redis safe and enabled this
instance to scale) and PR #54 (the fix above).
