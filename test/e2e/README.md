# E2E tests

The suite starts an isolated Prague Anvil chain and the bundler from TypeScript
source on temporary local ports. It deploys EntryPoints and test accounts for
versions 0.6, 0.7 and 0.8, and stops both processes on completion or setup failure.
It does not exercise the production Docker image or a deployed chain endpoint.

## Run

Prerequisites: Node.js 22+, pnpm, and Foundry with Prague support. Install
dependencies and build the simulation artifacts first:

```sh
pnpm install
pnpm run build:contracts
pnpm --filter e2e run test:ci
```

Run the boosted subset:

```sh
pnpm --filter e2e run test:boosted
```

Run a specific test:

```sh
pnpm --filter e2e exec vitest run tests/boosted-accounting.test.ts
```

The harness uses `alto-config.json` and public Anvil development keys. It does
not load developer dotenv files or inherit credentials, remote storage settings,
or telemetry configuration into the child processes. Docker Compose is not
required for these commands.

## Boosted gas accounting

`boosted-accounting.test.ts` exercises both `boost_sendUserOperation` and the
zero-fee path of `eth_sendUserOperation` using generated, unfunded accounts:

- Estimate with both fee fields zero from the start; sign and execute without a
  paymaster or EntryPoint deposit.
- Execute regular 4337 accounts, fresh 7702 delegations and subsequent delegated
  calls; verify counter storage changes and delegation code.
- Compare userOperation receipts with independently fetched transaction receipts
  and EntryPoint events, preserving zero `actualGasCost`.
- Compare aggregate reported gas priced at the mined transaction's effective gas
  price with measured transaction cost, counting a shared bundle only once.
- Exercise mixed-account bundles and large calldata.

### Known zero-PVG shortfall

The default suite **characterizes current behavior**, including operations with
`preVerificationGas = 0`. These cases must execute successfully and demonstrate
that reported gas priced at the transaction gas price is **less than the actual
transaction fee**. A green default suite therefore does not certify admission
control or universal cost coverage.

The opt-in strict gate instead requires insufficient-PVG operations to be
rejected, across both submission methods, API v1/v2, account types and supported
EntryPoint versions:

These are request-surface combinations, not four independent admission paths.
Every operation in this gate has zero fees and enters the shared boosted path;
with enforcement disabled, PVG validation is bypassed for all of them. The gate
checks that enabled boosted enforcement is reachable through each endpoint/API
combination. It does not test non-boosted fee/PVG policy or prove L1-fee coverage.

```sh
pnpm --filter e2e run test:boosted:strict
```

This command explicitly enables `ALTO_ENFORCE_BOOST_PVG=true` in the isolated
local bundler process. Normal tests leave enforcement disabled and continue to
characterize compatibility behavior. CI runs both modes; neither command changes
any deployed service configuration.

### Scope

These are generic protocol and gas-accounting tests. Fixtures are generated
locally and contain no customer data, private service integrations or pricing
rules. Cost arithmetic uses integers in native base units.

Anvil does not model rollup data/operator fees. Per-chain qualification still
needs an independent, chain-aware total-fee calculation and actual Docker/remote
endpoint tests. Successful-bundle coverage also does not account for separately
mined reverted bundles, cancellations or other executor expenses.
