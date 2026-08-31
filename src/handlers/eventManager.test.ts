import { describe, expect, test } from "vitest"
import { EventManager } from "./eventManager"

// emitSubmitted feeds the Redis events queue, which is consumed outside this
// process. Built through the prototype so the real method runs against a
// stubbed emitEvent, and the payload can be inspected as a consumer sees it.
const capture = () => {
    const emitted: { data: Record<string, unknown> }[] = []
    const manager = Object.create(EventManager.prototype)
    Object.assign(manager, {
        // biome-ignore lint/suspicious/noExplicitAny: stubbing a private method
        emitEvent: ({ event }: any) => emitted.push(event)
    })
    return { manager, emitted }
}

const submitted = {
    userOpHashes: ["0xop" as const],
    transactionHash: "0xtx" as const,
    submissionAttempts: 0,
    bundlerMaxFeePerGas: 5n,
    bundlerMaxPriorityFeePerGas: 5n,
    networkBaseFee: 7n
}

describe("emitSubmitted network fees", () => {
    test("reports the network price when one was fetched", () => {
        const { manager, emitted } = capture()

        manager.emitSubmitted({
            ...submitted,
            networkMaxFeePerGas: 2n,
            networkMaxPriorityFeePerGas: 1n
        })

        expect(emitted[0].data).toMatchObject({
            networkMaxFeePerGas: "0x2",
            networkMaxPriorityFeePerGas: "0x1"
        })
    })

    // Where the ordering policy does not bid for position the price is never
    // fetched. Emitting 0x0 there would be indistinguishable from the network
    // genuinely asking for zero, so the keys are absent instead — a consumer
    // can tell "not measured" from "measured as zero" only if we omit them.
    test("omits the keys entirely when no price was fetched", () => {
        const { manager, emitted } = capture()

        manager.emitSubmitted({
            ...submitted,
            networkMaxFeePerGas: undefined,
            networkMaxPriorityFeePerGas: undefined
        })

        expect(emitted[0].data).not.toHaveProperty("networkMaxFeePerGas")
        expect(emitted[0].data).not.toHaveProperty(
            "networkMaxPriorityFeePerGas"
        )
        // The one fee input that still matters on those chains must survive.
        expect(emitted[0].data).toMatchObject({ networkBaseFee: "0x7" })
    })
})
