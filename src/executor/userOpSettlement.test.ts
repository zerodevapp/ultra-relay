import type {
    OpEventType,
    UserOperationReceipt,
    UserOperationStatus
} from "@alto/types"
import type { Hex } from "viem"
import { describe, expect, it } from "vitest"
import { waitForUserOpSettlement } from "./userOpSettlement"

const userOpHash = `0x${"ab".repeat(32)}` as Hex
const otherHash = `0x${"ef".repeat(32)}` as Hex
const transactionHash = `0x${"cd".repeat(32)}` as Hex
const receipt = { userOpHash } as UserOperationReceipt

const included: OpEventType = {
    eventType: "included_onchain",
    transactionHash,
    data: { blockNumber: 1 }
}

// The three collaborators, with the event bus and status store driven by the test.
const harness = (
    initialStatus: UserOperationStatus["status"] = "not_submitted"
) => {
    const listeners = new Map<Hex, Set<(event: OpEventType) => void>>()
    let status = initialStatus
    let receiptReads = 0
    const deps = {
        eventManager: {
            watchUserOp: (
                hash: Hex,
                listener: (event: OpEventType) => void
            ) => {
                const set = listeners.get(hash) ?? new Set()
                listeners.set(hash, set)
                set.add(listener)
                return () => {
                    set.delete(listener)
                }
            }
        },
        monitor: {
            getUserOpStatus: () =>
                Promise.resolve({ status, transactionHash: null })
        },
        bundleManager: {
            getUserOpReceipt: () => {
                receiptReads++
                return Promise.resolve(receipt)
            }
        }
    }
    return {
        deps,
        emit: (hash: Hex, event: OpEventType) =>
            setTimeout(() => {
                for (const listener of listeners.get(hash) ?? []) {
                    listener(event)
                }
            }, 0),
        setStatus: (next: UserOperationStatus["status"]) => {
            status = next
        },
        watching: () => [...listeners.values()].some((set) => set.size > 0),
        receiptReads: () => receiptReads
    }
}

const wait = (
    h: ReturnType<typeof harness>,
    { timeoutMs = 5_000, pollIntervalMs = 5_000 } = {}
) =>
    waitForUserOpSettlement({
        userOpHash,
        timeoutMs,
        pollIntervalMs,
        ...h.deps
    })

describe("waitForUserOpSettlement", () => {
    it.each([
        "included_onchain",
        "execution_reverted_onchain",
        "frontran_onchain"
    ] as const)("returns the receipt on %s", async (eventType) => {
        const h = harness()
        h.emit(userOpHash, { ...included, eventType } as OpEventType)
        await expect(wait(h)).resolves.toEqual({ kind: "receipt", receipt })
        expect(h.receiptReads()).toBe(1)
    })

    it("returns dropped with the drop reason", async () => {
        const h = harness()
        h.emit(userOpHash, {
            eventType: "dropped",
            data: { reason: "AA25 invalid account nonce" }
        })
        await expect(wait(h)).resolves.toEqual({
            kind: "dropped",
            reason: "AA25 invalid account nonce"
        })
    })

    it("names the event when a failed onchain op carries no reason", async () => {
        const h = harness()
        h.emit(userOpHash, {
            eventType: "failed_onchain",
            transactionHash,
            data: { blockNumber: 1 }
        })
        await expect(wait(h)).resolves.toEqual({
            kind: "dropped",
            reason: "failed_onchain"
        })
    })

    it("ignores events that do not settle the op", async () => {
        const h = harness()
        h.emit(userOpHash, { eventType: "added_to_mempool" })
        await expect(wait(h, { timeoutMs: 50 })).resolves.toEqual({
            kind: "timeout"
        })
    })

    it("ignores another op's events", async () => {
        const h = harness()
        h.emit(otherHash, included)
        await expect(wait(h, { timeoutMs: 50 })).resolves.toEqual({
            kind: "timeout"
        })
    })

    it("settles from the status store when the event came before the watch", async () => {
        const h = harness("included")
        await expect(wait(h)).resolves.toEqual({ kind: "receipt", receipt })
    })

    it("polls the status store for an op another instance settles", async () => {
        const h = harness()
        setTimeout(() => h.setStatus("rejected"), 20)
        await expect(wait(h, { pollIntervalMs: 10 })).resolves.toEqual({
            kind: "dropped",
            reason: "rejected"
        })
    })

    it("stops watching on every exit", async () => {
        const h = harness()
        await wait(h, { timeoutMs: 20 })
        expect(h.watching()).toBe(false)

        const h2 = harness()
        h2.emit(userOpHash, included)
        await wait(h2)
        expect(h2.watching()).toBe(false)
    })
})
