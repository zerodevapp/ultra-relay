import type { StorageMap, UserOpInfo, UserOperation } from "@alto/types"
import { RpcError, ValidationErrors } from "@alto/types"
import { type Address, type Hex, getAddress } from "viem"
import { describe, expect, it } from "vitest"
import type { AltoConfig } from "../createConfig"
import { MemoryOutstanding } from "../store/createMemoryOutstandingStore"
import { Mempool } from "./mempool"
import { ReputationStatuses } from "./reputationManager"

// Differential test: the concurrent bundling path must make exactly the
// decisions the untouched serial loop makes, for the same initial queue.
// Serial (C=1) is the reference; C=4 and C=8 are the candidates.

const entryPoints = [
    `0x${"22".repeat(20)}`,
    `0x${"23".repeat(20)}`
] as Address[]
const BANNED_PAYMASTER = getAddress(`0x${"a1".repeat(20)}`)
const THROTTLED_FACTORY = getAddress(`0x${"b2".repeat(20)}`)
const RICH_PAYMASTER = getAddress(`0x${"c3".repeat(20)}`)
const POOR_PAYMASTER = getAddress(`0x${"d4".repeat(20)}`)

type OpSpec = {
    id: number
    sender?: Address
    nonce?: bigint
    fee?: bigint
    paymaster?: Address
    factory?: Address
    storageTouches?: Address[]
    fail?: "transport" | "invalid"
    delayMs?: number
}

const sender = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const hashOf = (id: number) => `0x${id.toString(16).padStart(64, "0")}` as Hex

function makeOp(spec: OpSpec): UserOpInfo {
    const initCode = spec.factory ? (`${spec.factory}00` as Hex) : "0x"
    const paymasterAndData = spec.paymaster
        ? (`${spec.paymaster}00` as Hex)
        : "0x"
    return {
        userOp: {
            sender: spec.sender ?? sender(spec.id),
            nonce: spec.nonce ?? 0n,
            initCode,
            callData: "0x",
            callGasLimit: 100_000n,
            verificationGasLimit: 100_000n,
            preVerificationGas: 50_000n,
            maxFeePerGas: spec.fee ?? 1n,
            maxPriorityFeePerGas: 1n,
            paymasterAndData,
            signature: "0x"
        },
        userOpHash: hashOf(spec.id),
        addedToMempool: 0,
        submissionAttempts: 0,
        referencedContracts: { addresses: [], hash: "0x" },
        storageMap: {}
    } as UserOpInfo
}

const silentLogger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
        return silentLogger
    }
} as never

function buildConfig(
    concurrency: number,
    eps: Address[],
    gasCap: bigint
): AltoConfig {
    return {
        safeMode: true,
        enforceUniqueSendersPerBundle: true,
        chainId: 412346,
        chainType: "default",
        entrypoints: eps,
        maxGasPerBundle: gasCap,
        bundleValidationConcurrency: concurrency,
        mempoolMaxParallelOps: 100,
        mempoolMaxQueuedOps: 100,
        logLevel: "silent",
        getLogger: () => silentLogger,
        publicClient: {
            // EntryPoint.balanceOf for paymaster deposits.
            readContract: async ({ args }: { args: [Address] }) =>
                args[0] === RICH_PAYMASTER ? 10_000_000_000n : 1n
        }
    } as unknown as AltoConfig
}

type Fixture = {
    mempool: Mempool
    stores: Map<Address, MemoryOutstanding>
    log: string[]
    restores: string[][]
    validator: { calls: Map<string, unknown[]>; maxInflight: number }
    drain: () => Promise<Record<string, string[]>>
}

