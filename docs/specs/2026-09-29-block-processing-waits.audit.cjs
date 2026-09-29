// Historical, offline spec audit. Run from repository root before implementation.
// Compiles the exact marked snippets in the spec; never edits production source.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const root = process.cwd()
const ts = require(path.join(root, "node_modules/typescript"))
const baseline = "e2c872badac3d682f60e2415b8716ae82d40e84e"
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")
const executorFile = "src/executor/executorManager.ts"
const bundleFile = "src/executor/bundleManager.ts"
const gasFile = "src/handlers/gasPriceManager.ts"
for (const file of [executorFile, bundleFile, gasFile]) {
    assert.equal(
        read(file),
        execFileSync("git", ["show", `${baseline}:${file}`], {
            cwd: root,
            encoding: "utf8"
        }),
        `Historical audit requires unchanged ${file}`
    )
}
process.env.TSX_TSCONFIG_PATH = path.join(root, "src/tsconfig.json")
process.env.DOTENV_CONFIG_PATH = "/dev/null"
process.env.BETTER_STACK_TOKEN = ""
require("tsx/cjs")
const { timed } = require(path.join(root, "src/utils/timed.ts"))
const { runWithLogContext } = require(
    path.join(root, "src/utils/requestContext.ts")
)
const { computeInclusionTimings } = require(
    path.join(root, "src/executor/inclusionTimings.ts")
)
const { createMemoryReceiptCache } = require(
    path.join(root, "src/receiptCache/createMemoryReceiptCache.ts")
)
const { createMemoryMinMaxQueue } = require(
    path.join(root, "src/utils/minMaxQueue/createMemoryMinMaxQueue.ts")
)
const spec = read("docs/specs/2026-09-29-block-processing-waits.md")
const snippet = (name) => {
    const after = spec.split(`<!-- audit:${name} -->`)
    assert.equal(after.length, 2, `Exactly one ${name} snippet`)
    return after[1].split("```ts\n")[1].split("\n```")[0]
}
const method = (file, name) => {
    const source = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    )
    const cls = source.statements.find(ts.isClassDeclaration)
    return cls.members
        .find((m) => m.name?.getText(source) === name)
        .getText(source)
}
const compile = (...methods) => {
    const out = ts.transpileModule(
        `${snippet("summary")}\nclass Audited {\n${methods.join("\n")}\n}`,
        {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
            reportDiagnostics: true
        }
    )
    assert.equal(out.diagnostics.length, 0, "Candidate parses as TypeScript")
    return new Function(
        "timed",
        "runWithLogContext",
        "computeInclusionTimings",
        `${out.outputText}\nreturn Audited`
    )(timed, runWithLogContext, computeInclusionTimings)
}
const failureBlock = / {8}\/\/ Keep the run guard[\s\S]*? {8}return summary/
const brokenInner = snippet("inner")
    .replace("const results = await Promise.allSettled(", "await Promise.all(")
    .replace(failureBlock, "        return summary")
