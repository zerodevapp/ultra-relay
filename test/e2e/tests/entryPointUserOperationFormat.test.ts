import { zeroAddress } from "viem"
import { entryPoint06Address } from "viem/account-abstraction"
import { expect, inject, test } from "vitest"

const altoRpc = inject("altoRpc")

test.each(["eth_estimateUserOperationGas", "eth_sendUserOperation"])(
    "%s rejects a UserOperation without v0.6 fields on EntryPoint v0.6",
    async (method) => {
        const userOperation = {
            sender: zeroAddress,
            nonce: "0x0",
            callData: "0x",
            callGasLimit: "0x186a0",
            verificationGasLimit: "0x186a0",
            preVerificationGas: "0xc350",
            maxFeePerGas: "0x3b9aca00",
            maxPriorityFeePerGas: "0x3b9aca00",
            signature: "0x"
        }
        const response = await fetch(altoRpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                params: [userOperation, entryPoint06Address]
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            error: {
                code: -32602,
                message:
                    "EntryPoint v0.6 requires initCode and paymasterAndData"
            }
        })
    }
)
