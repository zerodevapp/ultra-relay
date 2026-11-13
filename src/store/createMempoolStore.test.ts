import type { Address, HexData32, UserOpInfo } from "@alto/types"
import type { Metrics } from "@alto/utils"
import * as sentry from "@sentry/node"
import pino from "pino"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Store } from "."
import type { AltoConfig } from "../createConfig"
import { createMempoolStore } from "./createMempoolStore"

const processingAdd = vi.fn<Store["add"]>()
const submittedAdd = vi.fn<Store["add"]>()

const redisStoreArgs = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock("./createRedisStore", () => ({
    createRedisStore: (args: { storeType: string }) => {
        redisStoreArgs.push(args)
        return {
            add: args.storeType === "processing" ? processingAdd : submittedAdd
        }
    }
}))

vi.mock("./createRedisOutstandingStore", () => ({
    createRedisOutstandingQueue: () => ({})
}))

vi.mock("@sentry/node", () => ({ captureException: vi.fn() }))

const entryPoint = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address

const userOpInfo = {
    userOpHash: `0x${"11".repeat(32)}` as HexData32,
    userOp: { sender: entryPoint, nonce: 1n },
    addedToMempool: Date.now(),
    submissionAttempts: 0
} as unknown as UserOpInfo

const newMempoolStore = () =>
    createMempoolStore({
        config: {
            entrypoints: [entryPoint],
            enableHorizontalScaling: true,
            redisEndpoint: "redis://unused",
            chainId: 8453,
            logLevel: "silent",
            getLogger: () => pino({ level: "silent" })
        } as unknown as AltoConfig,
        metrics: {
            userOperationsInMempool: {
                labels: () => ({ inc() {}, dec() {} })
            }
        } as unknown as Metrics
    })

describe("redis store policy", () => {
    it("expires processing after 2h and submitted after 24h, with a 5s command timeout", () => {
        redisStoreArgs.length = 0
        newMempoolStore()

        expect(
            redisStoreArgs.map(
                ({ storeType, staleAfterMs, commandTimeoutMs }) => ({
                    storeType,
                    staleAfterMs,
                    commandTimeoutMs
                })
            )
        ).toEqual([
            {
                storeType: "processing",
                staleAfterMs: 2 * 60 * 60 * 1000,
                commandTimeoutMs: 5000
            },
            {
                storeType: "submitted",
                staleAfterMs: 24 * 60 * 60 * 1000,
                commandTimeoutMs: 5000
            }
        ])
    })
})

describe.each([
    ["addProcessing", processingAdd],
    ["addSubmitted", submittedAdd]
] as const)("%s", (method, storeAdd) => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("resolves only after the Redis write lands", async () => {
        let land: () => void = () => {}
        storeAdd.mockReturnValue(
            new Promise<void>((resolve) => {
                land = resolve
            })
        )
        const store = newMempoolStore()

        let settled = false
        const pending = store[method]({ entryPoint, userOpInfo }).then(() => {
            settled = true
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(settled).toBe(false)

        land()
        await pending
        expect(settled).toBe(true)
    })

    it("reports a failed write instead of leaving it unhandled", async () => {
        const failure = new Error("redis write failed")
        storeAdd.mockRejectedValue(failure)
        const store = newMempoolStore()

        await expect(
            store[method]({ entryPoint, userOpInfo })
        ).resolves.toBeUndefined()
        expect(sentry.captureException).toHaveBeenCalledWith(failure)
    })
})
