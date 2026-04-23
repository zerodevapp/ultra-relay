import { beforeEach, describe, expect, it, vi } from "vitest"
import { UserOpStatusTracker } from "../userOpStatusTracker"

const mockInsert = vi.fn()
const mockOnConflictDoUpdate = vi.fn()
const mockUpdate = vi.fn()
const mockSet = vi.fn()
const mockWhere = vi.fn()

vi.mock("../client", () => ({
    createDbClient: vi.fn(() => ({
        insert: (...args: unknown[]) => {
            mockInsert(...args)
            return {
                values: vi.fn().mockReturnValue({
                    onConflictDoUpdate: (...ocArgs: unknown[]) => {
                        mockOnConflictDoUpdate(...ocArgs)
                        return Promise.resolve()
                    }
                })
            }
        },
        update: (...args: unknown[]) => {
            mockUpdate(...args)
            return {
                set: (...sArgs: unknown[]) => {
                    mockSet(...sArgs)
                    return {
                        where: (...wArgs: unknown[]) => {
                            mockWhere(...wArgs)
                            return Promise.resolve()
                        }
                    }
                }
            }
        }
    }))
}))

const createMockConfig = (databaseUrl?: string) =>
    ({
        databaseUrl,
        chainId: 8453,
        logLevel: "info",
        getLogger: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            child: vi.fn().mockReturnThis()
        })
    }) as any

const mockMetrics = {} as any

describe("UserOpStatusTracker", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    describe("no-op mode", () => {
        it("does not throw when databaseUrl is undefined", () => {
            const config = createMockConfig(undefined)
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })
            expect(tracker).toBeDefined()
        })

        it("trackReceived is a no-op", async () => {
            const config = createMockConfig(undefined)
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })
            await tracker.trackReceived(
                "0xabc123" as any,
                8453,
                "0xentrypoint" as any,
                { sender: "0xsender" as any, nonce: 1n }
            )
            expect(mockInsert).not.toHaveBeenCalled()
        })

        it("trackFailedValidation is a no-op", async () => {
            const config = createMockConfig(undefined)
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })
            await tracker.trackFailedValidation(
                "0xabc123" as any,
                8453,
                "some reason"
            )
            expect(mockInsert).not.toHaveBeenCalled()
        })

        it("incrementRetryCount is a no-op", async () => {
            const config = createMockConfig(undefined)
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })
            await tracker.incrementRetryCount("0xabc123" as any)
            expect(mockUpdate).not.toHaveBeenCalled()
        })
    })

    describe("with database", () => {
        it("trackReceived calls insert with pending_offchain status", async () => {
            const config = createMockConfig("postgres://localhost/test")
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })

            await tracker.trackReceived(
                "0xhash123" as any,
                8453,
                "0xentrypoint" as any,
                { sender: "0xsender" as any, nonce: 42n }
            )

            expect(mockInsert).toHaveBeenCalled()
            expect(mockOnConflictDoUpdate).toHaveBeenCalled()
        })

        it("trackFailedValidation calls insert with error fields", async () => {
            const config = createMockConfig("postgres://localhost/test")
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })

            await tracker.trackFailedValidation(
                "0xhash123" as any,
                8453,
                "invalid nonce",
                "AA25"
            )

            expect(mockInsert).toHaveBeenCalled()
            expect(mockOnConflictDoUpdate).toHaveBeenCalled()
        })

        it("trackSubmitted processes all hashes", async () => {
            const config = createMockConfig("postgres://localhost/test")
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })

            const hashes = [
                "0xhash1" as any,
                "0xhash2" as any,
                "0xhash3" as any
            ]

            await tracker.trackSubmitted(
                hashes,
                8453,
                "0xtxhash" as any,
                100000n,
                50000n
            )

            expect(mockInsert).toHaveBeenCalledTimes(3)
            expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(3)
        })

        it("trackIncluded calls insert with included_at timestamp", async () => {
            const config = createMockConfig("postgres://localhost/test")
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })

            await tracker.trackIncluded(
                "0xhash123" as any,
                8453,
                "0xtxhash" as any,
                1000000n
            )

            expect(mockInsert).toHaveBeenCalled()
            expect(mockOnConflictDoUpdate).toHaveBeenCalled()
        })

        it("trackQueued calls insert with queued_offchain status", async () => {
            const config = createMockConfig("postgres://localhost/test")
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })

            await tracker.trackQueued("0xhash123" as any, 8453)

            expect(mockInsert).toHaveBeenCalled()
            expect(mockOnConflictDoUpdate).toHaveBeenCalled()
        })

        it("trackDropped calls insert with error fields", async () => {
            const config = createMockConfig("postgres://localhost/test")
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })

            await tracker.trackDropped(
                "0xhash123" as any,
                8453,
                "gas too low",
                "AA21"
            )

            expect(mockInsert).toHaveBeenCalled()
            expect(mockOnConflictDoUpdate).toHaveBeenCalled()
        })

        it("trackFrontran calls insert with included_at", async () => {
            const config = createMockConfig("postgres://localhost/test")
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })

            await tracker.trackFrontran("0xhash123" as any, 8453, "0xtxhash" as any)

            expect(mockInsert).toHaveBeenCalled()
            expect(mockOnConflictDoUpdate).toHaveBeenCalled()
        })
    })

    describe("error resilience", () => {
        it("swallows DB errors and does not throw", async () => {
            const config = createMockConfig("postgres://localhost/test")
            const tracker = new UserOpStatusTracker({
                config,
                metrics: mockMetrics
            })

            // Override insert to throw
            mockInsert.mockImplementationOnce(() => {
                throw new Error("connection refused")
            })

            // Should not throw
            await expect(
                tracker.trackReceived(
                    "0xhash123" as any,
                    8453,
                    "0xentrypoint" as any,
                    { sender: "0xsender" as any, nonce: 1n }
                )
            ).resolves.toBeUndefined()
        })
    })
})