function fixture({
    specs,
    concurrency,
    entryPointsUsed = [entryPoints[0]],
    gasCap = 20_000_000n
}: {
    specs: OpSpec[]
    concurrency: number
    entryPointsUsed?: Address[]
    gasCap?: bigint
}): Fixture {
    const config = buildConfig(concurrency, entryPointsUsed, gasCap)
    const stores = new Map<Address, MemoryOutstanding>()
    const storeFor = (ep: Address) => {
        const found = stores.get(ep)
        if (!found) throw new Error(`no store for ${ep}`)
        return found
    }
    for (const ep of entryPointsUsed)
        stores.set(ep, new MemoryOutstanding(config))
    const log: string[] = []
    const restores: string[][] = []
    const byHash = new Map(specs.map((s) => [hashOf(s.id), s]))

    const store = {
        peekOutstanding: (ep: Address) => storeFor(ep).peek(),
        popOutstanding: (ep: Address) => storeFor(ep).pop(),
        addOutstanding: async ({
            entryPoint,
            userOpInfo
        }: { entryPoint: Address; userOpInfo: UserOpInfo }) => {
            log.push(`readd:${userOpInfo.userOpHash}`)
            await storeFor(entryPoint).add(userOpInfo)
        },
        restoreOutstanding: async ({
            entryPoint,
            userOpInfos
        }: { entryPoint: Address; userOpInfos: UserOpInfo[] }) => {
            restores.push(userOpInfos.map((o) => o.userOpHash))
            await storeFor(entryPoint).restore(userOpInfos)
        },
        addProcessing: async ({ userOpInfo }: { userOpInfo: UserOpInfo }) => {
            log.push(`processing:${userOpInfo.userOpHash}`)
        },
        dumpOutstanding: (ep: Address) => storeFor(ep).dumpLocal(),
        getQueuedOutstandingUserOps: ({
            userOp,
            entryPoint
        }: { userOp: UserOperation; entryPoint: Address }) =>
            storeFor(entryPoint).getQueuedUserOps(userOp),
        removeProcessing: async () => {},
        removeSubmitted: async () => {}
    }

    const validator = { calls: new Map<string, unknown[]>(), maxInflight: 0 }
    let inflight = 0
    const validateUserOp = async ({
        userOp,
        queuedUserOps,
        referencedContracts,
        storageMap
    }: {
        userOp: UserOperation
        queuedUserOps: UserOperation[]
        referencedContracts: unknown
        storageMap: StorageMap
    }) => {
        const spec = specs.find(
            (s) =>
                (s.sender ?? sender(s.id)) === userOp.sender &&
                (s.nonce ?? 0n) === userOp.nonce
        )
        if (!spec) throw new Error("unknown userOp in validator")
        const hash = hashOf(spec.id)
        validator.calls.set(hash, [
            ...(validator.calls.get(hash) ?? []),
            {
                queued: queuedUserOps.map((q) => `${q.sender}:${q.nonce}`),
                referencedContracts,
                storageMap
            }
        ])
        inflight++
        validator.maxInflight = Math.max(validator.maxInflight, inflight)
        // Completion order deliberately differs from pop order.
        await new Promise((r) =>
            setTimeout(r, spec.delayMs ?? ((13 - (spec.id % 13)) % 5) + 1)
        )
        inflight--
        if (spec.fail === "transport")
            throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })
        if (spec.fail === "invalid")
            throw new RpcError(
                "AA23 reverted",
                ValidationErrors.SimulateValidation
            )
        const touched: StorageMap = {}
        for (const address of spec.storageTouches ?? []) touched[address] = "0x"
        return { returnInfo: { prefund: 5_000_000_000n }, storageMap: touched }
    }

    const reputationManager = {
        getStatus: (_ep: Address, address: Address | null) => {
            if (address === BANNED_PAYMASTER) return ReputationStatuses.banned
            if (address === THROTTLED_FACTORY)
                return ReputationStatuses.throttled
            return ReputationStatuses.ok
        },
        decreaseUserOpSeenStatus: async (userOp: UserOperation) => {
            log.push(`seen-:${userOp.sender}`)
        },
        decreaseUserOpCount: (userOp: UserOperation) => {
            log.push(`count-:${userOp.sender}`)
        }
    }

    const mempool = Object.create(Mempool.prototype) as Mempool
    Object.assign(mempool, {
        config,
        store,
        logger: silentLogger,
        reputationManager,
        validator: { validateUserOp },
        monitor: {
            setUserOpStatus: async (
                hash: string,
                status: { status: string }
            ) => {
                log.push(`status:${hash}:${status.status}`)
            }
        },
        eventManager: { emitDropped: () => {} },
        throttledEntityBundleCount: 4
    })
    ;(
        mempool as unknown as { validationSemaphore: unknown }
    ).validationSemaphore = new (require("async-mutex").Semaphore)(concurrency)

    return {
        mempool,
        stores,
        log,
        validator,
        restores,
        drain: async () => {
            const out: Record<string, string[]> = {}
            for (const [ep, s] of stores) {
                const hashes: string[] = []
                for (;;) {
                    const info = await s.pop()
                    if (!info) break
                    hashes.push(info.userOpHash)
                }
                out[ep] = hashes
            }
            return out
        }
    }
}

