import { expect, it, vi } from "vitest"
import { SafeValidator } from "./SafeValidator"
import { ValidationErrors } from "@alto/types"

for (const version of ["V06", "V07"] as const) {
    it(`${version}: starts the trace while code hashes are pending and preserves hash-error precedence`, async () => {
        let resolveHash!: (value: { hash: string }) => void
        const getCodeHashes = vi.fn(() => new Promise(resolve => { resolveHash = resolve }))
        const trace = vi.fn().mockRejectedValue(new Error("trace failed first"))
        const validator = Object.create(SafeValidator.prototype) as any
        const client = {}
        Object.assign(validator, { config: { publicClient: client, revalidationTracer: true }, traceClient: client,
            getCodeHashes, [`getValidationResultWithTracer${version}`]: trace })
        const operation = validator[`getValidationResult${version}`]({ userOp: {}, queuedUserOps: [], entryPoint: "0x",
            codeHashes: { addresses: ["0x"], hash: "expected" }, storageMap: {} })
        expect(trace).toHaveBeenCalledTimes(1)
        expect(getCodeHashes).toHaveBeenCalledTimes(1)
        await Promise.resolve()
        resolveHash({ hash: "different" })
        await expect(operation).rejects.toMatchObject({ message: "code hashes mismatch", code: ValidationErrors.OpcodeValidation })
    })
}

it("code-hash transport failures remain infrastructure failures, not invalid hashes", async () => {
    const error = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
    const validator = Object.create(SafeValidator.prototype) as any
    validator.config = { publicClient: { call: vi.fn().mockRejectedValue(error) } }
    await expect(validator.getCodeHashes([])).rejects.toBe(error)
})
