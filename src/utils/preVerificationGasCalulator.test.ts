import type { UserOperation } from "@alto/types"
import { describe, expect, it } from "vitest"
import type { AltoConfig } from "../createConfig"
import { calcExecutionPvgComponent } from "./preVerificationGasCalulator"

// Only multiplier fields are consulted by the execution PVG calculator.
const config = {
    v6CallGasLimitMultiplier: 120n,
    v6VerificationGasLimitMultiplier: 120n,
    v7CallGasLimitMultiplier: 120n,
    v7PaymasterPostOpGasLimitMultiplier: 120n
} as unknown as AltoConfig

const makeUserOp = (bytes: number): UserOperation => ({
    sender: "0x0000000000000000000000000000000000000001",
    nonce: 0n,
    initCode: "0x",
    callData: `0x${"ff".repeat(bytes)}`,
    callGasLimit: 30_000n,
    verificationGasLimit: 50_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    paymasterAndData: "0x",
    signature: `0x${"ff".repeat(65)}`
})

function pvg(userOp: UserOperation, supportsEip7623 = true) {
    return calcExecutionPvgComponent({ userOp, config, supportsEip7623 })
}

describe("v0.6 EIP-7623 PVG", () => {
    it.each([2048, 4096, 8192])(
        "cannot lower the calldata floor by padding gas limits (%s bytes)",
        (bytes) => {
            const userOp = makeUserOp(bytes)
            const minimum = pvg(userOp)
            expect(minimum).toBeGreaterThan(pvg(userOp, false))
            for (const padding of [
                { callGasLimit: 10_000_000n },
                { verificationGasLimit: 10_000_000n },
                {
                    callGasLimit: 10_000_000n,
                    verificationGasLimit: 10_000_000n
                }
            ]) {
                expect(pvg({ ...userOp, ...padding })).toBe(minimum)
            }
        }
    )

    it("preserves the pre-7623 calculation when disabled", () => {
        const userOp = makeUserOp(4096)
        expect(pvg({ ...userOp, callGasLimit: 10_000_000n }, false)).toBe(
            pvg(userOp, false)
        )
    })

    it("charges more overhead for more nonzero calldata", () => {
        expect(pvg(makeUserOp(8192))).toBeGreaterThan(pvg(makeUserOp(4096)))
    })
})