async function run(
    specs: OpSpec[],
    concurrency: number,
    entryPointsUsed?: Address[],
    gasCap?: bigint
) {
    const f = fixture({ specs, concurrency, entryPointsUsed, gasCap })
    const eps = entryPointsUsed ?? [entryPoints[0]]
    for (const [i, spec] of specs.entries()) {
        const target = f.stores.get(eps[i % eps.length])
        if (!target) throw new Error("missing store")
        await target.add(makeOp(spec))
    }
    const bundles = await f.mempool.getBundles()
    return {
        bundles: bundles.map((b) => ({
            ep: b.entryPoint,
            ops: b.userOps.map((o) => o.userOpHash)
        })),
        log: f.log,
        queue: await f.drain(),
        validatorCalls: f.validator.calls,
        maxInflight: f.validator.maxInflight,
        restores: f.restores
    }
}

const withFees = (specs: OpSpec[], distinct: boolean) =>
    specs.map((s, i) => ({
        ...s,
        fee: distinct ? BigInt(100 + ((i * 37) % 50)) : 1n
    }))

type SerialResult = Awaited<ReturnType<typeof run>>
type Scenario = {
    specs: OpSpec[]
    gasCap?: bigint
    // Proves on the reference run that the scenario exercises its branch.
    expectSerial: (serial: SerialResult) => void
}

const scenarios: Record<string, Scenario> = {
    "twelve senders across gas-capped bundles": {
        specs: Array.from({ length: 12 }, (_, i) => ({ id: i + 1 })),
        gasCap: 1_400_000n,
        expectSerial: (r) => expect(r.bundles.length).toBeGreaterThanOrEqual(3)
    },
    "same sender twice: second is re-added, bundle keeps filling": {
        specs: [
            { id: 1 },
            { id: 2, sender: sender(1), nonce: 1n },
            { id: 3 },
            { id: 4 }
        ],
        expectSerial: (r) => {
            expect(r.log).toContain(`readd:${hashOf(2)}`)
            expect(r.bundles[0].ops).toEqual([hashOf(1), hashOf(3), hashOf(4)])
        }
    },
    "banned paymaster is dropped without a trace": {
        specs: [{ id: 1 }, { id: 2, paymaster: BANNED_PAYMASTER }, { id: 3 }],
        expectSerial: (r) => {
            expect(r.validatorCalls.has(hashOf(2))).toBe(false)
            expect(r.bundles[0].ops).toEqual([hashOf(1), hashOf(3)])
            expect(r.queue[entryPoints[0]]).toEqual([])
        }
    },
    "throttled factory crosses the bundle threshold mid-batch": {
        specs: Array.from({ length: 7 }, (_, i) => ({
            id: i + 1,
            factory: THROTTLED_FACTORY
        })),
        expectSerial: (r) => {
            expect(r.bundles[0].ops).toHaveLength(4)
            expect(r.log).toContain(`readd:${hashOf(5)}`)
        }
    },
    "storage collision with another outstanding sender": {
        specs: [
            { id: 1 },
            { id: 2, storageTouches: [sender(3)] },
            { id: 3 },
            { id: 4 }
        ],
        expectSerial: (r) => {
            expect(r.log).toContain(`readd:${hashOf(2)}`)
            expect(r.bundles[0].ops).not.toContain(hashOf(2))
        }
    },
    "paymaster deposit shortfall": {
        specs: [
            { id: 1, paymaster: RICH_PAYMASTER },
            { id: 2, paymaster: POOR_PAYMASTER },
            { id: 3, paymaster: RICH_PAYMASTER }
        ],
        expectSerial: (r) => {
            expect(r.log).toContain(`readd:${hashOf(2)}`)
            expect(r.bundles[0].ops).toEqual([hashOf(1), hashOf(3)])
        }
    },
    "transport failure on op 3 of 8 is retried, not penalized": {
        specs: Array.from({ length: 8 }, (_, i) => ({
            id: i + 1,
            fail: i === 2 ? ("transport" as const) : undefined
        })),
        expectSerial: (r) => {
            expect(r.log).toContain(`readd:${hashOf(3)}`)
            expect(r.log.some((l) => l.startsWith("seen-:"))).toBe(false)
            expect(r.log.some((l) => l.startsWith("status:"))).toBe(false)
        }
    },
    "deterministic failure on op 3 of 8 is dropped once": {
        specs: Array.from({ length: 8 }, (_, i) => ({
            id: i + 1,
            fail: i === 2 ? ("invalid" as const) : undefined
        })),
        expectSerial: (r) => {
            expect(r.log).toContain(`status:${hashOf(3)}:rejected`)
            expect(r.log.filter((l) => l.startsWith("seen-:"))).toHaveLength(1)
            expect(r.bundles[0].ops).toHaveLength(7)
        }
    },
    "mixed: skips, failures, caps and a full bundle": {
        specs: [
            { id: 1 },
            { id: 2, sender: sender(1), nonce: 1n },
            { id: 3, fail: "invalid" },
            { id: 4, paymaster: BANNED_PAYMASTER },
            { id: 5 },
            { id: 6, storageTouches: [sender(7)] },
            { id: 7 },
            { id: 8, fail: "transport" },
            { id: 9 },
            { id: 10 }
        ],
        gasCap: 1_400_000n,
        expectSerial: (r) => {
            expect(r.bundles.length).toBeGreaterThanOrEqual(2)
            expect(r.log).toContain(`status:${hashOf(3)}:rejected`)
            expect(r.log).toContain(`readd:${hashOf(8)}`)
        }
    }
}

