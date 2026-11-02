import type { GasPriceManager } from "@alto/handlers"
import type {
    StateOverrides,
    UserOperation,
    UserOperation06,
    UserOperation07
} from "@alto/types"
import type { Metrics } from "@alto/utils"
import { encodeErrorResult, parseAbi, zeroAddress } from "viem"
import { entryPoint07Address } from "viem/account-abstraction"
import { type Mock, describe, expect, test, vi } from "vitest"
import type { AltoConfig } from "../../createConfig"
import type { SimulateHandleOpResult } from "../estimation/types"
import { UnsafeValidator } from "./UnsafeValidator"

// Importing UnsafeValidator reaches utils/logger, which builds a Logtail
// transport at module load when BETTER_STACK_TOKEN is set.
vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

type SilentLogger = {
    trace: Mock
    debug: Mock
    info: Mock
    warn: Mock
    error: Mock
    fatal: Mock
    child: () => SilentLogger
}

const silentLogger: SilentLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => silentLogger
}

const TRANSFER_FROM_FAILED = encodeErrorResult({
    abi: parseAbi(["error Error(string)"]),
    errorName: "Error",
    args: ["TRANSFER_FROM_FAILED"]
})

const PASS = {
    result: "execution",
    data: { executionResult: {} }
} as unknown as SimulateHandleOpResult

const FAIL = (data: string): SimulateHandleOpResult => ({
    result: "failed",
    data,
    code: -32500
})

const SENDER = "0x1111111111111111111111111111111111111111"

const userOp07: UserOperation07 = {
    sender: SENDER,
    nonce: 0n,
    factory: null,
    factoryData: null,
    callData: "0xdeadbeef",
    callGasLimit: 9_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    paymaster: null,
    paymasterVerificationGasLimit: 0n,
    paymasterPostOpGasLimit: 0n,
    paymasterData: null,
    signature: "0x"
}

const userOp06: UserOperation06 = {
    sender: SENDER,
    nonce: 0n,
    initCode: "0x",
    callData: "0xdeadbeef",
    callGasLimit: 9_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 0n,
    maxPriorityFeePerGas: 0n,
    maxFeePerGas: 0n,
    paymasterAndData: "0x",
    signature: "0x"
}

// Builds a validator whose simulation returns `results` in order.
const setup = (results: SimulateHandleOpResult[]) => {
    const metrics = { secondValidationFailed: { inc: vi.fn() } }
    const validator = new UnsafeValidator({
        config: {
            logLevel: "silent",
            getLogger: () => silentLogger
        } as unknown as AltoConfig,
        metrics: metrics as unknown as Metrics,
        gasPriceManager: {} as unknown as GasPriceManager
    })
    const spy = vi.spyOn(validator.gasEstimationHandler, "validateHandleOp")
    for (const result of results) {
        spy.mockResolvedValueOnce(result)
    }
    return { validator, spy, metrics }
}

// Fresh queued ops, entry point and state overrides for each test.
const argsFor = (userOp: UserOperation) => {
    const queuedUserOps: UserOperation[] = [{ ...userOp, nonce: 1n }]
    const stateOverrides: StateOverrides = { [SENDER]: { balance: 1n } }
    return {
        userOp,
        entryPoint: entryPoint07Address,
        queuedUserOps,
        stateOverrides
    }
}

