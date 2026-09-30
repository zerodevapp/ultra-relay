import type { Account } from "viem"
import { describe, expect, it, vi } from "vitest"
import { SafeValidator } from "./SafeValidator"

// Importing SafeValidator reaches utils/logger, which builds a Logtail
// transport at module load when BETTER_STACK_TOKEN is set; see
// executorManager.test.ts.
vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

describe("SafeValidator.getCodeHashes", () => {
    it("does not leave a failed wallet release unhandled", async () => {
        const wallet = {
            address: "0x1111111111111111111111111111111111111111"
        } as unknown as Account
        const addresses = ["0x2222222222222222222222222222222222222222"]
        const releases: Account[] = []
        // Not vi.fn: a spy handles the promise it returns, which would hide
        // the unhandled rejection this test exists to catch.
        const markWalletProcessed = (released: Account) => {
            releases.push(released)
            return Promise.reject(new Error("redis down"))
        }
        // The code-hash getter always reverts; the hash is in the revert data.
        const reverted = Object.assign(new Error("reverted"), {
            walk: () => ({ data: "0xabc" })
        })
        const context = {
            senderManager: {
                getWallet: vi.fn(async () => wallet),
                markWalletProcessed
            },
            config: {
                publicClient: { call: vi.fn(() => Promise.reject(reverted)) }
            }
        }
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason)
        }
        process.on("unhandledRejection", onUnhandled)

        try {
            const result = await SafeValidator.prototype.getCodeHashes.call(
                context as never,
                addresses
            )
            // Give an unhandled rejection a turn to surface.
            await new Promise((resolve) => setImmediate(resolve))

            expect(result).toEqual({ hash: "0xabc", addresses })
            expect(releases).toEqual([wallet])
            expect(unhandled).toEqual([])
        } finally {
            process.off("unhandledRejection", onUnhandled)
        }
    })
})
