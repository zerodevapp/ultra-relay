# Bundle Cap Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the bundler from ever submitting a handleOps transaction that exceeds a chain's per-transaction gas cap (EIP-7825) or serialized byte size cap (geth `txMaxSize`), which currently causes an infinite ~1/sec resubmit loop.

**Architecture:** Chain-aware, conservative-by-default bundle caps resolved from a hardcoded map, enforced at three layers: (1) mempool packing prevents oversized bundles from forming, (2) RPC ingress rejects a userOp that alone exceeds a cap, (3) the executor detects an oversize rejection and resubmits multi-op bundles (packing reforms them smaller) or drops a lone over-cap op instead of looping.

**Tech Stack:** TypeScript (ESM, strict), viem, Zod, Vitest (e2e against Anvil), Pino.

## Global Constraints

- Never use `any` — proper types, `unknown`, or assertions.
- BigInt math via `scaleBigIntByPercent` / `minBigInt` / `maxBigInt` — never manual `(x*Yn)/100n`.
- Naming: constants UPPER_SNAKE_CASE; `userOp` for locals/methods; `UserOperation` for types.
- Formatting: 4-space indent, 80-col, no semicolons, no trailing commas. Run `pnpm run format` before staging.
- Internal imports via `@alto/*` aliases.
- **Never run `git commit`** (user's global rule overrides the TDD "commit" step). Each task ends by staging with `git add`; the user commits manually.
- Caps (from `docs/adr/0001-bundle-cap-guardrails.md`): default `{ gas: 16_777_216, bytes: 131_072 }`; Arbitrum family `{ gas: 32_000_000, bytes: 117_964 }`; Polygon (137) `{ gas: 30_000_000 }`. Byte safety margin 90%. Gas projection = `scale(floor + eip7702Overhead, 105n)`; eip7702 overhead = `40_000n` per 7702 op.

---

## File Structure

- **Create** `src/executor/bundleCaps.ts` — cap constants, chain-aware resolver `getBundleCaps`, byte-threshold helper. Imported by mempool (layer 1), RPC ingress (layer 2), executor (layer 3).
- **Modify** `src/mempool/mempool.ts` — `process()` packing loop: bound projected gas + serialized bytes.
- **Modify** `src/rpc/methods/eth_sendUserOperation.ts` — `addToMempoolIfValid`: reject single over-cap op.
- **Modify** `src/executor/utils.ts` — add `isOversizedBundleError` classifier.
- **Modify** `src/executor/executor.ts` — catch block: handle oversize rejection.
- **Modify** `src/types/mempool.ts` — add `"oversized_bundle"` to `BundleResult.reason` union.
- **Modify** `src/executor/executorManager.ts` — count `oversized_bundle` in failed-bundle metric.
- **Create** `test/e2e/tests/bundleCaps.test.ts` — e2e: gas-split, byte-split, single-op ingress rejection.

---

### Task 1: Bundle caps module

**Files:**
- Create: `src/executor/bundleCaps.ts`

**Interfaces:**
- Consumes: `AltoConfig` (has `chainId: number`, `chainType: string`).
- Produces:
  - `getBundleCaps(config: AltoConfig): { gasCap: bigint; byteCap: number }`
  - `bundleByteThreshold(byteCap: number): number`
  - `DEFAULT_BUNDLE_GAS_CAP: bigint`, `DEFAULT_BUNDLE_BYTE_CAP: number`, `BUNDLE_BYTE_SAFETY_PERCENT: number`

- [ ] **Step 1: Create the module**

Create `src/executor/bundleCaps.ts`:

```typescript
import type { AltoConfig } from "../createConfig"

// EIP-7825 per-transaction gas cap (2^24). Conservative default: applies to an
// unlisted chain. The map below only RAISES this where a chain provably allows
// more; being too generous here reproduces the production oversized-tx loop.
export const DEFAULT_BUNDLE_GAS_CAP = 16_777_216n

// geth txMaxSize (128 KiB) on the full serialized transaction. Node DoS guard,
// not consensus, so it varies by client/chain.
export const DEFAULT_BUNDLE_BYTE_CAP = 131_072

// Our serialized-tx byte estimate under-counts (omits the EIP-7702
// authorizationList and the real tx signature), so bound against a margined
// threshold, never the raw cap.
export const BUNDLE_BYTE_SAFETY_PERCENT = 90

type BundleCaps = { gasCap: bigint; byteCap: number }

// Resolution precedence: chainId override > chainType family > default.
// Only list chains that PROVABLY differ from the conservative default.
const CHAIN_TYPE_CAP_OVERRIDES: Record<string, Partial<BundleCaps>> = {
    // Arbitrum/Orbit: execution gas cap is 32M; DataTooLarge rejects payloads
    // over ~117,964 bytes (90% of geth's 128 KiB), so the default byte cap
    // would OVERFLOW it -> lower the byte cap here.
    arbitrum: { gasCap: 32_000_000n, byteCap: 117_964 }
}

const CHAIN_ID_CAP_OVERRIDES: Record<number, Partial<BundleCaps>> = {
    // Polygon PoS (bor): no per-tx gas cap (block limit 140M+). Raise above the
    // default 16.77M for bundle throughput. Bytes inherit the geth default.
    137: { gasCap: 30_000_000n }
}

export const getBundleCaps = (config: AltoConfig): BundleCaps => ({
    gasCap: DEFAULT_BUNDLE_GAS_CAP,
    byteCap: DEFAULT_BUNDLE_BYTE_CAP,
    ...CHAIN_TYPE_CAP_OVERRIDES[config.chainType],
    ...CHAIN_ID_CAP_OVERRIDES[config.chainId]
})

export const bundleByteThreshold = (byteCap: number): number =>
    Math.floor((byteCap * BUNDLE_BYTE_SAFETY_PERCENT) / 100)
```

- [ ] **Step 2: Type-check**

Run: `pnpm run build`
Expected: builds with no TypeScript errors (the new file compiles; `config.chainType` / `config.chainId` resolve on `AltoConfig`).

> Note: per the e2e-only test decision, `getBundleCaps` / `bundleByteThreshold` are exercised end-to-end by Tasks 2 & 3 (Anvil chainId 31337 → default caps). No standalone unit test is added.

- [ ] **Step 3: Format & stage**

Run: `pnpm run format`
Run: `git add src/executor/bundleCaps.ts`

Report to the user: "Task 1 staged — needs a commit."

---

### Task 2: Layer 1 — packing guard (gas + bytes)

**Files:**
- Modify: `src/mempool/mempool.ts` (imports near top; `process()` packing loop ~L845-895)
- Test: `test/e2e/tests/bundleCaps.test.ts`

**Interfaces:**
- Consumes: `getBundleCaps`, `bundleByteThreshold` (Task 1); `getSerializedHandleOpsTx`, `scaleBigIntByPercent`, `minBigInt` (`@alto/utils`); `size` (viem); existing `calculateAA95GasFloor`.
- Produces: packing that never emits a bundle whose projected gas exceeds `min(maxGasPerBundle, gasCap)` or whose serialized bytes exceed `byteCap × 0.9` (except a lone op below `minOpsPerBundle`, handled at layers 2/3).

- [ ] **Step 1: Write the failing e2e tests**

Create `test/e2e/tests/bundleCaps.test.ts`:

```typescript
import {
    http,
    type Address,
    createPublicClient,
    parseEther
} from "viem"
import {
    type EntryPointVersion,
    entryPoint07Address
} from "viem/account-abstraction"
import { foundry } from "viem/chains"
import { beforeEach, describe, expect, inject, test } from "vitest"
import {
    beforeEachCleanUp,
    getSmartAccountClient,
    sendBundleNow,
    setBundlingMode
} from "../src/utils/index.js"

// Anvil reports chainId 31337 -> getBundleCaps falls to the conservative
// default { gas: 16_777_216, bytes: 131_072 }. These tests craft ops that
// exceed those defaults and assert the bundler SPLITS them across multiple
// handleOps transactions (distinct receipt.transactionHash values).
describe("bundle cap guardrails", () => {
    const entryPoint: Address = entryPoint07Address
    const entryPointVersion: EntryPointVersion = "0.7"
    const TO_ADDRESS = "0x23B608675a2B2fB1890d3ABBd85c5775c51691d5"

    const anvilRpc = inject("anvilRpc")
    const altoRpc = inject("altoRpc")

    const publicClient = createPublicClient({
        transport: http(anvilRpc),
        chain: foundry
    })

    beforeEach(async () => {
        await beforeEachCleanUp({ anvilRpc, altoRpc })
    })

    const distinctBundleTxs = (
        receipts: { receipt: { transactionHash: string } }[]
    ): number =>
        new Set(receipts.map((r) => r.receipt.transactionHash)).size

    test("splits a batch that exceeds the per-tx gas cap", async () => {
        const client = await getSmartAccountClient({
            entryPointVersion,
            anvilRpc,
            altoRpc
        })

        const deployHash = await client.sendUserOperation({
            calls: [{ to: client.account.address, value: 0n, data: "0x" }]
        })
        await client.waitForUserOperationReceipt({ hash: deployHash })

        await setBundlingMode({ mode: "manual", altoRpc })

        // Two ops at ~9M callGasLimit each: each fits alone (<16.77M cap) but
        // together project >16.77M, so packing must place them in separate
        // bundles.
        const hashes: `0x${string}`[] = []
        for (let i = 0; i < 2; i++) {
            hashes.push(
                await client.sendUserOperation({
                    calls: [
                        { to: TO_ADDRESS, value: parseEther("0.001"), data: "0x" }
                    ],
                    callGasLimit: 9_000_000n
                })
            )
        }

        await sendBundleNow({ altoRpc })

        const receipts = await Promise.all(
            hashes.map((hash) =>
                client.waitForUserOperationReceipt({ hash })
            )
        )

        expect(receipts.every((r) => r.success)).toEqual(true)
        expect(distinctBundleTxs(receipts)).toBeGreaterThanOrEqual(2)
    })

    test("splits a batch that exceeds the per-tx byte cap", async () => {
        const client = await getSmartAccountClient({
            entryPointVersion,
            anvilRpc,
            altoRpc
        })

        const deployHash = await client.sendUserOperation({
            calls: [{ to: client.account.address, value: 0n, data: "0x" }]
        })
        await client.waitForUserOperationReceipt({ hash: deployHash })

        await setBundlingMode({ mode: "manual", altoRpc })

        // ~50 KB of calldata per op. Three of them (~150 KB) exceed the 128 KiB
        // byte cap (margined to ~117 KB), forcing a split.
        const fatData = `0x${"00".repeat(50_000)}` as `0x${string}`
        const hashes: `0x${string}`[] = []
        for (let i = 0; i < 3; i++) {
            hashes.push(
                await client.sendUserOperation({
                    calls: [{ to: TO_ADDRESS, value: 0n, data: fatData }],
                    callGasLimit: 1_000_000n
                })
            )
        }

        await sendBundleNow({ altoRpc })

        const receipts = await Promise.all(
            hashes.map((hash) =>
                client.waitForUserOperationReceipt({ hash })
            )
        )

        expect(receipts.every((r) => r.success)).toEqual(true)
        expect(distinctBundleTxs(receipts)).toBeGreaterThanOrEqual(2)
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd test/e2e && pnpm test -t "bundle cap guardrails"`
Expected: both split tests FAIL — `distinctBundleTxs` returns `1` (current packing batches all ops into one oversized bundle; the gas op may even land but bytes op bundle is rejected/looping).

- [ ] **Step 3: Add imports to `src/mempool/mempool.ts`**

The file already imports `calculateAA95GasFloor` from `"../executor/utils"` (L33). Add the caps helpers next to it, and add the utils/viem imports.

Add after the existing `calculateAA95GasFloor` import:

```typescript
import { getBundleCaps, bundleByteThreshold } from "../executor/bundleCaps"
```

In the `@alto/utils` import group, add `getSerializedHandleOpsTx`, `minBigInt`, and `scaleBigIntByPercent`. In the `viem` import group, add `size`. (Merge into existing import statements — do not duplicate.)

- [ ] **Step 4: Replace the gas-only budget check in `process()`**

Find this block inside `process()` (the inner add loop, ~L845-881):

```typescript
                const beneficiary =
                    this.config.utilityPrivateKey?.address ||
                    privateKeyToAddress(generatePrivateKey())

                gasUsed += calculateAA95GasFloor({
                    userOps: [userOp],
                    beneficiary
                })

                // Only break on gas limit if we've hit minOpsPerBundle
                if (
                    gasUsed > maxGasLimit &&
                    currentBundle.userOps.length >= minOpsPerBundle
                ) {
                    this.logger.debug(
                        {
                            event: "userOpSkipped",
                            reason: "Bundle gas limit exceeded",
                            userOpHash: userOpInfo.userOpHash,
                            userOpGas: (
                                userOp.callGasLimit +
                                userOp.verificationGasLimit
                            ).toString(),
                            currentBundleGas: (
                                gasUsed -
                                userOp.callGasLimit -
                                userOp.verificationGasLimit
                            ).toString(),
                            maxBundleGas: maxGasLimit.toString()
                        },
                        `Skipping userOp ${userOpInfo.userOpHash}, would exceed bundle gas limit.`
                    )

                    // Put the operation back in the store
                    await this.store.addOutstanding({ entryPoint, userOpInfo })
                    break
                }
```

Replace it with (note: `caps`, `gasCeiling`, `byteThreshold`, and `eip7702Overhead` are declared once per bundle in Step 5):

```typescript
                const beneficiary =
                    this.config.utilityPrivateKey?.address ||
                    privateKeyToAddress(generatePrivateKey())

                gasUsed += calculateAA95GasFloor({
                    userOps: [userOp],
                    beneficiary
                })
                if (userOp.eip7702Auth) {
                    eip7702Overhead += 40_000n
                }

                // Project the ACTUAL submitted tx gas (executor scales the floor
                // by 105%), not the raw floor, so the budget matches what the
                // node sees against the per-tx gas cap.
                const projectedGas = scaleBigIntByPercent(
                    gasUsed + eip7702Overhead,
                    105n
                )

                // Project the serialized tx byte size if this op is added.
                const candidateUserOps = [
                    ...currentBundle.userOps.map((info) => info.userOp),
                    userOp
                ]
                const projectedBytes = size(
                    getSerializedHandleOpsTx({
                        userOps: candidateUserOps,
                        entryPoint,
                        chainId: this.config.chainId,
                        removeZeros: false
                    })
                )

                const exceedsGas = projectedGas > gasCeiling
                const exceedsBytes = projectedBytes > byteThreshold

                // Only break once we have at least minOpsPerBundle ops; a lone
                // over-cap op is handled at ingress (rejected) and the executor
                // (dropped) rather than black-holed here.
                if (
                    (exceedsGas || exceedsBytes) &&
                    currentBundle.userOps.length >= minOpsPerBundle
                ) {
                    this.logger.debug(
                        {
                            event: "userOpSkipped",
                            reason: exceedsBytes
                                ? "Bundle byte size limit exceeded"
                                : "Bundle gas limit exceeded",
                            userOpHash: userOpInfo.userOpHash,
                            projectedGas: projectedGas.toString(),
                            gasCeiling: gasCeiling.toString(),
                            projectedBytes,
                            byteThreshold
                        },
                        `Skipping userOp ${userOpInfo.userOpHash}, would exceed bundle cap.`
                    )

                    // Put the operation back in the store
                    await this.store.addOutstanding({ entryPoint, userOpInfo })
                    break
                }
```

- [ ] **Step 5: Declare the per-bundle cap values**

Find the per-bundle setup block (where `let gasUsed = 0n` is initialized, ~L792):

```typescript
            let gasUsed = 0n
            let paymasterDeposit: { [paymaster: string]: bigint } = {}
```

Replace with:

```typescript
            let gasUsed = 0n
            let eip7702Overhead = 0n
            const caps = getBundleCaps(this.config)
            const gasCeiling = minBigInt(maxGasLimit, caps.gasCap)
            const byteThreshold = bundleByteThreshold(caps.byteCap)
            let paymasterDeposit: { [paymaster: string]: bigint } = {}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm run format`
Run: `cd test/e2e && pnpm test -t "bundle cap guardrails"`
Expected: both split tests PASS — `distinctBundleTxs >= 2` and all ops succeed.

- [ ] **Step 7: Stage**

Run: `git add src/mempool/mempool.ts test/e2e/tests/bundleCaps.test.ts`

Report to the user: "Task 2 staged — needs a commit."

---

### Task 3: Layer 2 — ingress rejection of a lone over-cap op

**Files:**
- Modify: `src/rpc/methods/eth_sendUserOperation.ts` (imports; inside `addToMempoolIfValid`, after PVG validation ~L167)
- Test: `test/e2e/tests/bundleCaps.test.ts` (add a case)

**Interfaces:**
- Consumes: `getBundleCaps`, `bundleByteThreshold` (Task 1); `calculateAA95GasFloor` (`../../executor/utils`); `getSerializedHandleOpsTx`, `scaleBigIntByPercent` (`@alto/utils`); `size` (viem); existing `RpcError`, `ValidationErrors`.
- Produces: a userOp whose own projected gas exceeds `gasCap`, or whose own serialized bytes exceed `byteCap × 0.9`, is rejected with `RpcError(..., ValidationErrors.InvalidFields)` (−32602) before entering the mempool. Applies to all three send methods (shared chokepoint).

- [ ] **Step 1: Write the failing e2e test**

Add inside the `describe("bundle cap guardrails", ...)` block in `test/e2e/tests/bundleCaps.test.ts`:

```typescript
    test("rejects a single userOp that alone exceeds the byte cap", async () => {
        const client = await getSmartAccountClient({
            entryPointVersion,
            anvilRpc,
            altoRpc
        })

        const deployHash = await client.sendUserOperation({
            calls: [{ to: client.account.address, value: 0n, data: "0x" }]
        })
        await client.waitForUserOperationReceipt({ hash: deployHash })

        // ~140 KB of calldata in one op: alone it exceeds the margined 128 KiB
        // byte cap, so it can never be bundled -> ingress must reject it.
        const hugeData = `0x${"00".repeat(140_000)}` as `0x${string}`

        await expect(async () => {
            await client.sendUserOperation({
                calls: [{ to: TO_ADDRESS, value: 0n, data: hugeData }],
                callGasLimit: 2_000_000n
            })
        }).rejects.toThrowError(
            expect.objectContaining({
                details: expect.stringMatching(
                    /exceeds the per-transaction calldata size cap/i
                )
            })
        )
    })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd test/e2e && pnpm test -t "rejects a single userOp"`
Expected: FAIL — the op is accepted (no rejection thrown), or it loops, rather than throwing the calldata-size error.

- [ ] **Step 3: Add imports to `src/rpc/methods/eth_sendUserOperation.ts`**

Add to the import groups (merge, do not duplicate):

```typescript
import { size } from "viem"
import { getSerializedHandleOpsTx } from "@alto/utils"
import { calculateAA95GasFloor } from "../../executor/utils"
import { getBundleCaps, bundleByteThreshold } from "../../executor/bundleCaps"
```

`scaleBigIntByPercent` is in `@alto/utils` — add it to the existing `@alto/utils` import group alongside the current `calcExecutionPvgComponent` etc.

- [ ] **Step 4: Add the cap check in `addToMempoolIfValid`**

Find the PVG validation block (~L163-167):

```typescript
    // PreVerificationGas validation
    if (!pvgSuccess) {
        rpcHandler.eventManager.emitFailedValidation(userOpHash, pvgErrorReason)
        throw new RpcError(pvgErrorReason, ValidationErrors.SimulateValidation)
    }
```

Insert immediately after it:

```typescript
    // Per-transaction bundle-cap validation: an op that alone exceeds this
    // chain's per-tx gas or calldata-size cap can never be included in any
    // bundle, so reject it here instead of letting it black-hole in the mempool.
    const { gasCap, byteCap } = getBundleCaps(rpcHandler.config)
    const singleOpGas = scaleBigIntByPercent(
        calculateAA95GasFloor({
            userOps: [userOp],
            beneficiary: rpcHandler.config.utilityWalletAddress
        }) + (userOp.eip7702Auth ? 40_000n : 0n),
        105n
    )
    if (singleOpGas > gasCap) {
        const reason = `userOperation exceeds the per-transaction gas cap for this chain (cap: ${gasCap}, required: ~${singleOpGas})`
        rpcHandler.eventManager.emitFailedValidation(userOpHash, reason)
        throw new RpcError(reason, ValidationErrors.InvalidFields)
    }
    const singleOpBytes = size(
        getSerializedHandleOpsTx({
            userOps: [userOp],
            entryPoint,
            chainId: rpcHandler.config.chainId,
            removeZeros: false
        })
    )
    const byteThreshold = bundleByteThreshold(byteCap)
    if (singleOpBytes > byteThreshold) {
        const reason = `userOperation exceeds the per-transaction calldata size cap for this chain (cap: ${byteThreshold} bytes, size: ${singleOpBytes} bytes)`
        rpcHandler.eventManager.emitFailedValidation(userOpHash, reason)
        throw new RpcError(reason, ValidationErrors.InvalidFields)
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm run format`
Run: `cd test/e2e && pnpm test -t "rejects a single userOp"`
Expected: PASS — the send rejects with the calldata-size cap message.

- [ ] **Step 6: Re-run the full cap suite (no regressions)**

Run: `cd test/e2e && pnpm test -t "bundle cap guardrails"`
Expected: all three tests PASS (gas-split, byte-split, single-op-reject).

- [ ] **Step 7: Stage**

Run: `git add src/rpc/methods/eth_sendUserOperation.ts test/e2e/tests/bundleCaps.test.ts`

Report to the user: "Task 3 staged — needs a commit."

---

### Task 4: Layer 3 — executor oversize handling (safety net)

**Files:**
- Modify: `src/executor/utils.ts` (add classifier)
- Modify: `src/types/mempool.ts` (add reason)
- Modify: `src/executor/executor.ts` (catch block ~L533-588)
- Modify: `src/executor/executorManager.ts` (failed-bundle metric conditions)

**Interfaces:**
- Consumes: viem `BaseError`; existing `jsonStringifyWithBigint`, `sentry`, destructured `{ rejectedUserOps, userOpsToBundle }` in the catch.
- Produces: `isOversizedBundleError(err: BaseError): boolean`; `BundleResult.reason` includes `"oversized_bundle"`; on an oversize rejection a multi-op bundle is resubmitted (recoverableOps) and a lone op is dropped (rejectedUserOps).

> Verification note: this layer triggers only when packing's approximation is bypassed (estimate drift on an `rpc-gas-estimate=true` chain, or an op that entered before deploy). With Anvil on default local estimation it is not directly reachable by an e2e test, so it is verified by `pnpm run build` (type-check) plus the classifier's explicit string matching. If src-level unit infra is added later, add a unit test for `isOversizedBundleError`. See `docs/adr/0001-bundle-cap-guardrails.md` for the upgrade trigger.

- [ ] **Step 1: Add the oversize classifier to `src/executor/utils.ts`**

`BaseError` is already imported in this file (used by `isTransactionUnderpricedError`). Add below that function:

```typescript
// The two production oversize rejections: geth ErrOversizedData
// ("oversized data: transaction size N, limit 131072") and EIP-7825's per-tx
// gas cap ("gas limit too high", code -32003). Match defensively across the
// viem error chain's message fields.
export const isOversizedBundleError = (e: BaseError): boolean => {
    const haystack = [
        // @ts-ignore - details is present on viem errors but not on BaseError
        e.details,
        e.shortMessage,
        e.message
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()

    return (
        haystack.includes("oversized data") ||
        haystack.includes("gas limit too high") ||
        haystack.includes("exceeds block gas limit") ||
        haystack.includes("intrinsic gas too high")
    )
}
```

- [ ] **Step 2: Add the reason to `src/types/mempool.ts`**

Find (L49):

```typescript
          reason: "filterops_failed" | "insufficient_funds" | "generic_error"
```

Replace with:

```typescript
          reason:
              | "filterops_failed"
              | "insufficient_funds"
              | "generic_error"
              | "oversized_bundle"
```

- [ ] **Step 3: Handle the oversize rejection in `src/executor/executor.ts`**

Add `isOversizedBundleError` to the existing import from `"./utils"` (which already imports `isTransactionUnderpricedError`).

In the `catch (err: unknown)` block (~L533), find the insufficient-funds check:

```typescript
            // Check if executor has insufficient funds
            const isInsufficientFundsError = err.walk(
                (e) => e instanceof InsufficientFundsError
            )
```

Insert immediately BEFORE it:

```typescript
            // Oversize rejection: the bundle tx exceeds a per-tx node cap. A
            // multi-op bundle is resubmitted so packing reforms it smaller
            // (layer-1 caps now bound it). A lone op can't be split further, so
            // drop it rather than loop forever (the original production bug).
            if (isOversizedBundleError(err)) {
                if (userOpsToBundle.length <= 1) {
                    childLogger.error(
                        {
                            err: jsonStringifyWithBigint(err),
                            bundleSize: userOpsToBundle.length
                        },
                        "dropping userOp that alone exceeds a per-transaction bundle cap"
                    )
                    sentry.captureException(err)
                    return {
                        success: false,
                        reason: "oversized_bundle",
                        rejectedUserOps: [
                            ...rejectedUserOps,
                            ...userOpsToBundle.map((op) => ({
                                ...op,
                                reason: "userOp alone exceeds a per-transaction bundle cap"
                            }))
                        ],
                        recoverableOps: []
                    }
                }

                childLogger.warn(
                    {
                        err: jsonStringifyWithBigint(err),
                        bundleSize: userOpsToBundle.length
                    },
                    "bundle exceeded a per-transaction cap; resubmitting to re-pack smaller"
                )
                return {
                    success: false,
                    reason: "oversized_bundle",
                    rejectedUserOps,
                    recoverableOps: userOpsToBundle
                }
            }
```

- [ ] **Step 4: Count `oversized_bundle` in the failed-bundle metric**

In `src/executor/executorManager.ts`, find the metric condition (~L306):

```typescript
                if (
                    reason === "filterops_failed" ||
                    reason === "generic_error"
                ) {
```

Replace with:

```typescript
                if (
                    reason === "filterops_failed" ||
                    reason === "generic_error" ||
                    reason === "oversized_bundle"
                ) {
```

Then search the file for any other `reason === "generic_error"` comparison (there is a second failure handler ~L954). For each, add `|| reason === "oversized_bundle"` so the new reason is treated identically.

Run: `grep -n 'reason === "generic_error"' src/executor/executorManager.ts`
Expected: each hit now also tests `"oversized_bundle"`.

- [ ] **Step 5: Type-check**

Run: `pnpm run build`
Expected: builds with no errors. The `BundleResult` union exhaustively handles `"oversized_bundle"` everywhere `reason` is consumed.

- [ ] **Step 6: Full e2e regression**

Run: `cd test/e2e && pnpm test -t "bundle cap guardrails"`
Expected: all three tests still PASS (layer 3 doesn't change the happy/split paths).

- [ ] **Step 7: Format & stage**

Run: `pnpm run format`
Run: `git add src/executor/utils.ts src/types/mempool.ts src/executor/executor.ts src/executor/executorManager.ts`

Report to the user: "Task 4 staged — needs a commit. All four tasks complete."

---

## Self-Review

**Spec coverage** (vs `docs/adr/0001-bundle-cap-guardrails.md` and the grilled design):
- Chain-aware conservative caps → Task 1 (`getBundleCaps`, default + Arbitrum + Polygon).
- Budget honesty (`floor×1.05` vs `min(maxGasPerBundle, gasCap)`) → Task 2, Step 4-5.
- Serialized-byte bound with 90% margin → Task 2 (`bundleByteThreshold`, packing check).
- Layer 2 ingress single-op rejection, all 3 send methods via shared `addToMempoolIfValid` → Task 3.
- Layer 3 resubmit-reform + single-op drop, distinct `oversized_bundle` reason, loud log+sentry → Task 4.
- Metric coverage → Task 4, Step 4.
- Asymmetric margins (gas over-counts, bytes under-counts) → encoded in Task 1 comments + Task 2/3 projections.

**Placeholder scan:** none — every code step shows complete code; every command has expected output.

**Type consistency:** `getBundleCaps` returns `{ gasCap: bigint; byteCap: number }` and is consumed with that exact shape in Tasks 2 & 3. `bundleByteThreshold(byteCap: number): number` consistent. `isOversizedBundleError(e: BaseError): boolean` defined in Task 4 Step 1, imported in Step 3. `"oversized_bundle"` reason defined in Step 2, produced in Step 3, consumed in Step 4.

**Known test-scope limitation (logged, not silent):** Layer 3 (Task 4) has no direct e2e — it is only reachable under estimate drift, which Anvil's local estimation can't reproduce. Verified by build + classifier string matching. Tasks 1's caps resolver for Arbitrum/Polygon is verified by code (Anvil exercises only the default path). A follow-up unit test is the upgrade path if src unit infra is added.