assert(!brokenInner.includes("results.find"))
const classes = {
    baseline: compile(
        method(executorFile, "handleBlock"),
        method(executorFile, "handleBlockInner")
    ),
    candidate: compile(snippet("handle"), snippet("inner")),
    rejected: compile(snippet("handle"), brokenInner)
}
const deferred = () => {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}
const observe = (promise) => {
    const result = { settled: false }
    result.done = promise.then(
        (value) => Object.assign(result, { settled: true, value }),
        (error) => Object.assign(result, { settled: true, error })
    )
    return result
}
const turn = () => new Promise((resolve) => setImmediate(resolve))
const gasValue = { maxFeePerGas: 77n, maxPriorityFeePerGas: 7n }
const zeroGas = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
function manager(mode, kinds) {
    const m = new classes[mode]()
    const h = {
        m,
        gas: deferred(),
        base: deferred(),
        log: [],
        included: [],
        reverted: [],
        decisions: [],
        costs: [],
        gasCalls: 0,
        baseCalls: 0,
        statusCalls: 0,
        stopped: 0
    }
    let pending = kinds.map((status, index) => ({
        uid: String(index),
        status,
        bundle: {
            userOps: Array.from({ length: index + 1 }, (_, i) => ({
                userOpHash: `${index}:${i}`
            }))
        }
    }))
    const finish = (target) => async (args) => {
        target.push(args)
        pending = pending.filter((b) => b !== args.submittedBundle)
    }
    m.bundleManager = {
        getPendingBundles: () => pending,
        getBundleStatuses: async (bundles) => {
            h.statusCalls++
            return bundles.map((b) => ({
                status: b.status,
                receipt: { uid: b.uid }
            }))
        },
        processIncludedBundle: finish(h.included),
        processRevertedBundle: finish(h.reverted)
    }
    m.gasPriceManager = {
        tryGetNetworkGasPrice: () => {
            h.gasCalls++
            return h.gas.promise
        }
    }
    m.getBaseFee = () => {
        h.baseCalls++
        return h.base.promise
    }
    m.stopWatchingBlocks = () => {
        h.stopped++
    }
    m.potentiallyResubmitBundle = (args) => h.decisions.push(args)
    m.updateTransactionCostMetrics = (...args) => h.costs.push(args)
    m.logger = Object.fromEntries(
        ["info", "warn", "debug"].map((level) => [
            level,
            (...args) => h.log.push({ level, args })
        ])
    )
    return h
}
const passed = []
async function check(name, fn) {
    await fn()
    passed.push(name)
}
async function main() {
    for (const kind of ["included", "reverted"]) {
        for (const mode of ["baseline", "candidate"]) {
            await check(`${mode}: ${kind} fee dependency`, async () => {
                const h = manager(mode, [kind])
                const result = observe(h.m.handleBlock())
                await turn()
                assert.equal(result.settled, mode === "candidate")
                assert.equal(h[kind].length, mode === "candidate" ? 1 : 0)
                h.gas.reject(new Error("detached gas"))
                h.base.reject(new Error("detached base"))
                await result.done
                assert(!result.error)
                await turn() // Let Node detect any unhandled detached rejection.
                assert.equal(h.costs.length, 1)
            })
        }
    }
    await check("candidate: empty summary and no fetch", async () => {
        const h = manager("candidate", [])
        await h.m.handleBlock()
        assert.equal(h.gasCalls + h.baseCalls + h.statusCalls, 0)
        assert.equal(h.stopped, 1)
        assert.deepEqual(h.log.find((l) => l.level === "info").args[0], {
            blockNumber: undefined,
            step: "handleBlock",
            ms: h.log[0].args[0].ms,
            pending: 0,
            mined: 0,
            reverted: 0,
            notMined: 0,
            opsClosed: 0
        })
    })
    await check(
        "candidate: mixed summary, shared fees, guard and costs",
        async () => {
            const h = manager("candidate", [
                "included",
                "reverted",
                "not_found",
                "not_found"
            ])
            const run = observe(h.m.handleBlock())
            await turn()
            assert.equal(h.included.length + h.reverted.length, 2)
            assert.equal(h.costs.length, 2)
            await h.m.handleBlock()
            assert.equal(h.statusCalls, 1)
            h.gas.resolve(gasValue)
            await turn()
            assert.equal(h.decisions.length, 0)
            assert(!run.settled)
            h.base.resolve(33n)
            await run.done
            assert(!run.error)
            assert.equal(h.gasCalls, 1)
            assert.equal(h.baseCalls, 1)
            assert.equal(h.decisions.length, 2)
            for (const decision of h.decisions) {
                assert.equal(decision.networkGasPrice, gasValue)
                assert.equal(decision.networkBaseFee, 33n)
                assert.equal(
                    decision.blockReceivedTimestamp,
                    h.included[0].blockReceivedTimestamp
                )
            }
            const summary = h.log.find((l) => l.level === "info").args[0]
            for (const [key, value] of Object.entries({
                pending: 4,
                mined: 1,
                reverted: 1,
                notMined: 2,
                opsClosed: 3
            })) {
                assert.equal(summary[key], value)
            }
        }
    )
    for (const [gasFail, baseFail] of [
        [true, false],
        [false, true],
        [true, true]
    ]) {
        await check(
            `candidate: independent fee fallback ${gasFail}/${baseFail}`,
            async () => {
                const h = manager("candidate", ["not_found"])
                const run = observe(h.m.handleBlock())
                gasFail
                    ? h.gas.reject(new Error("gas"))
                    : h.gas.resolve(gasValue)
                baseFail
                    ? h.base.reject(new Error("base"))
                    : h.base.resolve(33n)
                await run.done
                assert(!run.error)
                assert.deepEqual(
                    h.decisions[0].networkGasPrice,
                    gasFail ? zeroGas : gasValue
                )
                assert.equal(h.decisions[0].networkBaseFee, baseFail ? 0n : 33n)
            }
        )
    }
    await check(
        "candidate: receipt failure and detached fee rejections",
        async () => {
            const h = manager("candidate", ["included"])
            const error = new Error("parse receipt")
            h.m.bundleManager.getBundleStatuses = async () => {
                throw error
            }
            const run = observe(h.m.handleBlock())
            await run.done
            assert.equal(run.error, error)
            assert.equal(h.included.length, 0)
            h.gas.reject(new Error("gas"))
            h.base.reject(new Error("base"))
            await turn()
            assert.equal(h.m.currentlyHandlingBlock, false)
        }
    )
    for (const mode of ["rejected", "candidate"]) {
        await check(`${mode}: mined failure with deferred resend`, async () => {
            const h = manager(mode, ["included", "not_found"])
            const original = h.m.bundleManager.processIncludedBundle
            const error = new Error("included failure")
            h.m.bundleManager.processIncludedBundle = async (args) => {
                await original(args)
                throw error
            }
            const first = observe(h.m.handleBlock())
            await turn()
            assert.equal(first.settled, mode === "rejected")
            const second = observe(h.m.handleBlock())
            await turn()
            assert.equal(h.statusCalls, mode === "rejected" ? 2 : 1)
            h.gas.resolve(gasValue)
            h.base.resolve(33n)
            await Promise.all([first.done, second.done])
            assert.equal(first.error, error)
            assert.equal(h.decisions.length, mode === "rejected" ? 2 : 1)
            assert.equal(h.costs.length, 0)
            assert.equal(h.m.currentlyHandlingBlock, false)
        })
    }
    await check("candidate: bundle failure chosen by input order", async () => {
        const h = manager("candidate", ["included", "included"])
        const gates = [deferred(), deferred()]
        const errors = [new Error("first"), new Error("second")]
        h.m.bundleManager.processIncludedBundle = ({ submittedBundle }) =>
            gates[Number(submittedBundle.uid)].promise
        const run = observe(h.m.handleBlock())
        await turn()
        gates[1].reject(errors[1])
        await turn()
        assert(!run.settled)
        gates[0].reject(errors[0])
        await run.done
        assert.equal(run.error, errors[0])
        h.gas.resolve(gasValue)
        h.base.resolve(33n)
        await turn()
    })
    await check("reverted fallback: cold cache changes RPC count", async () => {
        const Fees = compile(
            method(gasFile, "getBaseFee"),
            method(gasFile, "tryUpdateBaseFee")
        )
        for (const mode of ["baseline", "candidate"]) {
            const h = manager(mode, ["reverted"])
            const block = deferred()
            let blockCalls = 0
            const fees = new Fees()
            fees.config = {
                legacyTransactions: false,
                gasPriceRefreshInterval: 1,
                gasPriceExpiry: 60,
                publicClient: {
                    getBlock: () => {
                        blockCalls++
                        return block.promise
                    }
                }
            }
            fees.baseFeePerGasQueue = createMemoryMinMaxQueue({
                config: fees.config
            })
            h.m.getBaseFee = () => fees.getBaseFee()
            const finish = h.m.bundleManager.processRevertedBundle
            h.m.bundleManager.processRevertedBundle = async (args) => {
                await finish(args)
                // Same fallback used by the real handler without a block.
                // Simulation/recovery are outside this cache-order check.
                assert.equal(await fees.getBaseFee(), 33n)
            }
            h.gas.resolve(gasValue)
            const run = observe(h.m.handleBlock())
            await turn()
            assert.equal(blockCalls, mode === "baseline" ? 1 : 2)
            block.resolve({ baseFeePerGas: 33n })
            await run.done
            assert(!run.error)
            assert.equal(blockCalls, mode === "baseline" ? 1 : 2)
        }
    })
    for (const mode of ["baseline", "candidate"]) {
        await check(
            `${mode}: real per-op action chain concurrency`,
            async () => {
                const C = compile(
                    mode === "baseline"
                        ? method(bundleFile, "processIncludedBundle")
                        : snippet("included"),
                    method(bundleFile, "freeSubmittedBundle"),
                    method(bundleFile, "processIncludedUserOp")
                )
                const m = new C()
                const wallet = deferred()
                const removal = deferred()
                const gates = Array.from({ length: 5 }, deferred)
                const started = []
                const events = []
                const logs = []
                const reputation = []
                let removals = 0
                let stopped = 0
                let metrics = 0
                m.stopTrackingBundle = () => {
                    stopped++
                }
                m.senderManager = { markWalletProcessed: () => wallet.promise }
                m.mempool = {
                    removeSubmittedUserOps: () => {
                        removals++
                        return removal.promise
                    }
                }
                m.receiptCache = createMemoryReceiptCache(60_000)
                m.monitor = {
                    setUserOpStatus: async (hash) => {
                        assert(
                            await m.receiptCache.get(hash),
                            "Receipt precedes status"
                        )
                        started.push(hash)
                        await gates[Number(hash)].promise
                    }
                }
                m.logger = { info: ({ userOpHash }) => logs.push(userOpHash) }
                m.metrics = {
                    userOperationsOnChain: {
                        labels: () => ({
                            inc: () => {
                                metrics++
                            }
                        })
                    },
                    userOperationInclusionDuration: {
                        observe: () => undefined
                    },
                    userOperationsSubmissionAttempts: {
                        observe: () => undefined
                    }
                }
                m.eventManager = {
                    emitIncludedOnChain: (hash) =>
                        events.push([hash, "included"]),
                    emitExecutionRevertedOnChain: (hash) =>
                        events.push([hash, "reverted"])
                }
                m.checkAccountDeployment = () => false
                m.reputationManager = {
                    updateUserOpIncludedStatus: (userOp) =>
                        reputation.push(userOp.sender)
                }
                const userOps = gates.map((_, i) => ({
                    userOpHash: String(i),
                    userOp: { sender: "shared" },
                    addedToMempool: 1,
                    submissionAttempts: 1
                }))
                const args = {
                    submittedBundle: {
                        executor: {},
                        bundle: { entryPoint: "entry", userOps }
                    },
                    bundleReceipt: {
                        transactionHash: "tx",
                        blockNumber: 2n,
                        userOpReceipts: Object.fromEntries(
                            userOps.map((op, i) => [
                                op.userOpHash,
                                { success: i !== 4 }
                            ])
                        )
                    },
                    blockReceivedTimestamp: 2
                }
                const run = observe(m.processIncludedBundle(args))
                await turn()
                assert.equal(stopped, 1)
                assert.equal(removals, 0)
                assert.equal(started.length, 0)
                wallet.resolve()
                await turn()
                assert.equal(removals, 1)
                assert.equal(started.length, 0)
                removal.resolve()
                await turn()
                assert.equal(started.length, mode === "candidate" ? 5 : 1)
                if (mode === "baseline") {
                    for (const gate of gates) {
                        gate.resolve()
                        await turn()
                    }
                    await run.done
                    assert(!run.error)
                    assert.equal(events.length, 5)
                } else {
                    const low = new Error("op 1")
                    const high = new Error("op 3")
                    gates[3].reject(high)
                    gates[1].reject(low)
                    gates[0].resolve()
                    gates[2].resolve()
                    await turn()
                    assert(!run.settled)
                    gates[4].resolve()
                    await run.done
                    assert.equal(run.error, low)
                    assert.equal(logs.length, 5)
                    assert.deepEqual(events, [
                        ["0", "included"],
                        ["2", "included"],
                        ["4", "reverted"]
                    ])
                    assert.equal(metrics, 3)
                    assert.deepEqual(reputation, ["shared", "shared", "shared"])
                }
            }
        )
    }
}
let completed = false
process.once("beforeExit", () => {
    if (!completed && !process.exitCode) {
        process.stderr.write("Audit exited with pending checks\n")
        process.exitCode = 1
    }
})
main().then(
    () => {
        assert.equal(passed.length, 16)
        completed = true
        process.stdout.write(
            `${JSON.stringify({ baseline, node: process.version, passed: passed.length, checks: passed }, null, 2)}\n`
        )
    },
    (error) => {
        process.stderr.write(`${error.stack ?? error}\n`)
        process.exitCode = 1
    }
)
