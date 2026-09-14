import type { UserOperation } from "@alto/types"
import { calcExecutionPvgComponent, calcL2PvgComponent } from "@alto/utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RpcHandler } from "../rpcHandler"
import { validatePvg } from "./validate-pvg"

vi.mock("@alto/utils", () => ({
    calcExecutionPvgComponent: vi.fn(),
    calcL2PvgComponent: vi.fn()
}))

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
const SENDER = "0x0000000000000000000000000000000000000001"
const makeUserOp = (preVerificationGas: bigint): UserOperation => ({
    sender: SENDER,
    nonce: 0n,
    callData: "0x",
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    signature: "0x"
})

function makeHandler(enforceBoostPvg = false, observeBoostPvg = false) {
    // Only these dependencies are used; both gas calculators are mocked.
    return {
        config: { supportsEip7623: false, enforceBoostPvg, observeBoostPvg },
        gasPriceManager: {},
        logger: { info: vi.fn(), error: vi.fn() }
    } as unknown as RpcHandler
}

const flushObservation = () =>
    new Promise<void>((resolve) => setImmediate(resolve))
let now = 0

beforeEach(() => {
    vi.resetAllMocks()
    now = 0
    vi.spyOn(performance, "now").mockImplementation(() => now)
    vi.mocked(calcExecutionPvgComponent).mockReturnValue(40_000n)
    vi.mocked(calcL2PvgComponent).mockResolvedValue(4_000n)
})

afterEach(() => vi.restoreAllMocks())

describe.each(["v1", "v2"] as const)("boosted PVG %s", (apiVersion) => {
    it("default mode accepts zero PVG without extra RPC work", async () => {
        const handler = makeHandler()
        expect(
            await validatePvg(
                apiVersion,
                handler,
                makeUserOp(0n),
                ENTRY_POINT,
                true
            )
        ).toEqual([true, ""])
        expect(calcExecutionPvgComponent).not.toHaveBeenCalled()
        expect(calcL2PvgComponent).not.toHaveBeenCalled()
        expect(handler.logger.info).not.toHaveBeenCalled()
    })

    it.each([0n, 43_999n, 44_000n, 44_001n])(
        "enforces the combined execution and L2 floor: %s",
        async (pvg) => {
            const userOp = makeUserOp(pvg)
            const original = { ...userOp }
            const result = await validatePvg(
                apiVersion,
                makeHandler(true),
                userOp,
                ENTRY_POINT,
                true
            )
            expect(result).toEqual(
                pvg < 44_000n
                    ? [
                          false,
                          `preVerificationGas is not enough, required: 44000, got: ${pvg}`
                      ]
                    : [true, ""]
            )
            expect(userOp).toEqual(original)
            expect(calcL2PvgComponent).toHaveBeenCalledWith(
                expect.objectContaining({
                    validate: true,
                    entryPoint: ENTRY_POINT
                })
            )
        }
    )

    it("does not fail open when an enforced fee check fails", async () => {
        vi.mocked(calcL2PvgComponent).mockRejectedValueOnce(
            new Error("oracle unavailable")
        )
        await expect(
            validatePvg(
                apiVersion,
                makeHandler(true),
                makeUserOp(44_000n),
                ENTRY_POINT,
                true
            )
        ).rejects.toThrow("oracle unavailable")
    })

    it("enforcement takes precedence over observation", async () => {
        const handler = makeHandler(true, true)
        const [accepted] = await validatePvg(
            apiVersion,
            handler,
            makeUserOp(0n),
            ENTRY_POINT,
            true
        )
        expect(accepted).toBe(false)
        expect(calcL2PvgComponent).toHaveBeenCalledTimes(1)
        expect(handler.logger.info).not.toHaveBeenCalled()
    })

    it.each([0n, 44_000n])(
        "observation logs the decision without rejection: %s",
        async (pvg) => {
            const handler = makeHandler(false, true)
            expect(
                await validatePvg(
                    apiVersion,
                    handler,
                    makeUserOp(pvg),
                    ENTRY_POINT,
                    true
                )
            ).toEqual([true, ""])
            await flushObservation()
            expect(handler.logger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    apiVersion,
                    entryPoint: ENTRY_POINT,
                    sender: SENDER,
                    requiredPvg: "0xabe0",
                    wouldReject: pvg < 44_000n
                }),
                "boost pvg check"
            )
        }
    )

    it.each([new Error("oracle unavailable"), "oracle unavailable"])(
        "observation handles calculator errors: %s",
        async (error) => {
            const handler = makeHandler(false, true)
            vi.mocked(calcL2PvgComponent).mockRejectedValueOnce(error)
            expect(
                await validatePvg(
                    apiVersion,
                    handler,
                    makeUserOp(0n),
                    ENTRY_POINT,
                    true
                )
            ).toEqual([true, ""])
            await flushObservation()
            expect(handler.logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    calculationError: "oracle unavailable"
                }),
                "boost pvg check failed"
            )
            now = 1_000
            await validatePvg(
                apiVersion,
                handler,
                makeUserOp(0n),
                ENTRY_POINT,
                true
            )
            await flushObservation()
            expect(handler.logger.info).toHaveBeenCalledTimes(1)
        }
    )
})

