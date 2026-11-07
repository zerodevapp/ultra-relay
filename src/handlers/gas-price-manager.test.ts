import { randomUUID } from "node:crypto"
import pino from "pino"
import { maxUint128, parseGwei } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../createConfig"
import { GasPriceManager } from "./gasPriceManager"

const { clients } = vi.hoisted(() => ({
    clients: [] as { quit: () => Promise<unknown>; disconnect: () => void }[]
}))
vi.mock("ioredis", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ioredis")>()
    const Backend = process.env.ALTO_TEST_REDIS_URL
        ? actual.Redis
        : (await import("ioredis-mock")).default
    class TestRedis extends Backend {
        constructor(endpoint: string) {
            super(endpoint)
            clients.push(this)
        }
    }
    return { ...actual, default: TestRedis, Redis: TestRedis }
})
vi.mock("@sentry/node", () => ({ captureException: vi.fn() }))

const epoch = Date.UTC(2026, 0, 1)
beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    vi.setSystemTime(epoch)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
})
afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.quit()))
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe.each(["memory", "redis"] as const)(
    "gas prices with %s cache",
    (backend) => {
        function fixture(overrides: Partial<AltoConfig> = {}, tip = 0n) {
            const fees = {
                maxFeePerGas: 8n,
                maxPriorityFeePerGas: tip,
                gasPrice: 8n
            }
            const publicClient = {
                estimateFeesPerGas: vi.fn(async () => ({ ...fees })),
                getBlock: vi.fn(async () => ({ baseFeePerGas: 7n })),
                getFeeHistory: vi
                    .fn()
                    .mockRejectedValue(new Error("RPC unavailable")),
                getGasPrice: vi
                    .fn()
                    .mockRejectedValue(new Error("RPC unavailable"))
            }
            const config = {
                chainId: 82937461,
                chainType: "default",
                enableHorizontalScaling: backend === "redis",
                redisEndpoint:
                    process.env.ALTO_TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
                redisKeyPrefix: `gas-manager-test-${randomUUID()}`,
                gasPriceExpiry: 20,
                gasPriceRefreshInterval: 1,
                gasPriceBump: 100n,
                legacyTransactions: false,
                isGasFreeChain: false,
                publicClient,
                getLogger: () => pino({ enabled: false }),
                ...overrides
            } as unknown as AltoConfig
            return { manager: new GasPriceManager(config), publicClient, fees }
        }

        it.each([0n, 1n])("reuses a warm %s tip for admission", async (tip) => {
            const { manager, publicClient } = fixture(
                { gasPriceRefreshInterval: 0 },
                tip
            )
            await manager.init()
            publicClient.estimateFeesPerGas.mockClear()
            expect(await manager.getLowestValidGasPrices()).toEqual({
                lowestMaxFeePerGas: 8n,
                lowestMaxPriorityFeePerGas: tip
            })
            expect(await manager.getHighestMaxPriorityFeePerGas()).toBe(tip)
            expect(publicClient.estimateFeesPerGas).not.toHaveBeenCalled()
        })

        it("serves a cached zero tip in background-refresh mode", async () => {
            const { manager, publicClient } = fixture()
            await manager.init()
            publicClient.estimateFeesPerGas.mockClear()
            expect(await manager.getGasPrice()).toEqual({
                maxFeePerGas: 8n,
                maxPriorityFeePerGas: 0n
            })
            expect(publicClient.estimateFeesPerGas).not.toHaveBeenCalled()
        })

        it("recognizes genuinely zero base/max/priority fees as present", async () => {
            const { manager, publicClient, fees } = fixture()
            fees.maxFeePerGas = 0n
            publicClient.getBlock.mockResolvedValue({ baseFeePerGas: 0n })
            await manager.init()
            publicClient.estimateFeesPerGas.mockClear()
            publicClient.getBlock.mockClear()
            expect(await manager.getGasPrice()).toEqual({
                maxFeePerGas: 0n,
                maxPriorityFeePerGas: 0n
            })
            expect(await manager.getLowestValidGasPrices()).toEqual({
                lowestMaxFeePerGas: 0n,
                lowestMaxPriorityFeePerGas: 0n
            })
            expect(await manager.getHighestMaxFeePerGas()).toBe(0n)
            expect(await manager.getHighestMaxPriorityFeePerGas()).toBe(0n)
            expect(await manager.getBaseFee()).toBe(0n)
            expect(await manager.getMaxBaseFeePerGas()).toBe(0n)
            expect(publicClient.estimateFeesPerGas).not.toHaveBeenCalled()
            expect(publicClient.getBlock).not.toHaveBeenCalled()
        })

        it("preserves the cold background-mode error rather than fetching on demand", async () => {
            const { manager, publicClient } = fixture()
            await expect(manager.getGasPrice()).rejects.toThrow(
                "No gas price available"
            )
            expect(publicClient.estimateFeesPerGas).not.toHaveBeenCalled()
        })

        it("retains a fresh zero-tip quote when the RPC is unavailable", async () => {
            const { manager, publicClient } = fixture()
            await manager.init()
            publicClient.estimateFeesPerGas
                .mockClear()
                .mockRejectedValue(new Error("RPC unavailable"))
            expect(await manager.getGasPrice()).toEqual({
                maxFeePerGas: 8n,
                maxPriorityFeePerGas: 0n
            })
            expect(await manager.getLowestValidGasPrices()).toEqual({
                lowestMaxFeePerGas: 8n,
                lowestMaxPriorityFeePerGas: 0n
            })
            expect(publicClient.estimateFeesPerGas).not.toHaveBeenCalled()
        })

        it("preserves on-demand RPC failures and recovery", async () => {
            const { manager, publicClient, fees } = fixture({
                gasPriceRefreshInterval: 0
            })
            await manager.init()
            publicClient.estimateFeesPerGas.mockRejectedValue(
                new Error("RPC unavailable")
            )
            await expect(manager.getGasPrice()).rejects.toThrow(
                "No gas price available"
            )
            publicClient.estimateFeesPerGas.mockResolvedValue({
                ...fees,
                maxFeePerGas: 12n
            })
            expect(await manager.getGasPrice()).toEqual({
                maxFeePerGas: 12n,
                maxPriorityFeePerGas: 0n
            })
        })

        it("does not cache a base-fee error fallback as a real zero observation", async () => {
            const { manager, publicClient } = fixture()
            publicClient.getBlock.mockRejectedValueOnce(
                new Error("RPC unavailable")
            )
            expect(await manager.getBaseFee()).toBe(0n)
            publicClient.getBlock.mockResolvedValue({ baseFeePerGas: 9n })
            expect(await manager.getBaseFee()).toBe(9n)
            expect(publicClient.getBlock).toHaveBeenCalledTimes(2)
        })

        it("keeps explicitly on-demand quotes fresh", async () => {
            const { manager, publicClient, fees } = fixture({
                gasPriceRefreshInterval: 0
            })
            await manager.init()
            publicClient.estimateFeesPerGas.mockClear()
            fees.maxFeePerGas = 12n
            expect(await manager.getGasPrice()).toEqual({
                maxFeePerGas: 12n,
                maxPriorityFeePerGas: 0n
            })
            expect(publicClient.estimateFeesPerGas).toHaveBeenCalledTimes(1)
        })

        it("preserves minimum-zero tracking and expiration on later refreshes", async () => {
            const { manager, fees } = fixture({ gasPriceRefreshInterval: 0 })
            await manager.init()
            vi.setSystemTime(epoch + 1_000)
            fees.maxPriorityFeePerGas = 2n
            await manager.getGasPrice()
            expect(
                (await manager.getLowestValidGasPrices())
                    .lowestMaxPriorityFeePerGas
            ).toBe(0n)
            // Whole-second bounds also work with ioredis-mock's score parser.
            vi.setSystemTime(epoch + 21_000)
            await manager.getGasPrice()
            expect(
                (await manager.getLowestValidGasPrices())
                    .lowestMaxPriorityFeePerGas
            ).toBe(2n)
        })

        it("preserves legacy pricing", async () => {
            const { manager, publicClient } = fixture({
                legacyTransactions: true
            })
            await manager.init()
            expect(await manager.getGasPrice()).toEqual({
                maxFeePerGas: 8n,
                maxPriorityFeePerGas: 8n
            })
            expect(publicClient.getBlock).not.toHaveBeenCalled()
        })

        it("preserves configured fee floors", async () => {
            const { manager } = fixture({
                floorMaxFeePerGas: 12n,
                floorMaxPriorityFeePerGas: 2n
            })
            await manager.init()
            expect(await manager.getGasPrice()).toEqual({
                maxFeePerGas: 12n,
                maxPriorityFeePerGas: 2n
            })
        })

        it("preserves Polygon's priority-fee floor on the RPC fallback", async () => {
            const { manager } = fixture({ chainId: 137 })
            await manager.init()
            expect(await manager.getGasPrice()).toEqual({
                maxFeePerGas: parseGwei("31"),
                maxPriorityFeePerGas: parseGwei("31")
            })
        })

        it("keeps the gas-free-chain fast path", async () => {
            const { manager, publicClient } = fixture({ isGasFreeChain: true })
            expect(await manager.getGasPrice()).toEqual({
                maxFeePerGas: 0n,
                maxPriorityFeePerGas: 0n
            })
            expect(publicClient.estimateFeesPerGas).not.toHaveBeenCalled()
        })

        it("does not opt other chain oracle queues into zero observations", async () => {
            const { manager } = fixture()
            manager.arbitrumManager.saveL1BaseFee(0n)
            manager.arbitrumManager.saveL2BaseFee(0n)
            manager.optimismManager.saveL1FeeValue(0n)
            manager.abstractManager.savePubdataPrice(0n)
            await manager.mantleManager.saveMantleOracleValues({
                tokenRatio: 0n,
                scalar: 0n,
                rollupDataGasAndOverhead: 0n,
                l1GasPrice: 0n
            })
            expect(await manager.arbitrumManager.getMinL1BaseFee()).toBe(1n)
            expect(await manager.arbitrumManager.getMaxL1BaseFee()).toBe(
                maxUint128
            )
            expect(await manager.arbitrumManager.getMaxL2BaseFee()).toBe(
                maxUint128
            )
            expect(await manager.optimismManager.getMinL1Fee()).toBe(1n)
            expect(await manager.abstractManager.getMinPubdataPrice()).toBe(1n)
            expect(
                await manager.mantleManager.getMinMantleOracleValues()
            ).toEqual({
                minTokenRatio: 1n,
                minScalar: 1n,
                minRollupDataGasAndOverhead: 1n,
                minL1GasPrice: 1n
            })
        })
    }
)
