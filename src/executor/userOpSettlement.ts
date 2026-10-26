import { setTimeout as sleep } from "node:timers/promises"
import type { EventManager } from "@alto/handlers"
import type { Monitor } from "@alto/mempool"
import type { OpEventType, UserOperationReceipt } from "@alto/types"
import type { Hex } from "viem"
import type { BundleManager } from "./bundleManager"

export type UserOpSettlement =
    | { kind: "receipt"; receipt: UserOperationReceipt }
    | { kind: "dropped"; reason: string }
    | { kind: "timeout" }

type Settled = { kind: "included" } | { kind: "dropped"; reason: string }

const TIMEOUT = { kind: "timeout" } as const
const INCLUDED = { kind: "included" } as const

// The op is onchain in a transaction whose receipt carries its event, whether
// its call succeeded, reverted, or another bundler included it.
const INCLUDED_EVENTS = new Set<OpEventType["eventType"]>([
    "included_onchain",
    "execution_reverted_onchain",
    "frontran_onchain"
])

const fromEvent = (event: OpEventType): Settled | undefined => {
    if (INCLUDED_EVENTS.has(event.eventType)) {
        return INCLUDED
    }
    switch (event.eventType) {
        case "dropped":
        case "failed_onchain":
            return {
                kind: "dropped",
                reason: event.data.reason ?? event.eventType
            }
        default:
            return undefined
    }
}

// Resolves once the op settles or the deadline passes. Events from this
// process settle it immediately. The status store is read once, which covers
// events emitted before the watch was registered, then every pollIntervalMs:
// with horizontal scaling the store is shared and another instance may settle
// the op, and its events never reach this process.
export async function waitForUserOpSettlement({
    userOpHash,
    timeoutMs,
    pollIntervalMs,
    eventManager,
    monitor,
    bundleManager
}: {
    userOpHash: Hex
    timeoutMs: number
    pollIntervalMs: number
    eventManager: Pick<EventManager, "watchUserOp">
    monitor: Pick<Monitor, "getUserOpStatus">
    bundleManager: Pick<BundleManager, "getUserOpReceipt">
}): Promise<UserOpSettlement> {
    const abort = new AbortController()
    const { signal } = abort
    let unwatch = () => {}

    const fromEvents = new Promise<Settled>((resolve) => {
        unwatch = eventManager.watchUserOp(userOpHash, (event) => {
            const settled = fromEvent(event)
            if (settled) {
                resolve(settled)
            }
        })
    })

    const fromStatus = async (): Promise<Settled> => {
        for (;;) {
            const { status } = await monitor
                .getUserOpStatus(userOpHash)
                .catch(() => ({ status: "not_found" as const }))
            if (status === "included") {
                return INCLUDED
            }
            if (status === "rejected" || status === "failed") {
                return { kind: "dropped", reason: status }
            }
            await sleep(pollIntervalMs, undefined, { signal })
        }
    }

    try {
        const settled = await Promise.race([
            fromEvents,
            fromStatus(),
            sleep(timeoutMs, TIMEOUT, { signal })
        ])
        if (settled.kind !== "included") {
            return settled
        }
        const receipt = await bundleManager.getUserOpReceipt(userOpHash)
        return receipt ? { kind: "receipt", receipt } : TIMEOUT
    } finally {
        abort.abort()
        unwatch()
    }
}
