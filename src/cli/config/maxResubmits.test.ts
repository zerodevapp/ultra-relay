import { describe, expect, it } from "vitest"
import { z } from "zod"
import { executorArgsSchema } from "./bundler"

describe("max-resubmits option", () => {
    const maxResubmits = executorArgsSchema.shape["max-resubmits"]

    // 7 sits just above a full stuck-bundle cycle (1 send + 4 fee bumps + 1
    // rotation send = 6 attempts), so such a userOp still gets one retry.
    it("defaults to 7", () => {
        expect(maxResubmits.parse(undefined)).toBe(7)
    })

    it("accepts 0", () => {
        expect(maxResubmits.parse(0)).toBe(0)
    })

    it("rejects a negative value", () => {
        expect(() => maxResubmits.parse(-1)).toThrow(z.ZodError)
    })
})