describe("concurrent bundle-time revalidation equals the serial loop", () => {
    for (const [name, scenario] of Object.entries(scenarios)) {
        for (const distinct of [false, true]) {
            for (const concurrency of [4, 8]) {
                it(`${name} (${distinct ? "distinct" : "equal"} fees, C=${concurrency})`, async () => {
                    const feeSpecs = withFees(scenario.specs, distinct)
                    const serial = await run(
                        feeSpecs,
                        1,
                        undefined,
                        scenario.gasCap
                    )
                    if (!distinct) scenario.expectSerial(serial)
                    const candidate = await run(
                        feeSpecs,
                        concurrency,
                        undefined,
                        scenario.gasCap
                    )

                    expect(candidate.bundles).toEqual(serial.bundles)
                    expect(candidate.queue).toEqual(serial.queue)
                    // Reputation, processing and status effects, in order.
                    expect(candidate.log).toEqual(serial.log)
                    // Every operation validated by serial was validated with the
                    // same inputs by the candidate; the candidate may add
                    // discarded speculative traces, never different ones.
                    for (const [hash, calls] of serial.validatorCalls) {
                        const candidateCalls =
                            candidate.validatorCalls.get(hash) ?? []
                        expect(candidateCalls.length).toBeGreaterThanOrEqual(
                            calls.length
                        )
                        expect(candidateCalls.slice(0, calls.length)).toEqual(
                            calls
                        )
                    }
                    expect(serial.maxInflight).toBe(1)
                    expect(candidate.maxInflight).toBeLessThanOrEqual(
                        concurrency
                    )
                })
            }
        }
    }

    it("restores speculative leftovers when a re-add skip lands mid-batch", async () => {
        // After four ops the throttled factory hits its per-bundle count, so
        // op 5 is skipped with ops 6 and 7 already popped behind it.
        const specs = withFees(
            scenarios[
                "throttled factory crosses the bundle threshold mid-batch"
            ].specs,
            false
        )
        const serial = await run(specs, 1)
        const candidate = await run(specs, 4)
        expect(serial.restores).toEqual([])
        expect(candidate.restores[0]).toEqual([hashOf(6), hashOf(7)])
        expect(candidate.bundles).toEqual(serial.bundles)
        expect(candidate.queue).toEqual(serial.queue)
    })

    it("actually overlaps traces at C=4", async () => {
        const specs = Array.from({ length: 8 }, (_, i) => ({
            id: i + 1,
            delayMs: 20
        }))
        const candidate = await run(specs, 4)
        expect(candidate.maxInflight).toBeGreaterThan(1)
        expect(candidate.bundles[0].ops).toHaveLength(8)
    })

    it("shares one semaphore across entrypoints", async () => {
        const specs = Array.from({ length: 8 }, (_, i) => ({
            id: i + 1,
            delayMs: 20
        }))
        const serial = await run(specs, 1, entryPoints)
        const candidate = await run(specs, 2, entryPoints)
        expect(candidate.maxInflight).toBeLessThanOrEqual(2)
        expect(candidate.bundles).toEqual(serial.bundles)
        expect(candidate.queue).toEqual(serial.queue)
    })

    it("repeats deterministically at C=8 with shuffled latencies", async () => {
        const base = scenarios["mixed: skips, failures, caps and a full bundle"]
        const serial = await run(
            withFees(base.specs, true),
            1,
            undefined,
            base.gasCap
        )
        for (let seed = 1; seed <= 5; seed++) {
            const shuffled = withFees(base.specs, true).map((s, i) => ({
                ...s,
                delayMs: ((i * seed * 7) % 6) + 1
            }))
            const candidate = await run(shuffled, 8, undefined, base.gasCap)
            expect(candidate.bundles).toEqual(serial.bundles)
            expect(candidate.queue).toEqual(serial.queue)
            expect(candidate.log).toEqual(serial.log)
        }
    })
})
