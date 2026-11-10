import type { AltoConfig } from "@alto/cli"
import { parseGwei } from "viem"
import { polygon } from "viem/chains"
import { describe, expect, it, vi } from "vitest"
import { compatibilityArgsSchema } from "../cli/config/bundler"
import { GasPriceManager } from "./gasPriceManager"

vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

const logger = {
    child: () => logger,
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
}

const makeConfig = (overrides: Partial<AltoConfig>) =>
    ({
        chainId: 5042,
        gasPriceBump: 100n,
        gasPriceRefreshInterval: 0,
        gasPriceExpiry: 10,
        legacyTransactions: false,
        enableHorizontalScaling: false,
        getLogger: () => logger,
        ...overrides
    }) as unknown as AltoConfig

const gwei = (v: string) => parseGwei(v)

describe("max-priority-fee-per-gas-cap", () => {
    it.each([
        {
            name: "no cap leaves fees unchanged",
            cap: undefined,
            input: {
                maxFeePerGas: gwei("120"),
                maxPriorityFeePerGas: gwei("100")
            },
            expected: {
                maxFeePerGas: gwei("120"),
                maxPriorityFeePerGas: gwei("100")
            }
        },
        {
            name: "an inflated oracle tip is trimmed from both fields",
            cap: gwei("5"),
            input: {
                maxFeePerGas: gwei("120"),
                maxPriorityFeePerGas: gwei("100")
            },
            expected: {
                maxFeePerGas: gwei("25"),
                maxPriorityFeePerGas: gwei("5")
            }
        },
        {
            name: "a tip under the cap is unchanged",
            cap: gwei("5"),
            input: {
                maxFeePerGas: gwei("22"),
                maxPriorityFeePerGas: gwei("2")
            },
            expected: {
                maxFeePerGas: gwei("22"),
                maxPriorityFeePerGas: gwei("2")
            }
        }
    ])("$name", ({ cap, input, expected }) => {
        const manager = new GasPriceManager(
            makeConfig({ maxPriorityFeePerGasCap: cap })
        )
        // biome-ignore lint/suspicious/noExplicitAny: private method under test
        expect((manager as any).applyMaxPriorityFeePerGasCap(input)).toEqual(
            expected
        )
    })

    it("refuses legacy transactions", () => {
        expect(
            () =>
                new GasPriceManager(
                    makeConfig({
                        maxPriorityFeePerGasCap: gwei("5"),
                        legacyTransactions: true
                    })
                )
        ).toThrow(/legacy-transactions/)
    })

    it("refuses a priority fee floor above the cap", () => {
        expect(
            () =>
                new GasPriceManager(
                    makeConfig({
                        maxPriorityFeePerGasCap: gwei("5"),
                        floorMaxPriorityFeePerGas: gwei("30")
                    })
                )
        ).toThrow(/floor/)
    })

    it("refuses a cap below the Polygon minimum tip", () => {
        expect(
            () =>
                new GasPriceManager(
                    makeConfig({
                        chainId: polygon.id,
                        maxPriorityFeePerGasCap: gwei("30")
                    })
                )
        ).toThrow(/floor/)
    })

    it.each(["0", "-5"])("rejects a cap of %s at parse time", (value) => {
        const field =
            compatibilityArgsSchema.shape["max-priority-fee-per-gas-cap"]
        expect(field.safeParse(value).success).toBe(false)
        expect(field.safeParse("5").success).toBe(true)
    })
})
