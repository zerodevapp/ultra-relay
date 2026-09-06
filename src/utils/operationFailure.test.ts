import { describe, expect, it } from "vitest"
import { RpcError, ValidationErrors, type UserOpInfo, userOperationStatusSchema } from "@alto/types"
import { classifyOperationFailure, publicOperationReason, scheduleInfrastructureRetry } from "./operationFailure"

describe("operation failure policy", () => {
    it("only recognized validation codes establish invalidity", () => {
        expect(classifyOperationFailure(new RpcError("AA23 reverted", ValidationErrors.SimulateValidation))).toEqual({
            kind: "invalid_operation", retryable: false, reason: "AA23 reverted"
        })
        expect(classifyOperationFailure(new Error("execution reverted"))).toMatchObject({ kind: "upstream_error", retryable: true })
        expect(classifyOperationFailure({ data: { retryable: false }, code: -32500 })).toMatchObject({ retryable: true })
    })
    it("transport causes override an outer validation error", () => {
        const error = new RpcError("wrapped", ValidationErrors.SimulateValidation)
        Object.assign(error, { cause: { code: "ETIMEDOUT" } })
        expect(classifyOperationFailure(error)).toMatchObject({ kind: "upstream_timeout", retryable: true })
    })
    it("persists exactly three retries with eligibility deadlines", () => {
        let info = {} as UserOpInfo
        for (const [attempt, delay] of [250, 500, 1000].entries()) {
            expect(scheduleInfrastructureRetry(info, 100)).toBe(true)
            expect(info.infrastructureRetries).toBe(attempt + 1)
            expect(info.retryAfter).toBe(100 + delay)
            info = JSON.parse(JSON.stringify(info))
        }
        expect(scheduleInfrastructureRetry(info, 100)).toBe(false)
    })
    it("never publishes raw provider URLs or signed payloads", () => {
        const payload = "ab".repeat(65)
        const reason = publicOperationReason(`AA23 reverted https://rpc.test/secret signature: 0x${payload}`)
        expect(reason).toContain("AA23 reverted")
        expect(reason).not.toContain(payload)
        expect(reason).not.toContain("rpc.test")
        expect(reason.length).toBeLessThanOrEqual(500)
        expect(userOperationStatusSchema.parse({ status: "rejected", transactionHash: null, reason }).reason).toBe(reason)
        expect(userOperationStatusSchema.parse({ status: "rejected", transactionHash: null }).reason).toBeUndefined()
    })
})
