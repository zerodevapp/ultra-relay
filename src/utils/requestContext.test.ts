import { describe, expect, it } from "vitest"
import {
    addLogContext,
    getLogContext,
    runWithLogContext
} from "./requestContext"

describe("requestContext", () => {
    it("exposes context inside run and not outside", () => {
        expect(getLogContext()).toBeUndefined()
        runWithLogContext({ flow: "test" }, () => {
            expect(getLogContext()).toEqual({ flow: "test" })
        })
        expect(getLogContext()).toBeUndefined()
    })

    it("follows async continuations", async () => {
        await runWithLogContext({ userOpHash: "0xabc" }, async () => {
            await new Promise((r) => setTimeout(r, 5))
            expect(getLogContext()?.userOpHash).toBe("0xabc")
        })
    })

    it("merges fields via addLogContext", () => {
        runWithLogContext({ flow: "send" }, () => {
            addLogContext({ userOpHash: "0xdef" })
            expect(getLogContext()).toEqual({
                flow: "send",
                userOpHash: "0xdef"
            })
        })
    })

    it("is a no-op outside a context", () => {
        addLogContext({ userOpHash: "0x123" })
        expect(getLogContext()).toBeUndefined()
    })

    it("isolates parallel flows", async () => {
        await Promise.all([
            runWithLogContext({ userOpHash: "0x1" }, async () => {
                await new Promise((r) => setTimeout(r, 10))
                expect(getLogContext()?.userOpHash).toBe("0x1")
            }),
            runWithLogContext({ userOpHash: "0x2" }, async () => {
                await new Promise((r) => setTimeout(r, 1))
                expect(getLogContext()?.userOpHash).toBe("0x2")
            })
        ])
    })
})
