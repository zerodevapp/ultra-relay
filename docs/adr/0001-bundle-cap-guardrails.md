# Bundle cap guardrails

Two production incidents (Base: tx gas > EIP-7825's 16,777,216 cap; BNB: bundle
calldata > geth's 131,072-byte `txMaxSize`) had the same root cause: nothing
bounded a bundle's submitted gas or serialized byte size, so the bundler
reformed the same oversized handleOps transaction every tick and looped until
traffic dropped. We enforce per-transaction **bundle caps** at three layers and
make the packing gas budget honest.

## Caps

Hardcoded, chain-aware, **conservative by default**: an unlisted chain gets
`{ gas: 16,777,216, bytes: 131,072 }`. The map only deviates where docs prove a
chain differs (Arbitrum's byte limit is *lower* — `DataTooLarge` at 117,964 —
so the default would overflow it; Arbitrum exec gas cap 32M; Polygon has no
per-tx gas cap so it gets a higher throughput ceiling). Resolved chainId >
chainType-family > default. No CLI override knob — a new chain with a tighter
limit needs a map entry, by design (safe default covers it meanwhile).

Caps carry **per-dimension proven flags** (`gasCapProven`, `byteCapProven`):
true only when that specific cap is a verified hard limit for the chain. The
split matters because a chain's caps can mix kinds — Polygon's byte cap is
bor/geth's real `txMaxSize`, but its 30M gas cap is our throughput choice
(no per-tx gas limit exists there), so byte-rejecting at ingress is safe on
Polygon while gas-rejecting would false-reject valid ops in `(30M, block
limit]`. Evidence behind the proven set: Base's gas cap and BNB's byte cap
are empirically proven by the two production incidents this work fixes; BNB's
gas cap by BEP-652/Osaka-Mendel, activated on mainnet 2026-04-28 (verified
activated, not just scheduled); mainnet via Fusaka; Arbitrum via ArbOS's
enforced 32M exec limit and `DataTooLarge` at 117,964. On an unlisted chain
the caps are a conservative *guess*, and per review (PR #35) a guess may only
shape packing — never reject or drop a userOp. Guardrails must never reject
or drop a valid userOp: rejection requires either a proven hard limit or a
ground-truth node rejection. No runtime cap-probing: nodes expose no reliable
RPC surface for their per-tx caps, so proven-ness is evidence in code review,
not a network call.

`byteCap` is uniformly the chain's **hard rejection limit** (the size the node
rejects at), never a pre-margined value. `bundleByteThreshold` applies the 90%
safety margin on top for every chain, so the effective packing bound is always
strictly below the real limit (default → 117,964; Arbitrum → 106,167, still
under both its 117,964 `DataTooLarge` and its 95,000 sequencer limit). Arbitrum's
117,964 happens to equal 90% of geth's 128 KiB only because Arbitrum itself
chose that as its hard limit — it is not our margin applied twice.

## Enforcement (three layers)

1. **Packing** bounds `scale(floor + eip7702, 105n)` against
   `min(maxGasPerBundle, gasCap)` and serialized bytes against `byteCap × 0.9`.
   Margins are asymmetric on purpose: the gas projection over-counts (safe), the
   byte estimate under-counts the 7702 authList/sig (needs headroom). Applies on
   every chain — a conservative bound here only splits bundles smaller, it can
   never reject an op (a lone over-cap op still packs alone and is sent).
2. **Ingress** (`addToMempoolIfValid`) rejects a userOp that *alone* exceeds a
   cap with `-32602` — **only on proven-cap chains**, and bytes against the
   *raw* hard cap (no 90% margin: the margin is for multi-op packing estimates;
   at ingress it would false-reject ops in the [90%, 100%) band). On unlisted
   chains ingress does not reject — the node is the judge.
3. **Executor** detects the oversize rejection class — narrowed to the two
   deterministic node rejections only (`oversized data`, `gas limit too high`;
   broader strings like `exceeds block gas limit` can be transient and would
   permanently drop a valid op) — and, for a multi-op bundle, resubmits to
   outstanding (packing reforms smaller); a lone over-cap op is dropped
   (`oversized_bundle`) with the dropped-event/status surfaced to the client.
   No retry before the drop: both rejection strings are deterministic for a
   given op (serialized size and `floor×1.05` gas limit are pure functions of
   the op's fields), so a retry re-sends an identical tx to an identical
   rejection.

## Considered options (layer 3)

We chose **resubmit-reform** over an explicit post-send splitter. Reform is
correct and simplest *when packing's estimate matches the submitted gas*, which
holds while `rpc-gas-estimate=false` (the default — local `floor×1.05`
estimation). An explicit splitter converges even under estimate drift but costs
more code and a wasted send per oversize.

## Consequences

- `maxGasPerBundle` now bounds the *actual* tx gas (scaled), not the raw floor —
  effective bundles are ~5% smaller than before from the scaling alone. Larger
  effect: the packing ceiling is `min(maxGasPerBundle, gasCap)`, so any chain
  left at the 20M default now caps at the 16.77M gas cap (~16% lower). Both are
  intended; an operator seeing smaller bundles should look here, not for a bug.
- The raised per-chain gas caps (Polygon 30M, Arbitrum 32M) only increase
  packing throughput if `--max-gas-per-bundle` is raised alongside — the
  ceiling is the `min` of the two. Until then an op in
  `(maxGasPerBundle, gasCap]` passes ingress and packs alone, which is correct
  (it is sent and included) but not batched.
- **Upgrade trigger:** if any chain sets `rpc-gas-estimate=true`, packing's
  floor projection can under-estimate the RPC-estimated submitted gas and layer 3
  can loop on the same bundle. At that point switch layer 3 to the explicit
  post-send half-split (marked with a `ponytail:` comment at the catch site).
