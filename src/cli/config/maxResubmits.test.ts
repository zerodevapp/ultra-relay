import { describe, expect, it } from "vitest"
import { z } from "zod"
import { executorArgsSchema } from "./bundler"

describe("max-resubmits option", () => {
    const maxResubmits = executorArgsSchema.shape["max-resubmits"]

    it("defaults to 3", () => {
        expect(maxResubmits.parse(undefined)).toBe(3)
    })

    it("accepts 0", () => {
        expect(maxResubmits.parse(0)).toBe(0)
    })

    it("rejects a negative value", () => {
        expect(() => maxResubmits.parse(-1)).toThrow(z.ZodError)
    })
})
