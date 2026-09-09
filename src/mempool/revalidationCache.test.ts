import type { StorageMap, UserOpInfo, UserOperation } from "@alto/types"
import { type Address, type Hex, getAddress } from "viem"
import { describe, expect, it } from "vitest"
import type { AltoConfig } from "../createConfig"
import { MemoryOutstanding } from "../store/createMemoryOutstandingStore"
import { Mempool } from "./mempool"
import { ReputationStatuses } from "./reputationManager"
import { RevalidationCache } from "./revalidationCache"

const entryPoint = `0x${"22".repeat(20)}` as Address
const POOR_PAYMASTER = getAddress(`0x${"d4".repeat(20)}`)
const COLLIDING = getAddress(`0x${"e5".repeat(20)}`)
const hashOf = (id: number) => `0x${id.toString(16).padStart(64, "0")}` as Hex
const sender = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address

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

type OpSpec = {
    id: number
    sender?: Address
    paymaster?: Address
    storageTouches?: Address[]
}

function makeOp(spec: OpSpec): UserOpInfo {
    return {
        userOp: {
            sender: spec.sender ?? sender(spec.id),
            nonce: 0n,
            initCode: "0x",
            callData: "0x",
            callGasLimit: 100_000n,
            verificationGasLimit: 100_000n,
            preVerificationGas: 50_000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            paymasterAndData: spec.paymaster
                ? (`${spec.paymaster}00` as Hex)
                : "0x",
            signature: "0x"
        },
        userOpHash: hashOf(spec.id),
        addedToMempool: 0,
        submissionAttempts: 0,
        referencedContracts: { addresses: [], hash: "0x" },
        storageMap: {}
    } as UserOpInfo
}

const validationFor = (spec: OpSpec) => {
    const touched: StorageMap = {}
    for (const address of spec.storageTouches ?? []) {
        touched[address] = "0x"
    }
    return { returnInfo: { prefund: 5_000_000_000n }, storageMap: touched }
}

/**
 * Real Mempool over the real memory outstanding store, with the validator and
 * the node's block number faked. `blockNumber` is what a bundling tick reads;
 * `cachePrimedAt` is the block the admission trace is claimed to have run at.
 */
function fixture({
    specs,
    blockNumber,
    cachePrimedAt,
    blockReadFails = false
}: {
    specs: OpSpec[]
    blockNumber: bigint
    cachePrimedAt?: bigint
    blockReadFails?: boolean
}) {
    const traced: string[] = []
    const config = {
        safeMode: true,
        enforceUniqueSendersPerBundle: true,
        chainId: 412346,
        chainType: "default",
        entrypoints: [entryPoint],
        maxGasPerBundle: 20_000_000n,
        bundleValidationConcurrency: 1,
        mempoolMaxParallelOps: 100,
        mempoolMaxQueuedOps: 100,
        logLevel: "silent",
        getLogger: () => silentLogger,
        revalidationCache: true,
        revalidationCacheSize: 10,
        publicClient: {
            readContract: async ({ args }: { args: [Address] }) =>
                args[0] === POOR_PAYMASTER ? 1n : 10_000_000_000n,
            getBlockNumber: async () => {
                if (blockReadFails) {
                    throw new Error("node unreachable")
                }
                return blockNumber
            }
        }
    } as unknown as AltoConfig

    const outstanding = new MemoryOutstanding(config)
    const store = {
        peekOutstanding: () => outstanding.peek(),
        popOutstanding: () => outstanding.pop(),
        addOutstanding: async ({ userOpInfo }: { userOpInfo: UserOpInfo }) =>
            await outstanding.add(userOpInfo),
        restoreOutstanding: async ({
            userOpInfos
        }: { userOpInfos: UserOpInfo[] }) =>
            await outstanding.restore(userOpInfos),
        addProcessing: async () => {},
        dumpOutstanding: () => outstanding.dumpLocal(),
        getQueuedOutstandingUserOps: ({ userOp }: { userOp: UserOperation }) =>
            outstanding.getQueuedUserOps(userOp),
        removeProcessing: async () => {},
        removeSubmitted: async () => {}
    }

    const validateUserOp = async ({ userOp }: { userOp: UserOperation }) => {
        const spec = specs.find(
            (s) => (s.sender ?? sender(s.id)) === userOp.sender
        )
        if (!spec) {
            throw new Error("unknown userOp in validator")
        }
        traced.push(hashOf(spec.id))
        return validationFor(spec)
    }

    const mempool = Object.create(Mempool.prototype) as Mempool
    Object.assign(mempool, {
        config,
        store,
        logger: silentLogger,
        reputationManager: {
            getStatus: () => ReputationStatuses.ok,
            decreaseUserOpSeenStatus: async () => {},
            decreaseUserOpCount: () => {}
        },
        validator: { validateUserOp },
        monitor: { setUserOpStatus: async () => {} },
        eventManager: { emitDropped: () => {} },
        throttledEntityBundleCount: 4,
        revalidationCache: new RevalidationCache(10)
    })
    ;(
        mempool as unknown as { validationSemaphore: unknown }
    ).validationSemaphore = new (require("async-mutex").Semaphore)(1)

    const cache = (
        mempool as unknown as {
            revalidationCache: RevalidationCache<ReturnType<
                typeof validationFor
            >>
        }
    ).revalidationCache

    return {
        mempool,
        cache,
        traced,
        async load() {
            for (const spec of specs) {
                await outstanding.add(makeOp(spec))
                if (cachePrimedAt !== undefined) {
                    cache.set(
                        hashOf(spec.id),
                        cachePrimedAt,
                        validationFor(spec)
                    )
                }
            }
        }
    }
}