describe("observation bounds and legacy behavior", () => {
    it("does not wait for the oracle or overlap in-flight samples", async () => {
        let resolveFee!: (fee: bigint) => void
        vi.mocked(calcL2PvgComponent).mockReturnValueOnce(
            new Promise<bigint>((resolve) => {
                resolveFee = resolve
            })
        )
        const handler = makeHandler(false, true)
        expect(
            await validatePvg("v2", handler, makeUserOp(0n), ENTRY_POINT, true)
        ).toEqual([true, ""])
        now = 10_000
        await validatePvg("v2", handler, makeUserOp(0n), ENTRY_POINT, true)
        expect(calcL2PvgComponent).toHaveBeenCalledTimes(1)
        resolveFee(4_000n)
        await flushObservation()
        await validatePvg("v2", handler, makeUserOp(0n), ENTRY_POINT, true)
        await flushObservation()
        expect(calcL2PvgComponent).toHaveBeenCalledTimes(2)
    })

    it("rate limits completed samples and isolates handler instances", async () => {
        const handler = makeHandler(false, true)
        await validatePvg("v1", handler, makeUserOp(0n), ENTRY_POINT, true)
        await flushObservation()
        now = 999
        await validatePvg("v2", handler, makeUserOp(0n), ENTRY_POINT, true)
        expect(calcL2PvgComponent).toHaveBeenCalledTimes(1)
        await validatePvg(
            "v2",
            makeHandler(false, true),
            makeUserOp(0n),
            ENTRY_POINT,
            true
        )
        await flushObservation()
        expect(calcL2PvgComponent).toHaveBeenCalledTimes(2)
        now = 1_000
        await validatePvg("v2", handler, makeUserOp(0n), ENTRY_POINT, true)
        await flushObservation()
        expect(calcL2PvgComponent).toHaveBeenCalledTimes(3)
    })

    it("catches synchronous calculation failures in observation mode", async () => {
        vi.mocked(calcExecutionPvgComponent).mockImplementationOnce(() => {
            throw new Error("invalid operation")
        })
        const handler = makeHandler(false, true)
        expect(
            await validatePvg("v2", handler, makeUserOp(0n), ENTRY_POINT, true)
        ).toEqual([true, ""])
        await flushObservation()
        expect(handler.logger.error).toHaveBeenCalledTimes(1)
    })

    it.each([false, true])(
        "preserves non-boosted v1/v2 behavior with enforcement %s",
        async (enforce) => {
            const handler = makeHandler(enforce, true)
            const userOp = {
                ...makeUserOp(0n),
                maxFeePerGas: 1n,
                maxPriorityFeePerGas: 1n
            }
            expect(
                await validatePvg("v1", handler, userOp, ENTRY_POINT)
            ).toEqual([true, ""])
            expect(calcL2PvgComponent).not.toHaveBeenCalled()
            const [accepted] = await validatePvg(
                "v2",
                handler,
                userOp,
                ENTRY_POINT
            )
            expect(accepted).toBe(false)
            expect(handler.logger.info).not.toHaveBeenCalled()
        }
    )
})
