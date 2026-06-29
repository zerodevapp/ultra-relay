import { deepHexlify } from "permissionless"
import { parseEther } from "viem"
import {
    type EntryPointVersion,
    entryPoint07Address
} from "viem/account-abstraction"
import { beforeEach, describe, expect, inject, test } from "vitest"
import {
    beforeEachCleanUp,
    getSmartAccountClient,
    sendBundleNow,
    setBundlingMode
} from "../src/utils/index.js"

// Fire sendBundleNow n times; ignore errors on later calls (queue may be dry).
const drainBundles = async ({
    altoRpc,
    times
}: { altoRpc: string; times: number }) => {
    for (let i = 0; i < times; i++) {
        try {
            await sendBundleNow({ altoRpc })
        } catch {
            // queue drained early — fine
        }
        // Wait for Anvil to mine + bundler block-watcher to tick (100ms poll).
        await new Promise((r) => setTimeout(r, 300))
    }
}

// Anvil reports chainId 31337 -> getBundleCaps falls to the conservative
// default { gas: 16_777_216, bytes: 131_072 }. These tests craft ops that
// exceed those defaults and assert the bundler SPLITS them across multiple
// handleOps transactions (distinct receipt.transactionHash values).
//
// Each op comes from a SEPARATE smart account so nonces are independent —
// all ops land in `outstanding` immediately rather than the nonce-sequenced
// `queued` pool, which would block the second sendBundleNow call.
describe("bundle cap guardrails", () => {
    const entryPointVersion: EntryPointVersion = "0.7"
    const TO_ADDRESS = "0x23B608675a2B2fB1890d3ABBd85c5775c51691d5"

    const anvilRpc = inject("anvilRpc")
    const altoRpc = inject("altoRpc")

    beforeEach(async () => {
        await beforeEachCleanUp({ anvilRpc, altoRpc })
    })

    const distinctBundleTxs = (
        receipts: { receipt: { transactionHash: string } }[]
    ): number => new Set(receipts.map((r) => r.receipt.transactionHash)).size

    test("splits a batch that exceeds the per-tx gas cap", async () => {
        // Deploy two independent accounts (auto-bundling still on during deploy).
        const clients = await Promise.all(
            [0, 1].map(() =>
                getSmartAccountClient({ entryPointVersion, anvilRpc, altoRpc })
            )
        )
        await Promise.all(
            clients.map(async (client) => {
                const h = await client.sendUserOperation({
                    calls: [
                        { to: client.account.address, value: 0n, data: "0x" }
                    ]
                })
                await client.waitForUserOperationReceipt({ hash: h })
            })
        )

        await setBundlingMode({ mode: "manual", altoRpc })

        // Two ops at ~9M callGasLimit each — each fits alone (<16.77M cap) but
        // together project >16.77M, so packing must place them in separate bundles.
        const hashes = await Promise.all(
            clients.map((client) =>
                client.sendUserOperation({
                    calls: [
                        {
                            to: TO_ADDRESS,
                            value: parseEther("0.001"),
                            data: "0x"
                        }
                    ],
                    callGasLimit: 9_000_000n
                })
            )
        )

        // 2 ops → 2 bundles; drain both.
        await drainBundles({ altoRpc, times: 2 })

        const receipts = await Promise.all(
            hashes.map((hash) =>
                clients[0].waitForUserOperationReceipt({ hash })
            )
        )

        expect(receipts.every((r) => r.success)).toEqual(true)
        expect(distinctBundleTxs(receipts)).toBeGreaterThanOrEqual(2)
    })

    test("splits a batch that exceeds the per-tx byte cap", async () => {
        // Three independent accounts so all ops are immediately outstanding.
        const clients = await Promise.all(
            [0, 1, 2].map(() =>
                getSmartAccountClient({ entryPointVersion, anvilRpc, altoRpc })
            )
        )
        await Promise.all(
            clients.map(async (client) => {
                const h = await client.sendUserOperation({
                    calls: [
                        { to: client.account.address, value: 0n, data: "0x" }
                    ]
                })
                await client.waitForUserOperationReceipt({ hash: h })
            })
        )

        await setBundlingMode({ mode: "manual", altoRpc })

        // ~50 KB calldata per op. Three ops (~150 KB) exceed the 128 KiB byte
        // cap (margined to ~117 KB), forcing a split.
        const fatData = `0x${"00".repeat(50_000)}` as `0x${string}`
        const hashes = await Promise.all(
            clients.map((client) =>
                client.sendUserOperation({
                    calls: [{ to: TO_ADDRESS, value: 0n, data: fatData }],
                    callGasLimit: 1_000_000n
                })
            )
        )

        // 3 ops split across ≥2 bundles; drain up to 3 times.
        await drainBundles({ altoRpc, times: 3 })

        const receipts = await Promise.all(
            hashes.map((hash) =>
                clients[0].waitForUserOperationReceipt({ hash })
            )
        )

        expect(receipts.every((r) => r.success)).toEqual(true)
        expect(distinctBundleTxs(receipts)).toBeGreaterThanOrEqual(2)
    })

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
        //
        // Adaptation: the smart-account client's prepareUserOperation runs
        // local simulation which fails on 140 KB calldata before reaching the
        // bundler. We bypass that by preparing a normal op, replacing callData
        // with the encoded huge-data call, re-signing, then sending via raw
        // eth_sendUserOperation so the ingress cap check is what rejects it.
        const hugeData = `0x${"00".repeat(140_000)}` as `0x${string}`

        const op = await client.prepareUserOperation({
            calls: [{ to: TO_ADDRESS, value: 0n, data: "0x" }]
        })
        op.callData = await client.account.encodeCalls([
            { to: TO_ADDRESS, value: 0n, data: hugeData }
        ])
        op.callGasLimit = 2_000_000n
        // @ts-expect-error — op is pre-prepared but factory/factoryData need undefined for deployed account
        op.signature = await client.account.signUserOperation({
            ...op,
            factory: undefined,
            factoryData: undefined
        })

        await expect(async () => {
            await client.request({
                // @ts-ignore
                method: "eth_sendUserOperation",
                // @ts-ignore
                params: [deepHexlify(op), entryPoint07Address]
            })
        }).rejects.toThrowError(
            expect.objectContaining({
                details: expect.stringMatching(
                    /exceeds the per-transaction calldata size cap/i
                )
            })
        )
    })
})
