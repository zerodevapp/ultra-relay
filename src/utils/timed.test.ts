import type { Logger } from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { timed } from "./timed"

const makeLogger = () => {
    const info = vi.fn()
    const warn = vi.fn()
    return { info, warn, logger: { info, warn } as unknown as Logger }
}

// start, then end: the only two clock reads timed makes.
const mockElapsed = (ms: number) =>
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(ms)

describe("timed", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("logs the step with its context and rounded ms", async () => {
        mockElapsed(12.3456)
        const { logger, info } = makeLogger()

        await expect(
            timed(logger, "step.a", { id: 1 }, () => "result")
        ).resolves.toBe("result")

        expect(info).toHaveBeenCalledWith(
            { id: 1, step: "step.a", ms: 12.35 },
            "[timing] step.a"
        )
    })

    it("skips the success line when summarize returns undefined", async () => {
        const { logger, info, warn } = makeLogger()

        await expect(
            timed(logger, "step.a", {}, () => 7, {
                summarize: () => undefined
            })
        ).resolves.toBe(7)

        expect(info).not.toHaveBeenCalled()
        expect(warn).not.toHaveBeenCalled()
    })

    it("merges the summarized fields into the success line", async () => {
        mockElapsed(80)
        const { logger, info } = makeLogger()

        await timed(logger, "step.a", { id: 1 }, () => [1, 2, 3], {
            summarize: (result) => ({ count: result.length })
        })

        expect(info).toHaveBeenCalledWith(
            { id: 1, step: "step.a", ms: 80, count: 3 },
            "[timing] step.a"
        )
    })

    it("passes the result and the unrounded ms to summarize", async () => {
        mockElapsed(49.999)
        const { logger, info } = makeLogger()
        const summarize = vi.fn(() => ({}))

        await timed(logger, "step.a", {}, () => "result", { summarize })

        expect(summarize).toHaveBeenCalledWith("result", 49.999)
        // The logged ms is still rounded.
        expect(info).toHaveBeenCalledWith(
            { step: "step.a", ms: 50 },
            "[timing] step.a"
        )
    })

    it("logs a failure the same way and does not summarize it", async () => {
        mockElapsed(30)
        const { logger, info, warn } = makeLogger()
        const summarize = vi.fn(() => ({}))
        const error = new Error("boom")

        await expect(
            timed(logger, "step.a", { id: 1 }, () => Promise.reject(error), {
                summarize
            })
        ).rejects.toBe(error)

        expect(warn).toHaveBeenCalledWith(
            { id: 1, step: "step.a", ms: 30, err: "boom" },
            "[timing] step.a failed"
        )
        expect(info).not.toHaveBeenCalled()
        expect(summarize).not.toHaveBeenCalled()
    })
})
