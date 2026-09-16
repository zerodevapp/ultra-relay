# Boosted preVerificationGas rollout

Zero userOperation fees do not remove transaction overhead. The existing
preVerificationGas calculator includes execution/calldata overhead, authorization
overhead and configured chain-specific components. Admission can now enforce
that minimum for boosted operations without modifying signed fields or receipts.

## Modes

Both options default to false; they add no admission checks or RPC workload
until enabled. The separate v0.6/EIP-7623 calculator correction described below
can still affect estimation and existing non-boosted v2 validation.

- `--observe-boost-pvg` / `ALTO_OBSERVE_BOOST_PVG=true`: sample the required PVG
  and log `declaredPvg`, `requiredPvg`, `wouldReject`, sender, EntryPoint and API
  version. Admission does not wait for the asynchronous fee calculation and
  calculation failures are logged rather than rejecting the request.
- `--enforce-boost-pvg` / `ALTO_ENFORCE_BOOST_PVG=true`: reject insufficient PVG
  using the existing simulate-validation response (`-32500`) and
  required/received values.
  Calculation errors do not fall back to accepting an unchecked operation.
  Enforcement takes precedence when both options are set.

Both modes cover boosted operations on **API v1 and v2**, including both
`boost_sendUserOperation` and zero-fee `eth_sendUserOperation` submissions.
Non-boosted operations retain their existing behavior: v1 skips this check and
v2 validates PVG.

## Observation bounds

Each handler starts at most one observation per second and allows at most one
in-flight observation. Further observations are skipped, not queued. This bounds
background oracle work but means logs are a sample, not an exhaustive audit or
an unbiased rejection-rate metric. A stalled calculation prevents further
samples for that handler until it completes; it does not block admission.

## Rollout

1. Enable observation where needed and inspect samples alongside client inputs.
2. Clients must estimate with their actual zero-fee operation and authorization,
   preserve returned PVG, then sign. Do not overwrite PVG with zero afterward.
3. Qualify each chain/configuration and enable enforcement when clients are ready.
4. Disabling enforcement restores compatibility immediately. It also restores
   acceptance of underdeclared PVG and the associated overhead shortfall.

No default-on cutover is part of this change. Enabling enforcement rejects
existing insufficient-PVG submissions; it does not repair queued operations.
The computed minimum is an admission guard, not a guarantee that estimates cover
every later fee movement, rollup fee component or separately mined failed bundle.

### Known limitations

On OP Stack chains the existing validation calculator reads a minimum L1-fee
cache whose writer currently has no callers. An empty cache defaults to 1 wei,
which normally converts to zero overhead gas. Estimation queries the L1-fee
oracle directly, but observation/enforcement reuse the incomplete validation
floor. Do not interpret `wouldReject=false` as evidence of sufficient L1 overhead
or qualify Base/Optimism cost coverage from these logs. Fixing this pre-existing
calculator issue is separate from enabling the default-off rollout controls.

The new controls apply to zero-fee boosted operations. Tiny nonzero-fee operations
remain subject to existing fee policy: the gas-price floor is checked only for
non-boosted API v2 requests with safe mode disabled. Non-boosted v1 skips PVG
validation, while non-boosted v2 still checks it. Fleet exposure/configuration
and any fee-policy changes require separate review.

With EIP-7623 enabled, v0.6 now receives no execution-gas credit inferred from
declared limits: it has no unused-gas penalty. This prevents padded limits from
lowering the calldata floor, but can conservatively increase estimated/required
PVG for calldata-heavy v0.6 operations even when boosted enforcement is disabled.
The EIP-7623-disabled calculation is unchanged.

## Verification

- Unit tests cover both APIs, default/observe/enforce modes, fee-calculator errors,
  threshold boundaries, unchanged signed fields and bounded observation.
- The default Anvil suite retains compatibility and shortfall characterization.
- `pnpm --filter e2e run test:boosted:strict` explicitly enables enforcement in
  the local child process and tests both submission endpoints, API versions and
  EntryPoints 0.6/0.7/0.8. CI runs this gate separately from compatibility tests.
