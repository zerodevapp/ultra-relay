import type { HexData32 } from "@alto/types"

/**
 * Admission-time validation results held for reuse at bundle time.
 *
 * Every userOp is traced twice today: once to admit it (`getUserOpValidationResult`)
 * and once when it is picked for a bundle (`shouldSkip.validate`). Measured on the
 * local harness the second trace starts 25 to 55 ms (p50) after the first ends, well
 * inside one block, so it re-derives state that cannot have changed.
 *
 * This cache reuses the admission result only when the admission trace provably ran
 * at the block the bundling tick observed. It is NOT equivalent to per-op
 * revalidation: it is same-block reuse, and it is off by default.
 *
 * Staleness argument for the residual window (a block may be mined between the tick's
 * block read and the moment a candidate is replayed): the serial sweep already traces
 * op #1 and op #50 of the same bundle several blocks apart and submits them together,
 * so a reuse bounded to one block behind `latest` is strictly less stale than what the
 * existing loop accepts for its own early-popped ops. The intra-bundle conflict checks
 * (senders, storageMap collisions, paymaster deposit accumulator) run on the reused
 * result exactly as they do on a fresh one.
 */
export type CachedValidation<T> = {
    blockNumber: bigint
    result: T
}

export type RevalidationCacheStats = {
    stored: number
    hit: number
    missing: number
    stale: number
    evicted: number
    unbracketed: number
}

export class RevalidationCache<T> {
    private entries = new Map<HexData32, CachedValidation<T>>()
    private observedBlock?: bigint
    private readonly capacity: number
    readonly stats: RevalidationCacheStats = {
        stored: 0,
        hit: 0,
        missing: 0,
        stale: 0,
        evicted: 0,
        unbracketed: 0
    }

    constructor(capacity = 10_000) {
        this.capacity = Math.max(1, capacity)
    }

    /**
     * Records the block a bundling tick is working against. `take` only returns a
     * result captured at exactly this block, so a cache that is never refreshed
     * never hits.
     */
    observeBlock(blockNumber: bigint) {
        this.observedBlock = blockNumber
    }

    /** Counts an admission whose block bracket moved, so nothing could be cached. */
    recordUnbracketed() {
        this.stats.unbracketed++
    }

    /**
     * `blockNumber` must be a block the trace provably ran at: read before and after
     * the trace and equal. A caller that cannot prove that must not call this.
     */
    set(userOpHash: HexData32, blockNumber: bigint, result: T) {
        if (this.entries.has(userOpHash)) {
            this.entries.delete(userOpHash)
        }
        this.entries.set(userOpHash, { blockNumber, result })
        this.stats.stored++
        while (this.entries.size > this.capacity) {
            const oldest = this.entries.keys().next()
            if (oldest.done) {
                break
            }
            this.entries.delete(oldest.value)
            this.stats.evicted++
        }
    }

    /**
     * Consumes the entry for `userOpHash`. Always removes it, hit or miss: a userOp
     * that reaches bundle time has had its one chance at reuse, and a re-entered op
     * must be traced again.
     */
    take(userOpHash: HexData32): T | undefined {
        const entry = this.entries.get(userOpHash)
        if (!entry) {
            this.stats.missing++
            return undefined
        }
        this.entries.delete(userOpHash)
        if (
            this.observedBlock === undefined ||
            entry.blockNumber !== this.observedBlock
        ) {
            this.stats.stale++
            return undefined
        }
        this.stats.hit++
        return entry.result
    }

    /** Drops an entry without counting it as a bundle-time outcome. */
    delete(userOpHash: HexData32) {
        this.entries.delete(userOpHash)
    }

    get size() {
        return this.entries.size
    }
}
