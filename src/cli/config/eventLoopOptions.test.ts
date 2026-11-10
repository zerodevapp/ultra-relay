import { afterEach, describe, expect, it, vi } from "vitest"
import yargs from "yargs"
import { logArgsSchema } from "./bundler"
import { logOptions } from "./options"

// options.ts imports ../handler, which reaches the CLI entry point and runs
// yargs at import time. Cut that chain; these tests only need the option specs.
vi.mock("../handler", () => ({ bundlerHandler: vi.fn() }))

// Mirrors how alto.ts reads options: yargs with the ALTO_ env prefix, then zod.
const parseLogArgs = () =>
    logArgsSchema.parse(yargs([]).env("ALTO").options(logOptions).parseSync())

const baseArgs = { json: false, "log-level": "info" } as const

describe("event-loop metrics options", () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it("is off with a 50ms threshold when nothing is set", () => {
        const args = parseLogArgs()

        expect(args["enable-event-loop-metrics"]).toBe(false)
        expect(args["event-loop-block-threshold-ms"]).toBe(50)
    })

    it("reads both options from ALTO_ env vars", () => {
        vi.stubEnv("ALTO_ENABLE_EVENT_LOOP_METRICS", "true")
        vi.stubEnv("ALTO_EVENT_LOOP_BLOCK_THRESHOLD_MS", "100")

        const args = parseLogArgs()

        expect(args["enable-event-loop-metrics"]).toBe(true)
        expect(args["event-loop-block-threshold-ms"]).toBe(100)
    })

    it("stays off when the env var is explicitly false", () => {
        vi.stubEnv("ALTO_ENABLE_EVENT_LOOP_METRICS", "false")

        expect(parseLogArgs()["enable-event-loop-metrics"]).toBe(false)
    })

    it("rejects a threshold env var that is not a number", () => {
        vi.stubEnv("ALTO_EVENT_LOOP_BLOCK_THRESHOLD_MS", "abc")

        expect(() => parseLogArgs()).toThrow()
    })

    it("accepts the 25ms minimum and rejects below it or fractions", () => {
        const withThreshold = (value: number) =>
            logArgsSchema.safeParse({
                ...baseArgs,
                "event-loop-block-threshold-ms": value
            }).success

        expect(withThreshold(25)).toBe(true)
        expect(withThreshold(24)).toBe(false)
        expect(withThreshold(50.5)).toBe(false)
    })
})