async function run(args: Parameters<typeof fixture>[0]) {
    const f = fixture(args)
    await f.load()
    const bundles = await f.mempool.getBundles()
    return {
        bundles: bundles.map((b) => b.userOps.map((o) => o.userOpHash)),
        traced: f.traced,
        stats: { ...f.cache.stats },
        cacheSize: f.cache.size
    }
}

describe("RevalidationCache semantics", () => {
    it("returns a result only at the block the tick observed", () => {
        const cache = new RevalidationCache<string>()
        cache.set(hashOf(1), 10n, "traced-at-10")
        cache.observeBlock(10n)
        expect(cache.take(hashOf(1))).toBe("traced-at-10")
        expect(cache.stats.hit).toBe(1)
    })

    it("reports stale rather than reusing a result from another block", () => {
        const cache = new RevalidationCache<string>()
        cache.set(hashOf(1), 10n, "traced-at-10")
        cache.observeBlock(11n)
        expect(cache.take(hashOf(1))).toBeUndefined()
        expect(cache.stats.stale).toBe(1)
    })

    it("never hits when no tick has observed a block", () => {
        const cache = new RevalidationCache<string>()
        cache.set(hashOf(1), 10n, "traced-at-10")
        expect(cache.take(hashOf(1))).toBeUndefined()
        expect(cache.stats.stale).toBe(1)
        expect(cache.stats.hit).toBe(0)
    })

    it("consumes the entry on a hit and on a stale read alike", () => {
        const cache = new RevalidationCache<string>()
        cache.set(hashOf(1), 10n, "a")
        cache.set(hashOf(2), 10n, "b")
        cache.observeBlock(10n)
        expect(cache.take(hashOf(1))).toBe("a")
        expect(cache.take(hashOf(1))).toBeUndefined()
        cache.observeBlock(99n)
        expect(cache.take(hashOf(2))).toBeUndefined()
        expect(cache.take(hashOf(2))).toBeUndefined()
        expect(cache.size).toBe(0)
        expect(cache.stats.missing).toBe(2)
    })

    it("evicts oldest first and stays inside its capacity", () => {
        const cache = new RevalidationCache<string>(3)
        for (let i = 1; i <= 5; i++) {
            cache.set(hashOf(i), 10n, `v${i}`)
        }
        cache.observeBlock(10n)
        expect(cache.size).toBe(3)
        expect(cache.stats.evicted).toBe(2)
        expect(cache.take(hashOf(1))).toBeUndefined()
        expect(cache.take(hashOf(5))).toBe("v5")
    })
})

describe("bundle-time reuse through the real mempool", () => {
    const specs: OpSpec[] = [{ id: 1 }, { id: 2 }, { id: 3 }]

    it("skips the bundle-time trace when admission traced the same block", async () => {
        const r = await run({ specs, blockNumber: 100n, cachePrimedAt: 100n })
        expect(r.traced).toEqual([])
        expect(r.stats.hit).toBe(3)
        expect(r.bundles).toEqual([[hashOf(1), hashOf(2), hashOf(3)]])
    })

    it("traces every op when a block was mined since admission", async () => {
        const r = await run({ specs, blockNumber: 101n, cachePrimedAt: 100n })
        expect(r.traced).toEqual([hashOf(1), hashOf(2), hashOf(3)])
        expect(r.stats.hit).toBe(0)
        expect(r.stats.stale).toBe(3)
    })

    it("produces the same bundle whether the result was reused or retraced", async () => {
        const reused = await run({
            specs,
            blockNumber: 100n,
            cachePrimedAt: 100n
        })
        const retraced = await run({ specs, blockNumber: 101n })
        expect(reused.bundles).toEqual(retraced.bundles)
    })

    it("traces every op when the tick's block read fails", async () => {
        const r = await run({
            specs,
            blockNumber: 100n,
            cachePrimedAt: 100n,
            blockReadFails: true
        })
        expect(r.traced).toEqual([hashOf(1), hashOf(2), hashOf(3)])
        expect(r.stats.hit).toBe(0)
    })

    it("leaves no entry behind after a bundling tick", async () => {
        const r = await run({ specs, blockNumber: 100n, cachePrimedAt: 100n })
        expect(r.cacheSize).toBe(0)
    })
})

describe("a reused result is still subject to every post-validation check", () => {
    it("skips an op whose reused storageMap collides with a bundled sender", async () => {
        const specs: OpSpec[] = [
            { id: 1, sender: COLLIDING },
            { id: 2, storageTouches: [COLLIDING] },
            { id: 3 }
        ]
        const r = await run({ specs, blockNumber: 100n, cachePrimedAt: 100n })
        expect(r.stats.hit).toBe(3)
        expect(r.bundles[0]).toContain(hashOf(1))
        expect(r.bundles[0]).not.toContain(hashOf(2))
    })

    it("skips an op whose paymaster cannot cover the reused prefund", async () => {
        const specs: OpSpec[] = [
            { id: 1, paymaster: POOR_PAYMASTER },
            { id: 2 }
        ]
        const r = await run({ specs, blockNumber: 100n, cachePrimedAt: 100n })
        expect(r.stats.hit).toBe(2)
        expect(r.bundles[0]).not.toContain(hashOf(1))
        expect(r.bundles[0]).toContain(hashOf(2))
    })
})
