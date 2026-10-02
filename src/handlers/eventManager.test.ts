import type { OpEventType } from "@alto/types"
import type { Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { executorArgsSchema } from "../cli/config/bundler"
import { EventManager } from "./eventManager"

vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

describe("submitted events with an optional network quote", () => {
    it("keeps the producer optimization disabled by default", () => {
        expect(
            executorArgsSchema.shape["arbitrum-skip-network-gas-price"].parse(
                undefined
            )
        ).toBe(false)
    })

    it.each([undefined, 0n, 30n])(
        "reports a quote of %s without inventing a missing value",
        (quote) => {
            const emitEvent =
                vi.fn<(args: { userOpHash: Hex; event: OpEventType }) => void>()
            EventManager.prototype.emitSubmitted.call(
                { emitEvent } as unknown as EventManager,
                {
                    userOpHashes: [`0x${"11".repeat(32)}`],
                    transactionHash: `0x${"22".repeat(32)}`,
                    submissionAttempts: 0,
                    bundlerMaxFeePerGas: 100n,
                    bundlerMaxPriorityFeePerGas: 1n,
                    networkBaseFee: 20n,
                    networkMaxFeePerGas: quote,
                    networkMaxPriorityFeePerGas: quote
                }
            )
            expect(emitEvent).toHaveBeenCalledTimes(1)
            const { event } = emitEvent.mock.calls[0][0]
            if (event.eventType !== "submitted") {
                throw new Error("wrong event")
            }
            expect(event.data.bundlerMaxFeePerGas).toBe("0x64")
            expect(event.data.networkBaseFee).toBe("0x14")
            if (quote === undefined) {
                expect(event.data).not.toHaveProperty("networkMaxFeePerGas")
                expect(event.data).not.toHaveProperty(
                    "networkMaxPriorityFeePerGas"
                )
            } else {
                expect(event.data.networkMaxFeePerGas).toBe(
                    `0x${quote.toString(16)}`
                )
            }
        }
    )
})
