import type { UserOpInfo } from "@alto/types"
import { describe, expect, it } from "vitest"
import { stampFirst, stampLatest } from "./stamps"

const makeUserOpInfo = (overrides: Partial<UserOpInfo> = {}): UserOpInfo =>
    ({
        userOpHash: "0x01",
        addedToMempool: 1000,
        submissionAttempts: 0,
        ...overrides
    }) as UserOpInfo

describe("stampLatest", () => {
    it("overwrites the field on every record", () => {
        const userOps = [makeUserOpInfo({ bundledAt: 1 }), makeUserOpInfo()]

        stampLatest(userOps, "bundledAt", 5000)

        expect(userOps.map((u) => u.bundledAt)).toEqual([5000, 5000])
    })
})

describe("stampFirst", () => {
    it("sets the field only where it is still unset", () => {
        const userOps = [makeUserOpInfo({ dispatchedAt: 1 }), makeUserOpInfo()]

        stampFirst(userOps, "dispatchedAt", 5000)

        expect(userOps.map((u) => u.dispatchedAt)).toEqual([1, 5000])
    })

    it("leaves other stamps alone", () => {
        const userOpInfo = makeUserOpInfo({ bundledAt: 7 })

        stampFirst([userOpInfo], "walletAcquiredAt", 5000)

        expect(userOpInfo).toMatchObject({
            bundledAt: 7,
            walletAcquiredAt: 5000
        })
        expect(userOpInfo.dispatchedAt).toBeUndefined()
    })
})