describe("UnsafeValidator.validateHandleOp second validation", () => {
    test("first validation passes: limits unchanged, no retry", async () => {
        const { validator, spy, metrics } = setup([PASS])

        const result = await validator.validateHandleOp(argsFor(userOp07))

        expect(result.callGasLimit).toBe(9_000n)
        expect(result.verificationGasLimit).toBe(100_000n)
        expect(spy).toHaveBeenCalledTimes(1)
        expect(metrics.secondValidationFailed.inc).not.toHaveBeenCalled()
    })

    test("AA21 on the first validation throws immediately without a retry", async () => {
        const { validator, spy } = setup([FAIL("AA21 didn't pay prefund")])

        await expect(
            validator.validateHandleOp(argsFor(userOp07))
        ).rejects.toMatchObject({
            code: -32521,
            message:
                "UserOperation reverted during simulation with reason: AA21 didn't pay prefund"
        })
        expect(spy).toHaveBeenCalledTimes(1)
    })

    test("fails then the retry with doubled limits passes: doubled limits returned", async () => {
        const { validator, spy, metrics } = setup([FAIL("0x"), PASS])

        const result = await validator.validateHandleOp(argsFor(userOp07))

        expect(result.callGasLimit).toBe(18_000n)
        expect(spy).toHaveBeenCalledTimes(2)
        expect(spy.mock.calls[1][0].userOp.callGasLimit).toBe(18_000n)
        expect(metrics.secondValidationFailed.inc).toHaveBeenCalledTimes(1)
    })

    test("the retry reuses the same queued ops, entry point and state overrides", async () => {
        const { validator, spy } = setup([FAIL("0x"), PASS])
        const args = argsFor(userOp07)

        await validator.validateHandleOp(args)

        expect(spy).toHaveBeenCalledTimes(2)
        const [first, second] = spy.mock.calls.map(([callArgs]) => callArgs)
        expect(first.queuedUserOps).toBe(args.queuedUserOps)
        expect(first.stateOverrides).toBe(args.stateOverrides)
        expect(second.queuedUserOps).toBe(first.queuedUserOps)
        expect(second.entryPoint).toBe(first.entryPoint)
        expect(second.stateOverrides).toBe(first.stateOverrides)
        expect(second.targetAddress).toBe(zeroAddress)
        expect(second.targetCallData).toBe("0x")
    })

    test("AA33 with a paymaster: retry carries the doubled paymaster limit", async () => {
        const { validator, spy } = setup([FAIL("AA33 reverted 0x"), PASS])
        const userOp: UserOperation07 = {
            ...userOp07,
            paymaster: "0x2222222222222222222222222222222222222222",
            paymasterVerificationGasLimit: 40_000n
        }

        const result = await validator.validateHandleOp(argsFor(userOp))

        expect(spy).toHaveBeenCalledTimes(2)
        const retryUserOp = spy.mock.calls[1][0].userOp as UserOperation07
        expect(retryUserOp.paymasterVerificationGasLimit).toBe(80_000n)
        expect(result.paymasterVerificationGasLimit).toBe(80_000n)
    })

    test("empty callData: call gas stays 0 through the retry", async () => {
        const { validator, spy } = setup([FAIL("0x"), PASS])
        const userOp: UserOperation07 = {
            ...userOp07,
            callData: "0x",
            callGasLimit: 0n
        }

        const result = await validator.validateHandleOp(argsFor(userOp))

        expect(result.callGasLimit).toBe(0n)
        expect(spy).toHaveBeenCalledTimes(2)
        expect(spy.mock.calls[1][0].userOp.callGasLimit).toBe(0n)
    })

    test("fails then the retry fails with a revert reason: -32521 with the decoded reason", async () => {
        const { validator } = setup([FAIL("0x"), FAIL(TRANSFER_FROM_FAILED)])

        await expect(
            validator.validateHandleOp(argsFor(userOp07))
        ).rejects.toMatchObject({
            code: -32521,
            message:
                "UserOperation reverted during simulation with reason: TRANSFER_FROM_FAILED",
            data: undefined
        })
    })

    test("AA23 on both attempts: -32500 with the raw AA23 message, retry used doubled verificationGasLimit", async () => {
        const { validator, spy } = setup([
            FAIL("AA23 reverted 0x"),
            FAIL("AA23 reverted 0x")
        ])

        await expect(
            validator.validateHandleOp(argsFor(userOp07))
        ).rejects.toMatchObject({
            code: -32500,
            message: "AA23 reverted 0x"
        })
        expect(spy).toHaveBeenCalledTimes(2)
        expect(spy.mock.calls[1][0].userOp.verificationGasLimit).toBe(200_000n)
    })

    test("retry fails with AA21 after doubling raised the prefund: -32521", async () => {
        const { validator } = setup([
            FAIL("0x"),
            FAIL("AA21 didn't pay prefund")
        ])

        await expect(
            validator.validateHandleOp(argsFor(userOp07))
        ).rejects.toMatchObject({
            code: -32521,
            message:
                "UserOperation reverted during simulation with reason: AA21 didn't pay prefund"
        })
    })

    test("transient provider error clears on retry: doubled limits returned", async () => {
        const { validator, spy } = setup([
            FAIL("Unknown error, could not parse simulate validation result."),
            PASS
        ])

        const result = await validator.validateHandleOp(argsFor(userOp07))

        expect(result.callGasLimit).toBe(18_000n)
        expect(spy).toHaveBeenCalledTimes(2)
    })

    test("v0.6 userOp: retry does not add v0.7-only fields", async () => {
        const { validator, spy } = setup([FAIL("0x"), PASS])

        const result = await validator.validateHandleOp(argsFor(userOp06))

        expect(result.callGasLimit).toBe(18_000n)
        expect(spy).toHaveBeenCalledTimes(2)
        expect(spy.mock.calls[1][0].userOp).not.toHaveProperty(
            "paymasterVerificationGasLimit"
        )
    })
})

describe("UnsafeValidator.getExecutionResult with the estimator's failed result", () => {
    // Feeds the shape the estimator now returns for a call-gas search revert
    // through the step that formats the customer-facing error.
    const stubSimulation = (result: SimulateHandleOpResult) => {
        const { validator } = setup([])
        vi.spyOn(
            validator.gasEstimationHandler,
            "simulateHandleOp"
        ).mockResolvedValueOnce(result)
        return validator
    }

    test("formats a call-gas search revert as -32521 with the decoded reason", async () => {
        const validator = stubSimulation({
            result: "failed",
            data: TRANSFER_FROM_FAILED,
            code: -32521
        })

        const result = await validator.getExecutionResult(argsFor(userOp07))

        expect(result).toEqual({
            result: "failed",
            data: "UserOperation reverted during simulation with reason: TRANSFER_FROM_FAILED",
            code: -32521
        })
    })

    test("formats an empty-bytes revert as -32521 with reason 0x", async () => {
        const validator = stubSimulation({
            result: "failed",
            data: "0x",
            code: -32521
        })

        const result = await validator.getExecutionResult(argsFor(userOp07))

        expect(result).toEqual({
            result: "failed",
            data: "UserOperation reverted during simulation with reason: 0x",
            code: -32521
        })
    })
})
