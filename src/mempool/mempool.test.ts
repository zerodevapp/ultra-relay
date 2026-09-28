import type { EventManager } from "@alto/handlers"
import { createMempoolStore } from "@alto/store"
import type { MempoolStore } from "@alto/store"
import {
    type Address,
    type InterfaceValidator,
    type UserOpInfo,
    type UserOperation,
    type UserOperation06,
    type UserOperation07,
    type UserOperationBundle,
    userOpInfoSchema
} from "@alto/types"
import type { Metrics } from "@alto/utils"
import {
    getAddressFromInitCodeOrPaymasterAndData,
    getSerializedHandleOpsTx,
    scaleBigIntByPercent
} from "@alto/utils"
import { type Hex, getAddress, size, toHex } from "viem"
import {
    type Mock,
    type MockInstance,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from "vitest"
import type { AltoConfig } from "../createConfig"
import { bundleByteThreshold, getBundleCaps } from "../executor/bundleCaps"
import { calculateAA95GasFloor } from "../executor/utils"
import { Mempool } from "./mempool"
import type { Monitor } from "./monitoring"
import {
    type InterfaceReputationManager,
    type ReputationStatus,
    ReputationStatuses
} from "./reputationManager"

// Importing Mempool reaches utils/logger, which builds a Logtail transport at
// module load when BETTER_STACK_TOKEN is set. vi.hoisted runs before the
// imports above, so clearing it here keeps the test from opening one. Set to
// an empty string rather than deleted: biome's noDelete rule forbids the
// delete operator, and an empty string is falsy so the guard still skips
// building the transport.
vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

const ENTRY_POINT_V06 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address
const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address
const ENTRY_POINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108" as Address
const BENEFICIARY = "0x2222222222222222222222222222222222222222" as Address
const CHAIN_ID = 42161

const hash = (id: number) => `0x${id.toString(16).padStart(64, "0")}` as Hex

const senderOf = (id: number) =>
    getAddress(`0x${(id + 10).toString(16).padStart(40, "0")}`)

const idOf = (userOpHash: Hex) => Number.parseInt(userOpHash.slice(2), 16)

// Shared by both version builders so the two cannot drift.
// `maxFeePerGas = BigInt(id)` is what makes pop order deterministic:
// MemoryOutstanding sorts the priority queue ASCENDING by maxFeePerGas and
// pop() shifts index 0 (createMemoryOutstandingStore.ts:38-42, :151), so ids
// 1..n pop in id order. Flip that sort and every ordering expectation in this
// file changes.
const commonUserOpFields = (id: number) => ({
    sender: senderOf(id),
    nonce: 0n,
    callData: "0x" as Hex,
    callGasLimit: 6_000_000n,
    verificationGasLimit: 350_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: BigInt(id),
    maxPriorityFeePerGas: 1n,
    signature: "0x" as Hex
})

// `reentered` and `processingAt` are deliberately left absent (not assigned
// `undefined`) so that "preserve unset" is observable on the re-added record.
const toUserOpInfo = (id: number, userOp: UserOperation): UserOpInfo => ({
    userOp,
    userOpHash: hash(id),
    receivedAt: 900,
    addedToMempool: 1000,
    submissionAttempts: 0
})

const makeUserOpInfoV06 = (
    id: number,
    overrides: Partial<UserOperation06> = {}
): UserOpInfo => {
    const userOp: UserOperation06 = {
        ...commonUserOpFields(id),
        initCode: "0x",
        paymasterAndData: "0x",
        ...overrides
    }

    return toUserOpInfo(id, userOp)
}

const makeUserOpInfoV07 = (
    id: number,
    overrides: Partial<UserOperation07> = {}
): UserOpInfo => {
    const userOp: UserOperation07 = {
        ...commonUserOpFields(id),
        factory: null,
        factoryData: null,
        paymaster: null,
        paymasterData: null,
        paymasterVerificationGasLimit: null,
        paymasterPostOpGasLimit: null,
        ...overrides
    }

    return toUserOpInfo(id, userOp)
}

type SilentLogger = {
    trace: Mock
    debug: Mock
    info: Mock
    warn: Mock
    error: Mock
    fatal: Mock
    child: () => SilentLogger
}

// Module-level so a test can read the cap-event payload the mempool logs at
// debug level. Cleared in beforeEach.
const debugMock = vi.fn()

const silentLogger: SilentLogger = {
    trace: vi.fn(),
    debug: debugMock,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => silentLogger
}

// `utilityPrivateKey.address` must be the fixed beneficiary:
// calculateAA95GasFloor encodes the beneficiary into the handleOps calldata,
// so a random fallback would make the gas projections non-deterministic.
const makeConfig = (overrides: Record<string, unknown> = {}) =>
    ({
        entrypoints: [ENTRY_POINT_V06],
        chainId: CHAIN_ID,
        chainType: "arbitrum",
        maxGasPerBundle: 27_000_000n,
        safeMode: false,
        enforceUniqueSendersPerBundle: false,
        enableHorizontalScaling: false,
        redisEndpoint: undefined,
        logLevel: "silent",
        mempoolMaxParallelOps: 10,
        mempoolMaxQueuedOps: 10,
        utilityPrivateKey: { address: BENEFICIARY },
        publicClient: {},
        getLogger: () => silentLogger,
        ...overrides
    }) as unknown as AltoConfig

// The store's add/remove bookkeeping increments this gauge, and addProcessing
// logs before it stores, so a bare {} would swallow the op behind a throw.
const makeMetricsStub = () => {
    const gauge = { inc: vi.fn(), dec: vi.fn() }
    return {
        userOperationsInMempool: { labels: vi.fn(() => gauge) },
        userOperationsResubmitted: { labels: vi.fn(() => ({ inc: vi.fn() })) }
    } as unknown as Metrics
}

// The real validator is handed an object, so the stub takes one too: a case
// that varies its answer per userOp needs to read the sender off it.
type ValidateUserOpStub = (args: {
    userOp: UserOperation
}) => Promise<unknown>

const defaultValidateUserOp: ValidateUserOpStub = async () => ({
    storageMap: {},
    returnInfo: { prefund: 0n }
})

// `store` is an override for the one case whose config would otherwise select
// redis: the default is still the store the config asks for.
const makeHarness = ({
    config,
    validateUserOp,
    getStatus,
    store: storeOverride,
    monitor: monitorOverride,
    eventManager: eventManagerOverride
}: {
    config: AltoConfig
    validateUserOp?: ValidateUserOpStub
    getStatus?: () => ReputationStatus
    store?: MempoolStore
    monitor?: Monitor
    eventManager?: EventManager
}) => {
    const metrics = makeMetricsStub()
    const store = storeOverride ?? createMempoolStore({ config, metrics })

    // decreaseUserOpCount lives on the reputation manager, not the store.
    const decreaseUserOpCount = vi.fn()
    const reputationManager = {
        decreaseUserOpCount,
        getStatus: vi.fn(getStatus ?? (() => ReputationStatuses.ok)),
        decreaseUserOpSeenStatus: vi.fn(),
        increaseUserOpSeenStatus: vi.fn(),
        replaceUserOpSeenStatus: vi.fn()
    } as unknown as InterfaceReputationManager

    const validateUserOpMock = vi.fn(validateUserOp ?? defaultValidateUserOp)

    const validator = {
        validateUserOp: validateUserOpMock
    } as unknown as InterfaceValidator

    const mempool = new Mempool({
        config,
        metrics,
        monitor: monitorOverride ?? ({} as unknown as Monitor),
        reputationManager,
        validator,
        store,
        eventManager: eventManagerOverride ?? ({} as unknown as EventManager)
    })

    const storeSpies = {
        addOutstanding: vi.spyOn(store, "addOutstanding"),
        popOutstanding: vi.spyOn(store, "popOutstanding"),
        peekOutstanding: vi.spyOn(store, "peekOutstanding"),
        addProcessing: vi.spyOn(store, "addProcessing")
    }

    return {
        mempool,
        store,
        storeSpies,
        reputationSpies: { decreaseUserOpCount },
        validatorSpies: { validateUserOp: validateUserOpMock }
    }
}

const seedOutstanding = async (
    store: MempoolStore,
    entryPoint: Address,
    userOpInfos: UserOpInfo[]
) => {
    for (const userOpInfo of userOpInfos) {
        await store.addOutstanding({ entryPoint, userOpInfo })
    }
}

const bundleIds = (bundles: UserOperationBundle[]): number[][] =>
    bundles.map((bundle) =>
        bundle.userOps.map((userOpInfo) => idOf(userOpInfo.userOpHash))
    )

// Sorts ascending, so it answers "which ids are left", not "in what order the
// store holds them". A test asserting re-add ORDER must read the store itself.
const outstandingIds = async (
    store: MempoolStore,
    entryPoint: Address
): Promise<number[]> => {
    const userOpInfos = await store.dumpOutstanding(entryPoint)
    return userOpInfos
        .map((userOpInfo) => idOf(userOpInfo.userOpHash))
        .sort((a, b) => a - b)
}

const processingIds = async (
    store: MempoolStore,
    entryPoint: Address
): Promise<number[]> => {
    const userOpInfos = await store.dumpProcessing(entryPoint)
    return userOpInfos
        .map((userOpInfo) => idOf(userOpInfo.userOpHash))
        .sort((a, b) => a - b)
}

const sortIds = (ids: number[]) => [...ids].sort((a, b) => a - b)

const findById = (userOpInfos: UserOpInfo[], id: number): UserOpInfo => {
    const found = userOpInfos.find(
        (userOpInfo) => userOpInfo.userOpHash === hash(id)
    )
    if (!found) {
        throw new Error(`no userOp ${id} in ${userOpInfos.length} records`)
    }
    return found
}

// Matches the one debug event the cap branch emits (mempool.ts:1003-1016).
// Shared so "a deferral happened" and "no deferral happened" are decided by the
// same shape: a test asserting the absence of a cap event is only as good as
// the predicate the presence tests use.
const isCapEvent = (call: unknown[]) => {
    const payload = call[0] as { event?: string } | undefined
    return payload?.event === "userOpSkipped"
}

// Seeds through the spied store, then clears the mocks so every call count a
// test asserts on belongs to getBundles and not to the seeding. The entry point
// defaults to V0.6 because every case but the version ones uses it; those pass
// their own, and must pass a config whose entrypoints list matches.
const harnessSeededWith = async (
    userOpInfos: UserOpInfo[],
    config: AltoConfig = makeConfig(),
    entryPoint: Address = ENTRY_POINT_V06
) => {
    const harness = makeHarness({ config })
    await seedOutstanding(harness.store, entryPoint, userOpInfos)
    vi.clearAllMocks()
    return harness
}

// 36,000 bytes of calldata: large enough that three ops overflow the byte
// threshold while staying far below the 32M gas ceiling.
const BYTE_CALLDATA = `0x${"11".repeat(36_000)}` as Hex

const makeByteUserOpInfo = (id: number) =>
    makeUserOpInfoV06(id, { callData: BYTE_CALLDATA })

// A 20-byte entity address followed by trailing data: the shape
// getAddressFromInitCodeOrPaymasterAndData parses, taking the first 20 bytes
// and ignoring the rest (utils/userop.ts:194-204). Kept clear of senderOf()'s
// low addresses so an entity can never be mistaken for a sender.
const PAYMASTER = getAddress("0x00000000000000000000000000000000000000aa")
const FACTORY = getAddress("0x00000000000000000000000000000000000000bb")
const PAYMASTER_AND_DATA = `${PAYMASTER}${"00".repeat(12)}` as Hex
const INIT_CODE = `${FACTORY}deadbeef` as Hex

// Only ID 4 carries entities, so every entity assertion has one unambiguous
// source. The extra calldata moves ID 4's gas projection, which the fixture
// preconditions re-pin.
const makeEntityUserOpInfo = (id: number) =>
    id === 4
        ? makeUserOpInfoV06(4, {
              paymasterAndData: PAYMASTER_AND_DATA,
              initCode: INIT_CODE
          })
        : makeUserOpInfoV06(id)

// Seven plain V0.6 ops: three bundles of 3/3/1 at the default ceiling, which
// puts the carry slot in play twice. A function, not a constant, so each test
// seeds records the store is free to mutate.
const sevenGasOps = () =>
    [1, 2, 3, 4, 5, 6, 7].map((id) => makeUserOpInfoV06(id))

// The executor scales the AA95 floor by 105% before sending, and the mempool
// budgets against that same scaled value.
const projectGas = (userOps: UserOperation[]) =>
    scaleBigIntByPercent(
        calculateAA95GasFloor({ userOps, beneficiary: BENEFICIARY }),
        105n
    )

// The bare userOps behind the two fixtures the gas projections are tuned
// against. Shared so a precondition and the test it guards can never be
// measuring different ops.
const gasFixture = (ids: number[]) =>
    ids.map((id) => makeUserOpInfoV06(id).userOp)

const v07Fixture = (ids: number[]) =>
    ids.map((id) => makeUserOpInfoV07(id).userOp)

// The entry point defaults to V0.6 because every fixture but the version cases
// uses it; those pass their own so the byte projection matches the tx the
// mempool would actually serialize.
const projectBytes = (
    userOps: UserOperation[],
    entryPoint: Address = ENTRY_POINT_V06
) =>
    size(
        getSerializedHandleOpsTx({
            userOps,
            entryPoint,
            chainId: CHAIN_ID,
            removeZeros: false
        })
    )

// Captured as shouldSkip is entered, BEFORE the real method mutates anything,
// so `sendersSize` and the key lists describe what the bundle handed in rather
// than what it looked like afterwards. `args` keeps the live references, which
// is the only way to tell "emptied in place" from "a genuinely new object".
type SkipObservation = {
    userOpHash: Hex
    sendersSize: number
    depositKeys: string[]
    stakedEntityKeys: string[]
    storageMapKeys: string[]
    knownSenders: Address[]
    knownPaymasters: Address[]
    knownFactories: Address[]
    args: Parameters<Mempool["shouldSkip"]>[0]
    skip?: boolean
}

// A call-through observer, not a replacement: the real skip logic still runs
// and still decides, so a test can watch the accumulators without changing
// what the mempool does with them.
const observeShouldSkip = (mempool: Mempool): SkipObservation[] => {
    const observations: SkipObservation[] = []
    const realShouldSkip = mempool.shouldSkip.bind(mempool)

    vi.spyOn(mempool, "shouldSkip").mockImplementation(async (args) => {
        const observation: SkipObservation = {
            userOpHash: args.userOpInfo.userOpHash,
            sendersSize: args.senders.size,
            depositKeys: Object.keys(args.paymasterDeposit),
            stakedEntityKeys: Object.keys(args.stakedEntityCount),
            storageMapKeys: Object.keys(args.storageMap),
            knownSenders: [...args.knownEntities.sender],
            knownPaymasters: [...args.knownEntities.paymasters],
            knownFactories: [...args.knownEntities.factories],
            args
        }
        observations.push(observation)

        const result = await realShouldSkip(args)
        observation.skip = result.skip
        return result
    })

    return observations
}

const observationsFor = (observations: SkipObservation[], id: number) =>
    observations.filter((observation) => observation.userOpHash === hash(id))

// Hands every accumulator straight back, so only the skip decision is under
// test. `removeOutstanding` stays off the result unless a permanent drop is
// asked for, because the mempool branches on the property being present.
const stubSecondEvaluationSkip = ({
    mempool,
    targetId,
    removeOutstanding
}: {
    mempool: Mempool
    targetId: number
    removeOutstanding?: true
}): void => {
    const evaluations = new Map<Hex, number>()

    vi.spyOn(mempool, "shouldSkip").mockImplementation(
        ({
            userOpInfo,
            paymasterDeposit,
            stakedEntityCount,
            knownEntities,
            senders,
            storageMap
        }) => {
            const evaluation = (evaluations.get(userOpInfo.userOpHash) ?? 0) + 1
            evaluations.set(userOpInfo.userOpHash, evaluation)

            const skip =
                userOpInfo.userOpHash === hash(targetId) && evaluation === 2

            return Promise.resolve({
                skip,
                ...(skip && removeOutstanding ? { removeOutstanding } : {}),
                paymasterDeposit,
                stakedEntityCount,
                knownEntities,
                senders,
                storageMap
            })
        }
    )
}

type BudgetedStoreMethod =
    | "peekOutstanding"
    | "popOutstanding"
    | "addOutstanding"
    | "addProcessing"

// A carry that leaked back into the loop would pop and re-add the same op
// forever. Capping total store calls turns that regression into a reported
// failure instead of a hung run. Wraps the harness spies rather than replacing
// them, so call counts still record.
const withStoreCallBudget = (store: MempoolStore, budget: number): void => {
    const methods: BudgetedStoreMethod[] = [
        "peekOutstanding",
        "popOutstanding",
        "addOutstanding",
        "addProcessing"
    ]
    const budgeted = store as unknown as Record<
        BudgetedStoreMethod,
        (...args: never[]) => unknown
    >
    let calls = 0

    for (const method of methods) {
        const original = budgeted[method].bind(store)
        budgeted[method] = (...args: never[]) => {
            calls += 1
            if (calls > budget) {
                throw new Error(
                    `store call budget of ${budget} exhausted at ${method}`
                )
            }
            return original(...args)
        }
    }
}

// Wraps the spied method rather than replacing it, the same way
// withStoreCallBudget does, so the harness spy still records the calls that get
// through. The throw is synchronous on purpose: process() does not await
// addProcessing (mempool.ts:1037), so a rejected promise would surface as an
// unhandled rejection instead of failing getBundles.
const throwOnAddProcessing = (store: MempoolStore, userOpHash: Hex): void => {
    const target = store as unknown as Record<
        "addProcessing",
        (args: { entryPoint: Address; userOpInfo: UserOpInfo }) => unknown
    >
    const spied = target.addProcessing.bind(store)

    target.addProcessing = (args) => {
        if (args.userOpInfo.userOpHash === userOpHash) {
            throw new Error("processing store down")
        }
        return spied(args)
    }
}

// getKnownEntities is called once per bundle setup (mempool.ts:840), so it
// doubles as a bundle counter. Calls through for every setup but the failOn-th,
// which throws. Returns the running count so a test can pin where the failure
// landed, or — with failOn set past the expected number of bundles — use it as
// a budget that turns an unbounded bundle loop into a reported failure instead
// of a hung run. withStoreCallBudget cannot stand in for that: a bundle loop
// spinning on the carry slot re-reads entities through dumpOutstanding and
// never touches any of the four methods that budget wraps.
const throwOnSetupCall = (
    mempool: Mempool,
    failOn: number,
    message: string
): { calls: () => number } => {
    const realGetKnownEntities = mempool.getKnownEntities.bind(mempool)
    let setupCalls = 0

    vi.spyOn(mempool, "getKnownEntities").mockImplementation(
        async (entryPoint) => {
            setupCalls += 1
            if (setupCalls === failOn) {
                throw new Error(message)
            }
            return await realGetKnownEntities(entryPoint)
        }
    )

    return { calls: () => setupCalls }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe("fixture preconditions", () => {
    const byteFixture = (ids: number[]) =>
        ids.map((id) => makeByteUserOpInfo(id).userOp)

    // The store keys off the entry point as a raw string: storeHandlers is a
    // Map indexed by it (createMempoolStore.ts:43,104) and the redis key names
    // embed it verbatim (:77-79). A non-canonical spelling would either miss
    // the handler lookup outright or split one entry point's data across two
    // keys. Version selection is NOT at risk here — isVersion08 tests
    // startsWith("0x4337") (utils/userop.ts:46-51), which is digit-only and so
    // case-invariant.
    it("spells every entry point in canonical checksummed form", () => {
        expect(getAddress(ENTRY_POINT_V06)).toBe(ENTRY_POINT_V06)
        expect(getAddress(ENTRY_POINT_V07)).toBe(ENTRY_POINT_V07)
        expect(getAddress(ENTRY_POINT_V08)).toBe(ENTRY_POINT_V08)
    })

    // Pins the V0.7 fixture the later version tests build on, and pins it to
    // V0.6's shared field block so the two builders cannot drift apart.
    it("builds a V0.7 fixture sharing V0.6's common fields", () => {
        const v06 = makeUserOpInfoV06(3)
        const v07 = makeUserOpInfoV07(3)

        expect(v07.userOp).toStrictEqual({
            sender: senderOf(3),
            nonce: 0n,
            callData: "0x",
            callGasLimit: 6_000_000n,
            verificationGasLimit: 350_000n,
            preVerificationGas: 100_000n,
            maxFeePerGas: 3n,
            maxPriorityFeePerGas: 1n,
            signature: "0x",
            factory: null,
            factoryData: null,
            paymaster: null,
            paymasterData: null,
            paymasterVerificationGasLimit: null,
            paymasterPostOpGasLimit: null
        })
        expect(v07.userOpHash).toBe(v06.userOpHash)
        expect(v07.userOp.sender).toBe(v06.userOp.sender)
        expect(v07.userOp.maxFeePerGas).toBe(v06.userOp.maxFeePerGas)
    })

    it("resolves the arbitrum caps the fixtures are tuned against", () => {
        const caps = getBundleCaps(makeConfig())

        expect(caps.gasCap).toBe(32_000_000n)
        expect(bundleByteThreshold(caps.byteCap)).toBe(106_167)
    })

    it("puts the gas fixture's cap boundary between three and four ops", () => {
        expect(projectGas(gasFixture([1]))).toBe(7_074_912n)
        expect(projectGas(gasFixture([1, 2]))).toBe(14_149_825n)
        expect(projectGas(gasFixture([1, 2, 3]))).toBe(21_224_737n)
        expect(projectGas(gasFixture([1, 2, 3, 4]))).toBe(28_299_650n)

        expect(projectGas(gasFixture([1, 2, 3]))).toBeLessThanOrEqual(
            27_000_000n
        )
        expect(projectGas(gasFixture([1, 2, 3, 4]))).toBeGreaterThan(
            27_000_000n
        )
    })

    it("keeps the gas fixture far below the byte threshold", () => {
        expect(projectBytes(gasFixture([1]))).toBe(731)
        expect(projectBytes(gasFixture([1, 2]))).toBe(1_243)
        expect(projectBytes(gasFixture([1, 2, 3]))).toBe(1_755)
        expect(projectBytes(gasFixture([1, 2, 3, 4]))).toBe(2_267)

        expect(projectBytes(gasFixture([1, 2, 3, 4]))).toBeLessThan(106_167)
    })

    it("puts the byte fixture's cap boundary between two and three ops", () => {
        expect(projectBytes(byteFixture([1]))).toBe(36_731)
        expect(projectBytes(byteFixture([1, 2]))).toBe(73_245)
        expect(projectBytes(byteFixture([1, 2, 3]))).toBe(109_757)
        expect(projectBytes(byteFixture([1, 2, 3, 4]))).toBe(146_269)

        expect(projectBytes(byteFixture([1, 2]))).toBeLessThanOrEqual(106_167)
        expect(projectBytes(byteFixture([1, 2, 3]))).toBeGreaterThan(106_167)
    })

    // T7 gives both entry points the SAME ceiling, because getBundles passes a
    // single maxGasPerBundle to every entry point (mempool.ts:751-757). The
    // V0.7 fixture packs lighter than V0.6, so pin its boundary too: if either
    // baseline moves, T7 must be retuned rather than silently repacking.
    it("puts the V0.7 fixture's cap boundary between three and four ops", () => {
        expect(projectGas(v07Fixture([1, 2, 3]))).toBe(20_437_678n)
        expect(projectGas(v07Fixture([1, 2, 3, 4]))).toBe(27_250_238n)

        expect(projectGas(v07Fixture([1, 2, 3]))).toBeLessThanOrEqual(
            27_000_000n
        )
        expect(projectGas(v07Fixture([1, 2, 3, 4]))).toBeGreaterThan(
            27_000_000n
        )
    })

    // T13 gives ID 4 a paymaster and a factory. That lengthens the handleOps
    // calldata and so moves the gas projection, which is why the boundary is
    // re-pinned here rather than inherited: if it ever slid, T13 would defer a
    // different op than the one it asserts about.
    it("keeps the entity fixture's cap boundary between three and four ops", () => {
        const entityFixture = (ids: number[]) =>
            ids.map((id) => makeEntityUserOpInfo(id).userOp)

        expect(projectGas(entityFixture([1, 2, 3]))).toBe(21_224_737n)
        expect(projectGas(entityFixture([1, 2, 3, 4]))).toBe(28_300_007n)

        expect(projectGas(entityFixture([1, 2, 3]))).toBeLessThanOrEqual(
            27_000_000n
        )
        expect(projectGas(entityFixture([1, 2, 3, 4]))).toBeGreaterThan(
            27_000_000n
        )

        expect(projectBytes(entityFixture([1, 2, 3, 4]))).toBe(2_331)
        expect(projectBytes(entityFixture([1, 2, 3, 4]))).toBeLessThan(106_167)

        // The entity fields are only useful if the mempool reads the same two
        // addresses out of them that the assertions name.
        expect(
            getAddressFromInitCodeOrPaymasterAndData(PAYMASTER_AND_DATA)
        ).toBe(PAYMASTER)
        expect(getAddressFromInitCodeOrPaymasterAndData(INIT_CODE)).toBe(
            FACTORY
        )
    })

    it("keeps the byte fixture below the gas ceiling, so bytes bind", () => {
        expect(projectGas(byteFixture([1]))).toBe(7_679_737n)
        expect(projectGas(byteFixture([1, 2]))).toBe(15_359_475n)
        expect(projectGas(byteFixture([1, 2, 3]))).toBe(23_039_213n)
        expect(projectGas(byteFixture([1, 2, 3, 4]))).toBe(30_718_951n)

        expect(projectGas(byteFixture([1, 2, 3]))).toBeLessThan(32_000_000n)
    })
})

describe("Mempool.getBundles", () => {
    it("T1: drains the whole backlog across gas cap boundaries", async () => {
        const config = makeConfig()
        const { mempool, store, storeSpies } = makeHarness({ config })

        await seedOutstanding(store, ENTRY_POINT_V06, sevenGasOps())
        vi.clearAllMocks()

        const bundles = await mempool.getBundles()

        expect(bundleIds(bundles)).toEqual([[1, 2, 3], [4, 5, 6], [7]])
        expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
        expect(storeSpies.popOutstanding).toHaveBeenCalledTimes(7)
        expect(storeSpies.addOutstanding).not.toHaveBeenCalled()
    })

    it("T2: drains the whole backlog across byte cap boundaries", async () => {
        const config = makeConfig({ maxGasPerBundle: 32_000_000n })
        const { mempool, store, storeSpies } = makeHarness({ config })

        await seedOutstanding(
            store,
            ENTRY_POINT_V06,
            [1, 2, 3, 4].map((id) => makeByteUserOpInfo(id))
        )
        vi.clearAllMocks()

        const bundles = await mempool.getBundles()

        expect(bundleIds(bundles)).toEqual([
            [1, 2],
            [3, 4]
        ])
        expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
        expect(storeSpies.popOutstanding).toHaveBeenCalledTimes(4)
        expect(storeSpies.addOutstanding).not.toHaveBeenCalled()

        const capCall = debugMock.mock.calls.find(isCapEvent)

        expect(capCall).toBeDefined()
        expect(capCall?.[0]).toStrictEqual({
            event: "userOpSkipped",
            reason: "Bundle byte size limit exceeded",
            userOpHash: hash(3),
            projectedGas: "23039213",
            gasCeiling: "32000000",
            projectedBytes: 109_757,
            byteThreshold: 106_167
        })
        expect(capCall?.[1]).toBe(
            `Skipping userOp ${hash(3)}, would exceed bundle cap.`
        )
    })

    // The returned bundles and the processing store are two views of the SAME
    // accepted ops, so they are never summed. The conservation law is:
    // bundled + still-outstanding === seeded, with multiplicity.
    it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
        "T3: conserves every userOp with %i seeded",
        async (count) => {
            const seededIds = Array.from({ length: count }, (_, i) => i + 1)
            const { mempool, store, storeSpies, reputationSpies } =
                await harnessSeededWith(
                    seededIds.map((id) => makeUserOpInfoV06(id))
                )

            const bundles = await mempool.getBundles()

            const bundledIds = bundleIds(bundles).flat()
            const leftoverIds = await outstandingIds(store, ENTRY_POINT_V06)

            expect(sortIds([...bundledIds, ...leftoverIds])).toEqual(seededIds)

            // Conservation alone is satisfied by bundling NOTHING: both sides
            // of the comparison above collapse to the seeded list. Pin the
            // packing too — three ops per bundle at the default ceiling.
            expect(bundles).toHaveLength(Math.ceil(count / 3))

            // Exactly one processing write per returned op, and nothing extra.
            const processedIds = storeSpies.addProcessing.mock.calls.map(
                (call) => idOf(call[0].userOpInfo.userOpHash)
            )
            expect(sortIds(processedIds)).toEqual(sortIds(bundledIds))

            // The reputation manager sees the userOp itself, not its hash.
            const decreasedSenders =
                reputationSpies.decreaseUserOpCount.mock.calls
                    .map((call) => (call[0] as UserOperation).sender)
                    .sort()
            expect(decreasedSenders).toEqual(
                bundledIds.map((id) => senderOf(id)).sort()
            )
        }
    )

    it("T4: holds the carry without re-reading the emptied store", async () => {
        const { mempool, store, storeSpies } = await harnessSeededWith(
            [1, 2, 3, 4].map((id) => makeUserOpInfoV06(id))
        )

        const bundles = await mempool.getBundles()

        expect(bundleIds(bundles)).toEqual([[1, 2, 3], [4]])
        expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
        expect(storeSpies.popOutstanding).toHaveBeenCalledTimes(4)
        expect(storeSpies.addOutstanding).not.toHaveBeenCalled()

        // Deferring ID 4 empties the store, so a carry that leaked back into
        // the loop conditions would peek or pop an empty store before ID 4 is
        // accepted. Bracket that window and assert nothing touches outstanding
        // inside it: both loop conditions must short-circuit on a live carry.
        const deferIndex = debugMock.mock.calls.findIndex(isCapEvent)
        expect(deferIndex).toBeGreaterThanOrEqual(0)

        const acceptIndex = storeSpies.addProcessing.mock.calls.findIndex(
            (call) => call[0].userOpInfo.userOpHash === hash(4)
        )
        expect(acceptIndex).toBeGreaterThanOrEqual(0)

        const deferOrder = debugMock.mock.invocationCallOrder[deferIndex]
        const acceptOrder =
            storeSpies.addProcessing.mock.invocationCallOrder[acceptIndex]

        // Guards the window itself: an inverted or empty bracket would make
        // the filter below trivially pass.
        expect(acceptOrder).toBeGreaterThan(deferOrder)

        const readsInsideCarry = [
            ...storeSpies.peekOutstanding.mock.invocationCallOrder,
            ...storeSpies.popOutstanding.mock.invocationCallOrder
        ].filter((order) => order > deferOrder && order < acceptOrder)

        expect(readsInsideCarry).toEqual([])
    })

    describe("T5: maxBundleCount stops with exactly one cleanup write", () => {
        it("returns one bundle and restores the carried op once", async () => {
            const { mempool, store, storeSpies } = await harnessSeededWith(
                sevenGasOps()
            )

            const bundles = await mempool.getBundles(1)

            expect(bundleIds(bundles)).toEqual([[1, 2, 3]])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
                4, 5, 6, 7
            ])
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            expect(
                storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
            ).toBe(hash(4))

            // The carried op was never accepted, so it must not have been
            // written to processing alongside the bundle it was deferred from.
            expect(await processingIds(store, ENTRY_POINT_V06)).toEqual([
                1, 2, 3
            ])
        })

        it("returns two bundles and restores the carried op once", async () => {
            const { mempool, store, storeSpies } = await harnessSeededWith(
                sevenGasOps()
            )

            const bundles = await mempool.getBundles(2)

            expect(bundleIds(bundles)).toEqual([
                [1, 2, 3],
                [4, 5, 6]
            ])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([7])
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            expect(
                storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
            ).toBe(hash(7))
            expect(await processingIds(store, ENTRY_POINT_V06)).toEqual([
                1, 2, 3, 4, 5, 6
            ])
        })

        // 0 is falsy, so it takes the same unlimited branch as undefined.
        it.each([0, undefined])(
            "treats maxBundleCount %s as unlimited",
            async (maxBundleCount) => {
                const { mempool, store, storeSpies } = await harnessSeededWith(
                    sevenGasOps()
                )

                const bundles = await mempool.getBundles(maxBundleCount)

                expect(bundleIds(bundles)).toEqual([[1, 2, 3], [4, 5, 6], [7]])
                expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
                expect(storeSpies.addOutstanding).not.toHaveBeenCalled()
            }
        )
    })

    describe("T6: preserves userOp metadata", () => {
        let nowSpy: MockInstance<typeof Date.now>

        beforeEach(() => {
            nowSpy = vi.spyOn(Date, "now").mockReturnValue(2000)
        })

        afterEach(() => {
            nowSpy.mockRestore()
        })

        // Populated, not absent: a test that only checks an absent field stays
        // absent would also pass an implementation that wipes a real value.
        const referencedContracts = {
            addresses: [senderOf(4)],
            hash: hash(99)
        }

        // `reentered` is left off the record entirely when not requested, so
        // "still absent" is distinguishable from "assigned undefined".
        const sevenOpsWithMetadata = (reentered?: true): UserOpInfo[] =>
            [1, 2, 3, 4, 5, 6, 7].map((id) => {
                const userOpInfo = makeUserOpInfoV06(id)
                if (id !== 4) {
                    return userOpInfo
                }
                return {
                    ...userOpInfo,
                    referencedContracts,
                    ...(reentered ? { reentered } : {})
                }
            })

        it("A: keeps every field on the op restored by cleanup", async () => {
            const { mempool, store } = await harnessSeededWith(
                sevenOpsWithMetadata()
            )

            await mempool.getBundles(1)

            const restored = findById(
                await store.dumpOutstanding(ENTRY_POINT_V06),
                4
            )

            expect(restored.receivedAt).toBe(900)
            expect(restored.addedToMempool).toBe(1000)
            expect(restored.submissionAttempts).toBe(0)
            expect(restored.referencedContracts).toStrictEqual(
                referencedContracts
            )
            expect("reentered" in restored).toBe(false)
            expect("processingAt" in restored).toBe(false)
            expect("bundledAt" in restored).toBe(false)
        })

        it("B: never resets reentered on the op restored by cleanup", async () => {
            const { mempool, store } = await harnessSeededWith(
                sevenOpsWithMetadata(true)
            )

            await mempool.getBundles(1)

            const restored = findById(
                await store.dumpOutstanding(ENTRY_POINT_V06),
                4
            )

            expect(restored.reentered).toBe(true)
            expect(restored.referencedContracts).toStrictEqual(
                referencedContracts
            )
            expect("processingAt" in restored).toBe(false)
        })

        it("C: keeps every field on the op accepted from the carry", async () => {
            const { mempool } = await harnessSeededWith(sevenOpsWithMetadata())

            const bundles = await mempool.getBundles()

            expect(bundleIds(bundles)).toEqual([[1, 2, 3], [4, 5, 6], [7]])

            const accepted = findById(bundles[1].userOps, 4)

            expect(accepted.processingAt).toBe(2000)
            expect(accepted.receivedAt).toBe(900)
            expect(accepted.addedToMempool).toBe(1000)
            expect(accepted.referencedContracts).toStrictEqual(
                referencedContracts
            )
            expect("reentered" in accepted).toBe(false)
        })

        // Acceptance is where a naive "clear the flag once it bundles" would
        // slip past case B, which only exercises the cleanup path.
        it("D: never resets reentered on the op accepted from the carry", async () => {
            const { mempool } = await harnessSeededWith(
                sevenOpsWithMetadata(true)
            )

            const bundles = await mempool.getBundles()

            const accepted = findById(bundles[1].userOps, 4)

            expect(accepted.reentered).toBe(true)
            expect(accepted.processingAt).toBe(2000)
            expect(accepted.referencedContracts).toStrictEqual(
                referencedContracts
            )
        })
    })

    describe("bundledAt stamped when a bundle completes", () => {
        let nowSpy: MockInstance<typeof Date.now>
        let counter: number

        beforeEach(() => {
            counter = 2000
            nowSpy = vi.spyOn(Date, "now").mockImplementation(() => counter++)
        })

        afterEach(() => {
            nowSpy.mockRestore()
        })

        it("stamps every op in a bundle alike, strictly increasing across bundles", async () => {
            const { mempool } = await harnessSeededWith(sevenGasOps())

            const bundles = await mempool.getBundles()

            expect(bundleIds(bundles)).toEqual([[1, 2, 3], [4, 5, 6], [7]])

            const bundledAtByBundle = bundles.map((bundle) => {
                const stamps = bundle.userOps.map(
                    (userOpInfo) => userOpInfo.bundledAt
                )
                expect(new Set(stamps).size).toBe(1)
                for (const userOpInfo of bundle.userOps) {
                    expect(userOpInfo.bundledAt).toBeGreaterThanOrEqual(
                        userOpInfo.processingAt as number
                    )
                }
                return stamps[0] as number
            })

            expect(bundledAtByBundle[0]).toBeLessThan(bundledAtByBundle[1])
            expect(bundledAtByBundle[1]).toBeLessThan(bundledAtByBundle[2])
        })

        it("overwrites a stale bundledAt with the fresh bundle timestamp", async () => {
            const staleUserOps = sevenGasOps().map((userOpInfo) =>
                userOpInfo.userOpHash === hash(1)
                    ? { ...userOpInfo, bundledAt: 1 }
                    : userOpInfo
            )
            const { mempool } = await harnessSeededWith(staleUserOps)

            const bundles = await mempool.getBundles()

            const restampedOp = findById(bundles[0].userOps, 1)
            const restOfBundle = bundles[0].userOps.filter(
                (userOpInfo) => userOpInfo.userOpHash !== hash(1)
            )

            expect(restampedOp.bundledAt).not.toBe(1)
            expect(restampedOp.bundledAt).toBe(restOfBundle[0].bundledAt)
        })
    })

    // maxBundleCount is one bundle PER ENTRY POINT, not one overall, and the
    // single maxGasPerBundle reaches both (mempool.ts:751-757).
    it("T7: applies maxBundleCount to each entry point", async () => {
        const config = makeConfig({
            entrypoints: [ENTRY_POINT_V06, ENTRY_POINT_V07]
        })
        const { mempool, store } = makeHarness({ config })

        await seedOutstanding(
            store,
            ENTRY_POINT_V06,
            [1, 2, 3, 4].map((id) => makeUserOpInfoV06(id))
        )
        await seedOutstanding(
            store,
            ENTRY_POINT_V07,
            [1, 2, 3, 4].map((id) => makeUserOpInfoV07(id))
        )
        vi.clearAllMocks()

        const bundles = await mempool.getBundles(1)

        expect(bundles).toHaveLength(2)

        const bundleFor = (entryPoint: Address): UserOperationBundle => {
            const found = bundles.find(
                (bundle) => bundle.entryPoint === entryPoint
            )
            if (!found) {
                throw new Error(`no bundle for ${entryPoint}`)
            }
            return found
        }

        const v06Bundle = bundleFor(ENTRY_POINT_V06)
        const v07Bundle = bundleFor(ENTRY_POINT_V07)

        expect(v06Bundle.version).toBe("0.6")
        expect(v07Bundle.version).toBe("0.7")
        expect(bundleIds([v06Bundle])).toEqual([[1, 2, 3]])
        expect(bundleIds([v07Bundle])).toEqual([[1, 2, 3]])

        expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([4])
        expect(await outstandingIds(store, ENTRY_POINT_V07)).toEqual([4])
    })

    it("T8: re-evaluates a carried userOp against fresh accumulators", async () => {
        const { mempool, validatorSpies } = await harnessSeededWith(
            sevenGasOps(),
            makeConfig({ safeMode: true })
        )
        const observations = observeShouldSkip(mempool)

        const bundles = await mempool.getBundles()

        expect(bundleIds(bundles)).toEqual([[1, 2, 3], [4, 5, 6], [7]])

        // Twice and no more: once where the cap defers it, once where the next
        // bundle takes it. A third would mean it went round the store again.
        const carried = observationsFor(observations, 4)
        expect(carried).toHaveLength(2)

        const [firstPass, secondPass] = carried

        // End of bundle 1: ids 1-3 are already accumulated.
        expect(firstPass.sendersSize).toBe(3)

        // Start of bundle 2: every accumulator is empty again, so the carried
        // op is judged on its own rather than against a bundle it never joined.
        expect(secondPass.sendersSize).toBe(0)
        expect(secondPass.depositKeys).toEqual([])
        expect(secondPass.stakedEntityKeys).toEqual([])
        expect(secondPass.storageMapKeys).toEqual([])

        // Empty is not enough. Bundle 2 must get NEW objects: reusing bundle
        // 1's emptied ones would let a later mutation leak across bundles.
        expect(secondPass.args.senders).not.toBe(firstPass.args.senders)
        expect(secondPass.args.paymasterDeposit).not.toBe(
            firstPass.args.paymasterDeposit
        )
        expect(secondPass.args.stakedEntityCount).not.toBe(
            firstPass.args.stakedEntityCount
        )
        expect(secondPass.args.storageMap).not.toBe(firstPass.args.storageMap)
        expect(secondPass.args.knownEntities).not.toBe(
            firstPass.args.knownEntities
        )

        // Validation is handed the userOp and nothing else. A validator that
        // could see the accumulators would make "fresh" unverifiable here.
        expect(validatorSpies.validateUserOp).toHaveBeenCalled()
        for (const [args] of validatorSpies.validateUserOp.mock.calls) {
            expect(Object.keys(args).sort()).toEqual([
                "entryPoint",
                "queuedUserOps",
                "referencedContracts",
                "userOp"
            ])
        }
    })

    it("T9: writes a carried userOp back once when its re-evaluation skips", async () => {
        const { mempool, store, storeSpies } = await harnessSeededWith(
            sevenGasOps()
        )
        withStoreCallBudget(store, 50)
        stubSecondEvaluationSkip({ mempool, targetId: 4 })

        const bundles = await mempool.getBundles()

        // ID 4 goes back to outstanding, is immediately re-popped as the
        // cheapest op left, trips the repeat guard and ends the pass, so
        // bundle 2 never forms.
        expect(bundleIds(bundles)).toEqual([[1, 2, 3]])
        expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
            4, 5, 6, 7
        ])
        expect(await processingIds(store, ENTRY_POINT_V06)).toEqual([1, 2, 3])

        // Two writes, both ID 4: the skip write and the repeat-guard write. A
        // third is exactly what a carry slot still holding the op would add.
        const reAdded = storeSpies.addOutstanding.mock.calls.map(
            (call) => call[0].userOpInfo.userOpHash
        )
        expect(reAdded).toEqual([hash(4), hash(4)])

        expect(storeSpies.popOutstanding).toHaveBeenCalledTimes(5)
    })

    it("T10: drops a carried userOp whose re-evaluation removes it", async () => {
        const { mempool, store, storeSpies } = await harnessSeededWith(
            [1, 2, 3, 4].map((id) => makeUserOpInfoV06(id))
        )
        withStoreCallBudget(store, 50)
        stubSecondEvaluationSkip({
            mempool,
            targetId: 4,
            removeOutstanding: true
        })

        const bundles = await mempool.getBundles()

        // Conservation with an explicit drop: seeded minus ID 4, and ID 4 in
        // neither store.
        expect(bundleIds(bundles)).toEqual([[1, 2, 3]])
        expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
        expect(await processingIds(store, ENTRY_POINT_V06)).toEqual([1, 2, 3])

        // Not one write: not the skip re-add, which the drop declines, and not
        // a cleanup write, which would resurrect an op just dropped on purpose.
        expect(storeSpies.addOutstanding).not.toHaveBeenCalled()
    })

    it("T11: restores the carried userOp when bundle setup throws", async () => {
        const { mempool, store, storeSpies } = await harnessSeededWith(
            sevenGasOps()
        )

        // Bundle 1's snapshot is taken for real; bundle 2's throws. That is the
        // window where the slot holds ID 4 and nothing else can release it.
        const setups = throwOnSetupCall(mempool, 2, "entities unavailable")

        await expect(mempool.getBundles()).rejects.toThrow(
            "entities unavailable"
        )

        expect(setups.calls()).toBe(2)
        expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
        expect(
            storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
        ).toBe(hash(4))

        // ID 4 is back exactly once, next to the ops that never left.
        const leftover = await outstandingIds(store, ENTRY_POINT_V06)
        expect(leftover).toEqual([4, 5, 6, 7])
        expect(leftover.filter((id) => id === 4)).toHaveLength(1)

        // The throw means no bundle was returned at all, so IDs 1-3 remain in
        // processing. That is the observed state, not a claim that they were
        // returned or recovered.
        expect(await processingIds(store, ENTRY_POINT_V06)).toEqual([1, 2, 3])
    })

    it("T12: restores the carried userOp when its re-evaluation throws", async () => {
        const { mempool, store, storeSpies } = await harnessSeededWith(
            sevenGasOps()
        )

        // The throw has to come from shouldSkip itself. A validator that throws
        // is caught inside shouldSkip (mempool.ts:646-668) and turns into a
        // skip, which is T9's path rather than this one.
        const realShouldSkip = mempool.shouldSkip.bind(mempool)
        const evaluations = new Map<Hex, number>()
        vi.spyOn(mempool, "shouldSkip").mockImplementation(async (args) => {
            const { userOpHash } = args.userOpInfo
            const evaluation = (evaluations.get(userOpHash) ?? 0) + 1
            evaluations.set(userOpHash, evaluation)

            if (userOpHash === hash(4) && evaluation === 2) {
                throw new Error("validation exploded")
            }

            return await realShouldSkip(args)
        })

        await expect(mempool.getBundles()).rejects.toThrow(
            "validation exploded"
        )

        // Cleanup resolved, so the caller sees the original failure unchanged.
        expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
        expect(
            storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
        ).toBe(hash(4))
        expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
            4, 5, 6, 7
        ])
    })

    // T11 covers bundle setup and T12 covers shouldSkip. Between them sits the
    // rest of the ownership window: the gas and byte maths that runs after the
    // skip decision and before the bundle takes the op.
    it("T12b: restores the carried userOp when the cap maths throws", async () => {
        const config = makeConfig()
        const { mempool, store, storeSpies } = await harnessSeededWith(
            sevenGasOps(),
            config
        )

        // Installed FIRST and left as the only shouldSkip spy: observeShouldSkip
        // captures mempool.shouldSkip at install time, so layering it over
        // another spy would silently make its call-through a stub.
        const observations = observeShouldSkip(mempool)

        // The beneficiary is read once per candidate that clears shouldSkip
        // (mempool.ts:945-947), which is the first statement after the skip
        // decision and before the cap comparison. Ops 1-4 read it in bundle 1
        // and the carried ID 4 reads it again in bundle 2, so the fifth read is
        // the carried candidate's. The test records where that read landed
        // rather than trusting the count.
        let beneficiaryReads = 0
        let observationsAtThrow = 0
        let skipAtThrow: boolean | undefined
        const utilityPrivateKey = { address: BENEFICIARY }
        Object.defineProperty(config, "utilityPrivateKey", {
            configurable: true,
            get: () => {
                beneficiaryReads += 1
                if (beneficiaryReads === 5) {
                    observationsAtThrow = observations.length
                    skipAtThrow = observations[observations.length - 1].skip
                    throw new Error("beneficiary unavailable")
                }
                return utilityPrivateKey
            }
        })

        await expect(mempool.getBundles()).rejects.toThrow(
            "beneficiary unavailable"
        )

        // Where the throw landed. The carried op's shouldSkip had already
        // resolved with a decision when it fired, so this is inside the window
        // T11 and T12 miss.
        expect(beneficiaryReads).toBe(5)
        expect(observationsAtThrow).toBe(5)
        expect(skipAtThrow).toBe(false)
        const carried = observationsFor(observations, 4)
        expect(carried).toHaveLength(2)
        expect(observations[4].userOpHash).toBe(hash(4))

        // And the acceptance block was never reached: no processing write for
        // ID 4, and the slot still held it, which it would not have past
        // mempool.ts:1033.
        expect(
            storeSpies.addProcessing.mock.calls.map(
                (call) => call[0].userOpInfo.userOpHash
            )
        ).toEqual([hash(1), hash(2), hash(3)])

        expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
        expect(
            storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
        ).toBe(hash(4))
        const leftover = await outstandingIds(store, ENTRY_POINT_V06)
        expect(leftover).toEqual([4, 5, 6, 7])
        expect(leftover.filter((id) => id === 4)).toHaveLength(1)
    })

    describe("T12c: a rejecting cleanup write becomes the failure", () => {
        it("a: replaces the normal return, and is not retried", async () => {
            const { mempool, storeSpies } = await harnessSeededWith(
                sevenGasOps()
            )
            storeSpies.addOutstanding.mockRejectedValue(new Error("store down"))

            // ID 4 is carried when maxBundleCount stops the pass, so the only
            // addOutstanding in this run is the cleanup write.
            await expect(mempool.getBundles(1)).rejects.toThrow("store down")

            // Normal finally semantics: the rejection replaces the bundles that
            // would otherwise have been returned. One attempt and no more, so a
            // failed write loses the op rather than looping.
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            expect(
                storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
            ).toBe(hash(4))
        })

        it("b: supersedes an in-flight exception", async () => {
            const { mempool, storeSpies } = await harnessSeededWith(
                sevenGasOps()
            )

            const setups = throwOnSetupCall(mempool, 2, "entities unavailable")
            storeSpies.addOutstanding.mockRejectedValue(new Error("store down"))

            // Observed behavior, not a guarantee the original error survives: a
            // rejecting finally supersedes the exception it was unwinding, and
            // the fix adds nothing to preserve it.
            await expect(mempool.getBundles()).rejects.toThrow("store down")

            expect(setups.calls()).toBe(2)
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            expect(
                storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
            ).toBe(hash(4))
        })
    })

    // Variant B — the release at the top of skip handling (mempool.ts:932) — is
    // already covered by T10, which asserts addOutstanding is never called when
    // a re-evaluation drops the carried op. Not duplicated here.
    it("T12d: writes nothing back once the bundle owns the carried userOp", async () => {
        const { mempool, store, storeSpies, reputationSpies } =
            await harnessSeededWith(
                [1, 2, 3, 4].map((id) => makeUserOpInfoV06(id))
            )
        throwOnAddProcessing(store, hash(4))

        await expect(mempool.getBundles()).rejects.toThrow(
            "processing store down"
        )

        // The op reached acceptance: the reputation write immediately after the
        // release (mempool.ts:1033-1035) ran for ID 4.
        expect(
            reputationSpies.decreaseUserOpCount.mock.calls.map(
                (call) => (call[0] as UserOperation).sender
            )
        ).toContain(senderOf(4))

        // So the slot was already empty and the finally had nothing to write.
        expect(storeSpies.addOutstanding).not.toHaveBeenCalled()

        // Observed outcome, not recovery: ID 4 is in neither store.
        expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
        expect(await processingIds(store, ENTRY_POINT_V06)).toEqual([1, 2, 3])
    })

    it("T13: rebuilds the entity snapshot around the carried userOp", async () => {
        const config = makeConfig({
            safeMode: true,
            // shouldSkip reads the paymaster's deposit through viem's
            // getContract, which routes read.balanceOf() to this method.
            publicClient: { readContract: vi.fn(async () => 10n ** 30n) }
        })
        const { mempool, store } = makeHarness({
            config,
            validateUserOp: async ({ userOp }) => ({
                // Only ID 5 touches another account's storage, and the account
                // it touches is the carried op's sender.
                storageMap:
                    userOp.sender === senderOf(5)
                        ? { [senderOf(4)]: hash(1) }
                        : {},
                returnInfo: { prefund: 0n }
            })
        })

        await seedOutstanding(
            store,
            ENTRY_POINT_V06,
            [1, 2, 3, 4, 5, 6, 7].map((id) => makeEntityUserOpInfo(id))
        )
        vi.clearAllMocks()

        const observations = observeShouldSkip(mempool)

        const bundles = await mempool.getBundles()

        expect(bundleIds(bundles)).toEqual([[1, 2, 3], [4]])
        expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([5, 6, 7])

        const carried = observationsFor(observations, 4)
        expect(carried).toHaveLength(2)
        const secondPass = carried[1]
        expect(secondPass.sendersSize).toBe(0)

        // The carried op has left outstanding, so the fresh snapshot cannot
        // list it. Its entities reach bundle 2 only if they are merged back.
        expect(secondPass.knownSenders).toContain(senderOf(4))
        expect(secondPass.knownPaymasters).toContain(PAYMASTER)
        expect(secondPass.knownFactories).toContain(FACTORY)

        // Still queued, so the fresh snapshot lists them.
        expect(secondPass.knownSenders).toContain(senderOf(5))
        expect(secondPass.knownSenders).toContain(senderOf(6))
        expect(secondPass.knownSenders).toContain(senderOf(7))

        // Bundled in bundle 1 and gone from outstanding: copying them forward
        // from the previous snapshot would block unrelated senders.
        expect(secondPass.knownSenders).not.toContain(senderOf(1))
        expect(secondPass.knownSenders).not.toContain(senderOf(2))
        expect(secondPass.knownSenders).not.toContain(senderOf(3))

        // The merged sender is load-bearing, not decorative: the real
        // shouldSkip rejects ID 5 because its storage key hits senderOf(4).
        const idFive = observationsFor(observations, 5)
        expect(idFive).toHaveLength(1)
        expect(idFive[0].skip).toBe(true)
        expect(silentLogger.trace).toHaveBeenCalledWith(
            { storageAddress: senderOf(4), userOpHash: hash(5) },
            "Storage address skipped"
        )
    })

    // Exercises process()'s entity-merge branch (mempool.ts:849-875) under a
    // redis-selecting config, not the redis store itself. The store handed in is
    // the real memory one, wrapped so its outstanding dump comes back empty the
    // way the redis outstanding queue's does. Nothing touches a network.
    it("T14: skips the entity merge when the config selects redis", async () => {
        const memoryStore = createMempoolStore({
            config: makeConfig(),
            metrics: makeMetricsStub()
        })
        const store: MempoolStore = {
            ...memoryStore,
            dumpOutstanding: async () => []
        }

        const config = makeConfig({
            enableHorizontalScaling: true,
            redisEndpoint: "redis://localhost:6379",
            // ID 4's paymaster deposit is read through viem's getContract.
            publicClient: { readContract: vi.fn(async () => 10n ** 30n) }
        })
        const { mempool } = makeHarness({ config, store })

        await seedOutstanding(
            store,
            ENTRY_POINT_V06,
            [1, 2, 3, 4, 5, 6, 7].map((id) => makeEntityUserOpInfo(id))
        )
        vi.clearAllMocks()

        const observations = observeShouldSkip(mempool)

        const bundles = await mempool.getBundles()

        // The branch changes the entity snapshot and nothing else: packing is
        // the same as on the memory path.
        expect(bundleIds(bundles)).toEqual([[1, 2, 3], [4, 5, 6], [7]])

        const carried = observationsFor(observations, 4)
        expect(carried).toHaveLength(2)
        const secondPass = carried[1]

        // T13 is the memory-path counterpart: there the carried op's sender,
        // paymaster and factory are merged back in. Here all three stay out.
        expect(secondPass.knownSenders).toEqual([])
        expect(secondPass.knownPaymasters).toEqual([])
        expect(secondPass.knownFactories).toEqual([])
    })

    // The carry slot changed WHEN a deferred op is re-offered, not WHETHER the
    // caps defer it. These pin the edges the fix had to leave alone.
    describe("T15: leaves the cap boundaries where they were", () => {
        it("a: returns nothing from an empty store without popping", async () => {
            const { mempool, storeSpies } = makeHarness({
                config: makeConfig()
            })

            expect(await mempool.getBundles()).toEqual([])

            // process() bails on the peek, so nothing is ever taken out.
            expect(storeSpies.popOutstanding).not.toHaveBeenCalled()
        })

        // The comparison is a strict `>` (mempool.ts:983-984). A projection
        // landing exactly ON the ceiling still fits, so this fails the moment
        // anyone relaxes it to `>=`.
        it("b: accepts a projection equal to the ceiling", async () => {
            expect(projectGas(gasFixture([1, 2, 3]))).toBe(21_224_737n)

            const { mempool, store, storeSpies } = await harnessSeededWith(
                [1, 2, 3].map((id) => makeUserOpInfoV06(id)),
                makeConfig({ maxGasPerBundle: 21_224_737n })
            )

            const bundles = await mempool.getBundles()

            expect(bundleIds(bundles)).toEqual([[1, 2, 3]])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
            expect(storeSpies.addOutstanding).not.toHaveBeenCalled()
        })

        // getBundles passes minOpsPerBundle: 1, so the cap branch's
        // `length >= minOpsPerBundle` is false at size 0 and a lone over-cap op
        // cannot be deferred. carryWouldSpin is false too — it came from a pop,
        // not the slot — so the bundle is what lets it through, not the fix.
        it("c: bundles a lone userOp that exceeds the ceiling by itself", async () => {
            expect(projectGas(gasFixture([1]))).toBeGreaterThan(7_000_000n)

            const { mempool, store, storeSpies } = await harnessSeededWith(
                [makeUserOpInfoV06(1)],
                makeConfig({ maxGasPerBundle: 7_000_000n })
            )

            const bundles = await mempool.getBundles()

            expect(bundleIds(bundles)).toEqual([[1]])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
            expect(storeSpies.addOutstanding).not.toHaveBeenCalled()

            // The shape above cannot tell the two paths apart on its own. Drop
            // the min-size guard and the op is deferred, carried, then rescued
            // by carryWouldSpin into an identical [[1]] — only the cap event it
            // logs on the way betrays the detour. Assert it never fired, so
            // this test pins the guard and not just the outcome.
            expect(debugMock.mock.calls.filter(isCapEvent)).toEqual([])
        })

        it("d: terminates and returns nothing when every userOp skips", async () => {
            const { mempool, store, storeSpies } = await harnessSeededWith(
                [1, 2, 3].map((id) => makeUserOpInfoV06(id))
            )

            // A carry that leaked back into the loop would pop and re-add
            // forever, so cap the store calls: the regression fails the test
            // instead of hanging the run.
            withStoreCallBudget(store, 50)

            // Skips WITHOUT removeOutstanding, so every candidate is written
            // straight back and the pass has to stop on the repeat guard rather
            // than on an emptied store.
            vi.spyOn(mempool, "shouldSkip").mockImplementation(
                ({
                    paymasterDeposit,
                    stakedEntityCount,
                    knownEntities,
                    senders,
                    storageMap
                }) =>
                    Promise.resolve({
                        skip: true,
                        paymasterDeposit,
                        stakedEntityCount,
                        knownEntities,
                        senders,
                        storageMap
                    })
            )

            expect(await mempool.getBundles()).toEqual([])

            // Every op is still queued and none reached a bundle.
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
                1, 2, 3
            ])
            expect(storeSpies.addProcessing).not.toHaveBeenCalled()
        })

        // getBundles hardcodes minOpsPerBundle: 1 (mempool.ts:751-757), so a
        // floor above 1 is only reachable by calling process() directly.
        //
        // The ceiling admits exactly ONE op, and that is what makes the floor
        // observable: every op after the first is already over the cap, so the
        // only thing that can put a second op into a bundle is the min-size
        // guard declining to defer it. At a looser ceiling minOpsPerBundle 1
        // and 2 pack identically and the test asserts nothing about the floor.
        it("e: honours a minOpsPerBundle above 1", async () => {
            expect(projectGas(gasFixture([1]))).toBe(7_074_912n)
            expect(projectGas(gasFixture([1, 2]))).toBeGreaterThan(7_074_912n)

            const { mempool, store } = await harnessSeededWith(
                [1, 2, 3, 4].map((id) => makeUserOpInfoV06(id))
            )

            const bundles = await mempool.process({
                entryPoint: ENTRY_POINT_V06,
                maxGasLimit: 7_074_912n,
                minOpsPerBundle: 2,
                maxBundleCount: undefined
            })

            // Pairs, not singletons. This is also R11 in the concrete: op 2 is
            // over the ceiling, and it still joins bundle 1 because the bundle
            // is below the minimum size. With minOpsPerBundle 1, or with the
            // `length >= minOpsPerBundle` guard removed, this is
            // [[1], [2], [3], [4]].
            expect(bundleIds(bundles)).toEqual([
                [1, 2],
                [3, 4]
            ])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
        })

        // R13: the reason is a ternary testing exceedsBytes FIRST
        // (mempool.ts:1005-1015), so bytes win a tie. T2 covers a byte-only
        // overflow; this is the case where both caps are genuinely over.
        it("f: reports the byte reason when both caps are exceeded", async () => {
            const threeByteOps = [1, 2, 3].map(
                (id) => makeByteUserOpInfo(id).userOp
            )

            // Without this, a fixture that quietly stopped exceeding the gas
            // cap would leave the assertion below proving nothing about
            // precedence — it would just be T2 again under another ceiling.
            expect(projectGas(threeByteOps)).toBe(23_039_213n)
            expect(projectGas(threeByteOps)).toBeGreaterThan(20_000_000n)
            expect(projectBytes(threeByteOps)).toBe(109_757)
            expect(projectBytes(threeByteOps)).toBeGreaterThan(106_167)

            const { mempool, store } = await harnessSeededWith(
                [1, 2, 3, 4].map((id) => makeByteUserOpInfo(id)),
                makeConfig({ maxGasPerBundle: 20_000_000n })
            )

            const bundles = await mempool.getBundles()

            expect(bundleIds(bundles)).toEqual([
                [1, 2],
                [3, 4]
            ])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])

            const capCall = debugMock.mock.calls.find(isCapEvent)

            expect(capCall).toBeDefined()
            expect(capCall?.[0]).toStrictEqual({
                event: "userOpSkipped",
                reason: "Bundle byte size limit exceeded",
                userOpHash: hash(3),
                projectedGas: "23039213",
                gasCeiling: "20000000",
                projectedBytes: 109_757,
                byteThreshold: 106_167
            })
            expect(capCall?.[1]).toBe(
                `Skipping userOp ${hash(3)}, would exceed bundle cap.`
            )
        })

        // minOpsPerBundle 0 is deliberate, and it is OUTSIDE the supported
        // contract: R12 excludes zero, negative and non-integer floors, and
        // getBundles only ever passes 1. carryWouldSpin is not spec-mandated
        // either — it is an owner-approved guard that exists solely so this
        // unsupported input fails loudly instead of hanging the process.
        //
        // Without it, the floor of 0 makes the cap branch defer a lone
        // over-ceiling op out of an EMPTY bundle. The carry slot hands the same
        // op straight back to the next bundle, which is empty again, which
        // defers it again: a bundle loop that never terminates and never
        // touches outstanding. The setup budget is what catches that; a store
        // call budget cannot, because the spinning path reads only through
        // dumpOutstanding.
        it("g: accepts a carried userOp rather than deferring it forever", async () => {
            expect(projectGas(gasFixture([1]))).toBeGreaterThan(7_000_000n)

            const { mempool, store, storeSpies } = await harnessSeededWith(
                [1, 2].map((id) => makeUserOpInfoV06(id))
            )

            // Three bundles are expected, so ten is slack an unbounded loop
            // blows through immediately.
            const setups = throwOnSetupCall(
                mempool,
                11,
                "bundle setup budget of 10 exhausted"
            )

            const bundles = await mempool.process({
                entryPoint: ENTRY_POINT_V06,
                maxGasLimit: 7_000_000n,
                minOpsPerBundle: 0,
                maxBundleCount: undefined
            })

            // Bundle 1 defers op 1 out of an empty bundle; bundle 2 takes it
            // from the carry because deferring it again would spin; bundle 2
            // then defers op 2; bundle 3 takes it the same way.
            expect(bundleIds(bundles)).toEqual([[1], [2]])
            expect(setups.calls()).toBe(3)
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])

            // Both ops were bundled, so the cleanup write never had anything
            // left to return.
            expect(storeSpies.addOutstanding).not.toHaveBeenCalled()
        })
    })

    describe("T16: packs every version and the 7702 overhead the same way", () => {
        // 13,625,119 is exactly what two V0.7 ops project, so the split below
        // rides the `>` boundary: two fit, three do not.
        const V07_CEILING = 13_625_119n

        it("pins the V0.7 ceiling both version cases are tuned to", () => {
            expect(projectGas(v07Fixture([1, 2]))).toBe(V07_CEILING)
            expect(projectGas(v07Fixture([1, 2, 3]))).toBe(20_437_678n)
            expect(projectGas(v07Fixture([1, 2, 3]))).toBeGreaterThan(
                V07_CEILING
            )

            // The second bundle has to fit on the same boundary, or the split
            // would owe something to a third bundle rather than to the cap.
            expect(projectGas(v07Fixture([3, 4]))).toBe(V07_CEILING)

            // Bytes must stay far off their own boundary, or the split would be
            // proving the byte cap instead of the gas cap.
            expect(
                projectBytes(v07Fixture([1, 2, 3, 4]), ENTRY_POINT_V07)
            ).toBe(2_011)
            expect(
                projectBytes(v07Fixture([1, 2, 3, 4]), ENTRY_POINT_V08)
            ).toBe(2_011)
            expect(
                projectBytes(v07Fixture([1, 2, 3, 4]), ENTRY_POINT_V07)
            ).toBeLessThan(106_167)
        })

        // One fixture, two entry points: isVersion08 selects purely on the
        // address starting 0x4337 (utils/userop.ts:46-51), so the label moves
        // and the packing does not.
        it.each([
            { entryPoint: ENTRY_POINT_V07, version: "0.7" },
            { entryPoint: ENTRY_POINT_V08, version: "0.8" }
        ])(
            "splits the V0.7 fixture at the gas ceiling and labels it $version",
            async ({ entryPoint, version }) => {
                const { mempool, store } = await harnessSeededWith(
                    [1, 2, 3, 4].map((id) => makeUserOpInfoV07(id)),
                    makeConfig({
                        entrypoints: [entryPoint],
                        maxGasPerBundle: V07_CEILING
                    }),
                    entryPoint
                )

                const bundles = await mempool.getBundles()

                expect(bundleIds(bundles)).toEqual([
                    [1, 2],
                    [3, 4]
                ])
                for (const bundle of bundles) {
                    expect(bundle.version).toBe(version)
                    expect(bundle.entryPoint).toBe(entryPoint)
                }
                expect(await outstandingIds(store, entryPoint)).toEqual([])
            }
        )

        // Synthetic test data. r and s are placeholders, signed by no key and
        // broadcast nowhere; the object exists only to make userOp.eip7702Auth
        // truthy so the 40,000 gas overhead applies (mempool.ts:953-955).
        const eip7702Auth = {
            address: BENEFICIARY,
            chainId: 42161,
            nonce: 0,
            yParity: 0,
            r: `0x${"0".repeat(63)}1` as Hex,
            s: `0x${"0".repeat(63)}1` as Hex
        }

        // Exactly what four unauthorized ops project, so the overhead is the
        // only thing that can push the fourth over.
        const AUTH_CEILING = 28_299_650n

        const fourGasOps = () => [1, 2, 3, 4].map((id) => makeUserOpInfoV06(id))

        it("packs four unauthorized ops into one bundle at the exact ceiling", async () => {
            expect(
                projectGas(fourGasOps().map((userOpInfo) => userOpInfo.userOp))
            ).toBe(AUTH_CEILING)

            const { mempool, store } = await harnessSeededWith(
                fourGasOps(),
                makeConfig({ maxGasPerBundle: AUTH_CEILING })
            )

            const bundles = await mempool.getBundles()

            expect(bundleIds(bundles)).toEqual([[1, 2, 3, 4]])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
        })

        it("defers the fourth op once it carries an authorization", async () => {
            const floorOfFour = calculateAA95GasFloor({
                userOps: fourGasOps().map((userOpInfo) => userOpInfo.userOp),
                beneficiary: BENEFICIARY
            })
            const withOverhead = scaleBigIntByPercent(
                floorOfFour + 40_000n,
                105n
            )

            // 40,000 on the raw floor is 42,000 after the 105% scale, and that
            // is the entire difference from the unauthorized case above.
            expect(withOverhead - AUTH_CEILING).toBe(42_000n)

            // Built once: the byte projection asserted below has to describe
            // the very ops the mempool was seeded with, or it would be pinning
            // a bundle that never existed.
            const authedOps = [
                ...[1, 2, 3].map((id) => makeUserOpInfoV06(id)),
                makeUserOpInfoV06(4, { eip7702Auth })
            ]

            const { mempool, store } = await harnessSeededWith(
                authedOps,
                makeConfig({ maxGasPerBundle: AUTH_CEILING })
            )

            const bundles = await mempool.getBundles()

            expect(bundleIds(bundles)).toEqual([[1, 2, 3], [4]])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])

            const capCall = debugMock.mock.calls.find(isCapEvent)

            expect(capCall).toBeDefined()
            expect(capCall?.[0]).toStrictEqual({
                event: "userOpSkipped",
                reason: "Bundle gas limit exceeded",
                userOpHash: hash(4),
                projectedGas: withOverhead.toString(),
                gasCeiling: AUTH_CEILING.toString(),
                projectedBytes: projectBytes(
                    authedOps.map((userOpInfo) => userOpInfo.userOp),
                    ENTRY_POINT_V06
                ),
                byteThreshold: 106_167
            })
        })
    })

    // The executor dispatches every bundle a pass returns concurrently and
    // simulates each in isolation, so a later nonce for a sender whose
    // earlier nonce sits in a previous bundle of the same pass would fail
    // AA25 before its predecessor lands and be dropped as not-found. The
    // pass must therefore never split one sender-and-nonce-key chain across
    // bundles. PR #66 review, P1.
    describe("nonce chains never span bundles within one pass", () => {
        // One sender, nonces 0..count-1, distinct hashes. The memory store
        // keeps only the lowest pending nonce per sender in its priority
        // queue and promotes the next on pop, so these pop in nonce order
        // regardless of fee.
        const chainOps = (count: number, sender = senderOf(1)) =>
            Array.from({ length: count }, (_, i) =>
                makeUserOpInfoV06(i + 1, { sender, nonce: BigInt(i) })
            )

        const processingIds = async (store: MempoolStore) =>
            (await store.dumpProcessing(ENTRY_POINT_V06))
                .map((userOpInfo) => idOf(userOpInfo.userOpHash))
                .sort((a, b) => a - b)

        it("hands back the first nonce whose predecessor is in an earlier bundle and ends the pass", async () => {
            const { mempool, store, storeSpies } = await harnessSeededWith(
                chainOps(7)
            )

            const bundles = await mempool.getBundles()

            // Nonces 0-2 pack; nonce 3 would exceed 27M and is carried. Its
            // slot is already in bundle 1, so it goes back to outstanding and
            // the pass ends instead of opening a bundle the executor would
            // dispatch alongside bundle 1.
            expect(bundleIds(bundles)).toEqual([[1, 2, 3]])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
                4, 5, 6, 7
            ])
            expect(await processingIds(store)).toEqual([1, 2, 3])

            // Exactly one write: the handed-back nonce 3, flagged reentered
            // like every other re-add path. No pop past the one handed back.
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            const [[written]] = storeSpies.addOutstanding.mock.calls
            expect(written.userOpInfo.userOpHash).toBe(hash(4))
            expect(written.userOpInfo.reentered).toBe(true)
            expect(storeSpies.popOutstanding).toHaveBeenCalledTimes(4)
        })

        it("still packs consecutive nonces into one bundle", async () => {
            const { mempool, store, storeSpies } = await harnessSeededWith(
                chainOps(3)
            )

            const bundles = await mempool.getBundles()

            // One handleOps call executes sequential nonces in order, so the
            // guard is per bundle, not per pass.
            expect(bundleIds(bundles)).toEqual([[1, 2, 3]])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
            expect(storeSpies.addOutstanding).not.toHaveBeenCalled()
        })

        it("ends the pass for the whole tick, so independent senders behind the chain wait too", async () => {
            // Sender A holds nonces 0-3 (ids 1-4); ids 5-7 are unrelated
            // senders. Fees ascend by id, so A's chain is popped first.
            const ops = [
                ...chainOps(4),
                makeUserOpInfoV06(5),
                makeUserOpInfoV06(6),
                makeUserOpInfoV06(7)
            ]
            const { mempool, store, storeSpies } = await harnessSeededWith(ops)

            const bundles = await mempool.getBundles()

            // Accepted cost of the guard: ending the pass is deterministic
            // regardless of store ordering, at the price of ids 5-7 waiting
            // one tick. Requeue-and-continue would re-pop nonce 3 on the
            // memory store and trip the repeat guard with a second write.
            expect(bundleIds(bundles)).toEqual([[1, 2, 3]])
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
                4, 5, 6, 7
            ])
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
        })
    })

    // getBundles() itself has no deadline: while arrivals keep the queue
    // non-empty, the carry path keeps consuming them and no completed bundle
    // reaches the caller. The auto-bundling tick bounds this with one bundle
    // per executor wallet, lowered by max-bundle-count if set (see
    // executorManager.test.ts). These two cases pin both halves of that
    // contract. PR #66 review, P1.
    describe("bundle budget under continuous arrivals", () => {
        // After every pop, add one fresh op with a higher fee so it sorts to
        // the tail and the queue never empties. Finite so a broken budget
        // fails loudly on the outstanding assertion instead of hanging.
        const installProducer = (store: MempoolStore, arrivals: number) => {
            let nextId = 100
            const realPop = store.popOutstanding.bind(store)
            store.popOutstanding = async (entryPoint) => {
                const popped = await realPop(entryPoint)
                if (nextId < 100 + arrivals) {
                    await store.addOutstanding({
                        entryPoint,
                        userOpInfo: makeUserOpInfoV06(nextId++)
                    })
                }
                return popped
            }
        }

        it("returns after the budget even though the producer is still active", async () => {
            const { mempool, store } = await harnessSeededWith(sevenGasOps())
            installProducer(store, 60)

            const bundles = await mempool.getBundles(2)

            expect(bundles).toHaveLength(2)
            // The pass ended on budget, not on exhaustion: work is still queued.
            const left = await outstandingIds(store, ENTRY_POINT_V06)
            expect(left.length).toBeGreaterThan(0)
        })

        it("without a budget runs until the producer stops", async () => {
            const { mempool, store } = await harnessSeededWith(sevenGasOps())
            installProducer(store, 60)

            const bundles = await mempool.getBundles()

            // 7 seeded + 60 arrivals, all drained in one call.
            expect(bundles.length).toBeGreaterThan(2)
            expect(
                bundles.reduce((sum, bundle) => sum + bundle.userOps.length, 0)
            ).toBe(67)
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([])
        })
    })
})

// A promise a test settles by hand, so a pass can be held at an exact point
// and released without a real sleep.
type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason: unknown) => void
}

const deferred = <T = void>(): Deferred<T> => {
    const handle = {} as Deferred<T>
    handle.promise = new Promise<T>((resolve, reject) => {
        handle.resolve = resolve
        handle.reject = reject
    })
    return handle
}

// Whether a promise has settled yet. Both outcomes are consumed here, so a
// rejection is never reported as unhandled; the caller still awaits the
// original promise for its value or error.
const trackSettled = (promise: Promise<unknown>): (() => boolean) => {
    let settled = false
    const markSettled = () => {
        settled = true
    }
    promise.then(markSettled, markSettled)
    return () => settled
}

// One macrotask turn: every microtask queued before it has run by the time it
// resolves, and so has Node's check for unhandled rejections.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

// Rejections nobody handled while `run` executed or within one turn after it,
// so a detached promise that rejects late in `run` is still caught. The
// listener is removed whatever happens.
const collectUnhandledRejections = async (
    run: () => Promise<void>
): Promise<unknown[]> => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
        unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
        await run()
        await nextTurn()
    } finally {
        process.off("unhandledRejection", onUnhandled)
    }
    return unhandled
}

describe("Mempool.getBundles onBundle", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    // Records every hand-over as it happens: the bundle object, for identity,
    // and a copy of its ids taken inside the callback, so a later mutation
    // cannot rewrite what the callback was actually handed.
    const recordHandOvers = (
        onEach?: (bundle: UserOperationBundle) => void
    ) => {
        const ids: number[][] = []
        const onBundle = vi.fn((bundle: UserOperationBundle) => {
            ids.push(bundleIds([bundle])[0])
            onEach?.(bundle)
        })
        const handed = () => onBundle.mock.calls.map(([bundle]) => bundle)
        return { onBundle, ids, handed }
    }

    // getKnownEntities runs once per bundle setup, before that bundle pops
    // anything, so it is where a test holds or fails a pass between two
    // bundles. `hook` sees each entry point's own running setup count and may
    // return a gate to wait on, or throw.
    const hookSetups = (
        mempool: Mempool,
        hook: (entryPoint: Address, call: number) => Promise<void> | undefined
    ): void => {
        const realGetKnownEntities = mempool.getKnownEntities.bind(mempool)
        const calls = new Map<Address, number>()
        vi.spyOn(mempool, "getKnownEntities").mockImplementation(
            async (entryPoint) => {
                const call = (calls.get(entryPoint) ?? 0) + 1
                calls.set(entryPoint, call)
                await hook(entryPoint, call)
                return await realGetKnownEntities(entryPoint)
            }
        )
    }

    // getBundles only exposes the combined result, and Promise.all settles on
    // the first rejection, so each entry point's own pass is kept here: it is
    // the only way to await a sibling that is still running.
    const capturePasses = (mempool: Mempool) => {
        const realProcess = mempool.process.bind(mempool)
        const passes = new Map<Address, Promise<UserOperationBundle[]>>()
        vi.spyOn(mempool, "process").mockImplementation((args) => {
            const pass = realProcess(args)
            passes.set(args.entryPoint, pass)
            return pass
        })
        return (entryPoint: Address) => {
            const pass = passes.get(entryPoint)
            if (!pass) {
                throw new Error(`no pass started for ${entryPoint}`)
            }
            return pass
        }
    }

    const twoEntryPointHarness = async (
        v06UserOps: UserOpInfo[],
        v07UserOps: UserOpInfo[]
    ) => {
        const harness = makeHarness({
            config: makeConfig({
                entrypoints: [ENTRY_POINT_V06, ENTRY_POINT_V07]
            })
        })
        await seedOutstanding(harness.store, ENTRY_POINT_V06, v06UserOps)
        await seedOutstanding(harness.store, ENTRY_POINT_V07, v07UserOps)
        vi.clearAllMocks()
        return harness
    }

    const v07Ops = (count: number) =>
        Array.from({ length: count }, (_, i) => makeUserOpInfoV07(i + 1))

    it("hands each bundle over once, in order, as the object it returns", async () => {
        const { mempool } = await harnessSeededWith(sevenGasOps())
        const stampsAtHandOver: (number | undefined)[][] = []
        const { onBundle, ids, handed } = recordHandOvers((bundle) => {
            stampsAtHandOver.push(
                bundle.userOps.map((userOpInfo) => userOpInfo.bundledAt)
            )
        })

        const bundles = await mempool.getBundles(undefined, onBundle)

        expect(onBundle).toHaveBeenCalledTimes(3)
        expect(ids).toEqual([[1, 2, 3], [4, 5, 6], [7]])
        expect(bundleIds(bundles)).toEqual(ids)
        for (const [index, bundle] of handed().entries()) {
            expect(bundle).toBe(bundles[index])
        }

        // Handed over complete: every op already carries its bundle's stamp.
        for (const stamps of stampsAtHandOver) {
            expect(stamps.every((stamp) => stamp !== undefined)).toBe(true)
            expect(new Set(stamps).size).toBe(1)
        }
    })

    it("hands a bundle over before the pass packs the next", async () => {
        const { mempool, storeSpies } = await harnessSeededWith(sevenGasOps())
        const processingWrites: number[] = []
        const pops: number[] = []
        const { onBundle } = recordHandOvers(() => {
            processingWrites.push(storeSpies.addProcessing.mock.calls.length)
            pops.push(storeSpies.popOutstanding.mock.calls.length)
        })

        await mempool.getBundles(undefined, onBundle)

        expect(processingWrites).toEqual([3, 6, 7])
        // Bundle 1 pops ids 1-4 and carries 4; bundle 2 takes 4 from the
        // carry, pops 5-7 and carries 7; bundle 3 takes 7 and pops nothing.
        // A hand-over after the next bundle's first pop would read 5 first.
        expect(pops).toEqual([4, 7, 7])
    })

    it("hands the bundle over before the budget exit writes the carry back", async () => {
        const { mempool, storeSpies } = await harnessSeededWith(sevenGasOps())
        const writesAtHandOver: number[] = []
        const { onBundle, ids, handed } = recordHandOvers(() => {
            writesAtHandOver.push(storeSpies.addOutstanding.mock.calls.length)
        })

        const bundles = await mempool.getBundles(1, onBundle)

        expect(ids).toEqual([[1, 2, 3]])
        expect(handed()[0]).toBe(bundles[0])
        expect(writesAtHandOver).toEqual([0])
        expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
        expect(
            storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
        ).toBe(hash(4))
    })

    describe("a callback that throws before accepting ownership", () => {
        const handOffError = new Error("executor refused the bundle")

        it("requeues that bundle once, restores the carry and rethrows", async () => {
            const { mempool, storeSpies } = await harnessSeededWith(
                sevenGasOps()
            )
            const resubmit = vi
                .spyOn(mempool, "resubmitUserOps")
                .mockResolvedValue(undefined)
            const { onBundle, handed } = recordHandOvers(() => {
                throw handOffError
            })

            await expect(mempool.getBundles(undefined, onBundle)).rejects.toBe(
                handOffError
            )

            expect(onBundle).toHaveBeenCalledTimes(1)
            const [refused] = handed()
            expect(bundleIds([refused])).toEqual([[1, 2, 3]])

            expect(silentLogger.error).toHaveBeenCalledTimes(1)
            expect(silentLogger.error).toHaveBeenCalledWith(
                {
                    err: handOffError,
                    userOpHashes: [hash(1), hash(2), hash(3)]
                },
                "onBundle callback threw"
            )

            expect(resubmit).toHaveBeenCalledTimes(1)
            expect(resubmit).toHaveBeenCalledWith({
                entryPoint: ENTRY_POINT_V06,
                userOps: refused.userOps,
                reason: "bundle_handoff_failed"
            })

            // The pass stopped at the failed hand-over: nothing more was
            // packed, and the carried op went back exactly once.
            expect(storeSpies.addProcessing).toHaveBeenCalledTimes(3)
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            expect(
                storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
            ).toBe(hash(4))
        })

        it("requeues only the refused bundle when a later hand-over throws", async () => {
            const { mempool, store, storeSpies } = await harnessSeededWith(
                sevenGasOps()
            )
            const resubmit = vi
                .spyOn(mempool, "resubmitUserOps")
                .mockResolvedValue(undefined)
            let handOvers = 0
            const { onBundle, ids } = recordHandOvers(() => {
                handOvers++
                if (handOvers === 2) {
                    throw handOffError
                }
            })

            await expect(mempool.getBundles(undefined, onBundle)).rejects.toBe(
                handOffError
            )

            // Bundle 1 was accepted, bundle 2 refused, and nothing after it
            // was packed.
            expect(ids).toEqual([
                [1, 2, 3],
                [4, 5, 6]
            ])

            expect(silentLogger.error).toHaveBeenCalledTimes(1)
            expect(silentLogger.error).toHaveBeenCalledWith(
                {
                    err: handOffError,
                    userOpHashes: [hash(4), hash(5), hash(6)]
                },
                "onBundle callback threw"
            )

            expect(resubmit).toHaveBeenCalledTimes(1)
            const [[requeued]] = resubmit.mock.calls
            expect(requeued).toMatchObject({
                entryPoint: ENTRY_POINT_V06,
                reason: "bundle_handoff_failed"
            })
            expect(
                requeued.userOps.map((userOpInfo) =>
                    idOf(userOpInfo.userOpHash)
                )
            ).toEqual([4, 5, 6])

            // The accepted bundle keeps its processing records. The refused
            // one's are still here only because resubmitUserOps is stubbed.
            expect(await processingIds(store, ENTRY_POINT_V06)).toEqual([
                1, 2, 3, 4, 5, 6
            ])

            // Bundle 2 took 4 from the carry and carried 7, which went back
            // exactly once.
            expect(storeSpies.addProcessing).toHaveBeenCalledTimes(6)
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            expect(
                storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
            ).toBe(hash(7))
        })

        it("surfaces a failed requeue instead of passing it as handed over", async () => {
            const { mempool, storeSpies } = await harnessSeededWith(
                sevenGasOps()
            )
            const recoveryError = new Error("requeue failed")
            const resubmit = vi
                .spyOn(mempool, "resubmitUserOps")
                .mockRejectedValue(recoveryError)
            const { onBundle } = recordHandOvers(() => {
                throw handOffError
            })

            await expect(mempool.getBundles(undefined, onBundle)).rejects.toBe(
                recoveryError
            )

            expect(onBundle).toHaveBeenCalledTimes(1)
            expect(resubmit).toHaveBeenCalledTimes(1)
            expect(silentLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ err: handOffError }),
                "onBundle callback threw"
            )
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            expect(
                storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
            ).toBe(hash(4))
        })
    })

    it("never calls back for an empty queue", async () => {
        const { mempool } = makeHarness({ config: makeConfig() })
        const { onBundle } = recordHandOvers()

        expect(await mempool.getBundles(undefined, onBundle)).toEqual([])
        expect(onBundle).not.toHaveBeenCalled()
    })

    it("never calls back for a bundle every candidate skipped", async () => {
        const { mempool, store } = await harnessSeededWith(
            [1, 2, 3].map((id) => makeUserOpInfoV06(id))
        )
        withStoreCallBudget(store, 50)
        vi.spyOn(mempool, "shouldSkip").mockImplementation(
            ({
                paymasterDeposit,
                stakedEntityCount,
                knownEntities,
                senders,
                storageMap
            }) =>
                Promise.resolve({
                    skip: true,
                    paymasterDeposit,
                    stakedEntityCount,
                    knownEntities,
                    senders,
                    storageMap
                })
        )
        const { onBundle } = recordHandOvers()

        expect(await mempool.getBundles(undefined, onBundle)).toEqual([])
        expect(onBundle).not.toHaveBeenCalled()
    })

    describe("streaming regressions", () => {
        it("hands bundle 1 over while bundle 2 is still being packed", async () => {
            const { mempool } = await harnessSeededWith(sevenGasOps())
            const secondSetup = deferred()
            const release = deferred()
            hookSetups(mempool, (_, call) => {
                if (call !== 2) {
                    return undefined
                }
                secondSetup.resolve()
                return release.promise
            })
            const { onBundle, ids } = recordHandOvers()

            const pass = mempool.getBundles(undefined, onBundle)
            const isSettled = trackSettled(pass)
            await secondSetup.promise

            expect(ids).toEqual([[1, 2, 3]])
            expect(isSettled()).toBe(false)

            release.resolve()
            const bundles = await pass

            expect(ids).toEqual([[1, 2, 3], [4, 5, 6], [7]])
            expect(onBundle).toHaveBeenCalledTimes(bundles.length)
        })

        it("streams each entry point on its own and still returns them in configured order", async () => {
            const { mempool, store } = await twoEntryPointHarness(
                sevenGasOps(),
                v07Ops(7)
            )
            const release = deferred()
            hookSetups(mempool, (entryPoint, call) =>
                entryPoint === ENTRY_POINT_V06 && call === 1
                    ? release.promise
                    : undefined
            )
            const passFor = capturePasses(mempool)
            const { onBundle, handed } = recordHandOvers()

            const pass = mempool.getBundles(2, onBundle)
            const isSettled = trackSettled(pass)

            // The second configured entry point finishes while the first is
            // held before its first bundle, and its hand-overs come first.
            const v07Bundles = await passFor(ENTRY_POINT_V07)

            expect(isSettled()).toBe(false)
            expect(handed()).toHaveLength(2)
            expect(handed()[0]).toBe(v07Bundles[0])
            expect(handed()[1]).toBe(v07Bundles[1])

            release.resolve()
            const bundles = await pass

            expect(handed().map((bundle) => bundle.entryPoint)).toEqual([
                ENTRY_POINT_V07,
                ENTRY_POINT_V07,
                ENTRY_POINT_V06,
                ENTRY_POINT_V06
            ])
            expect(bundles.map((bundle) => bundle.entryPoint)).toEqual([
                ENTRY_POINT_V06,
                ENTRY_POINT_V06,
                ENTRY_POINT_V07,
                ENTRY_POINT_V07
            ])

            // Identity by bundle, not by index: every returned bundle is one
            // hand-over, and there are no others.
            expect(handed()).toHaveLength(bundles.length)
            for (const bundle of bundles) {
                expect(
                    handed().filter((other) => other === bundle)
                ).toHaveLength(1)
            }

            // The budget of 2 applies to each entry point, not to the pass.
            for (const entryPoint of [ENTRY_POINT_V06, ENTRY_POINT_V07]) {
                expect(
                    bundleIds(
                        bundles.filter(
                            (bundle) => bundle.entryPoint === entryPoint
                        )
                    )
                ).toEqual([
                    [1, 2, 3],
                    [4, 5, 6]
                ])
                expect(await outstandingIds(store, entryPoint)).toEqual([7])
            }
        })

        // The Redis outstanding queue stores JSON and parses it back through
        // userOpInfoSchema (createRedisOutstandingStore.ts), so the record it
        // pops is a fresh object sharing only the hash with the one handed
        // over. The memory queue hands back the very object it was given.
        const serializedCopyOf = (userOpInfo: UserOpInfo): UserOpInfo =>
            userOpInfoSchema.parse(
                JSON.parse(
                    JSON.stringify(userOpInfo, (_, value) =>
                        typeof value === "bigint" ? toHex(value) : value
                    )
                )
            )

        it.each([
            {
                record: "an in-memory record",
                toStored: (userOpInfo: UserOpInfo) => userOpInfo,
                sameObject: true
            },
            {
                record: "a serialized copy",
                toStored: serializedCopyOf,
                sameObject: false
            }
        ])(
            "never hands a hash over twice when $record of it re-enters mid-pass",
            async ({ toStored, sameObject }) => {
                const { mempool, store } = await harnessSeededWith(
                    sevenGasOps()
                )
                let requeued: UserOpInfo | undefined
                let requeue: Promise<void> | undefined
                // Bundle 2's setup waits for the requeue, so the pass cannot
                // reach its next pop before op 1 is back in outstanding.
                hookSetups(mempool, (_, call) =>
                    call === 2 ? requeue : undefined
                )
                const { onBundle, ids } = recordHandOvers((bundle) => {
                    if (requeue) {
                        return
                    }
                    // As its executor would after a failed attempt: out of
                    // processing, back to outstanding, flagged reentered.
                    const [first] = bundle.userOps
                    first.reentered = true
                    const record = toStored(first)
                    requeued = record
                    requeue = (async () => {
                        await store.removeProcessing({
                            entryPoint: ENTRY_POINT_V06,
                            userOpHash: record.userOpHash
                        })
                        await store.addOutstanding({
                            entryPoint: ENTRY_POINT_V06,
                            userOpInfo: record
                        })
                    })()
                })

                const bundles = await mempool.getBundles(undefined, onBundle)

                // Bundle 2 takes the carried op 4, then re-pops op 1, which
                // trips the repeat guard and ends the pass.
                expect(ids).toEqual([[1, 2, 3], [4]])
                expect(bundleIds(bundles)).toEqual(ids)
                expect(ids.flat().filter((id) => id === 1)).toHaveLength(1)

                const outstanding = await store.dumpOutstanding(ENTRY_POINT_V06)
                const stored = outstanding.filter(
                    (userOpInfo) => userOpInfo.userOpHash === hash(1)
                )
                expect(stored).toHaveLength(1)
                expect(stored[0].reentered).toBe(true)
                expect(stored[0] === requeued).toBe(true)
                expect(stored[0] === bundles[0].userOps[0]).toBe(sameObject)
                expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
                    1, 5, 6, 7
                ])
                expect(await processingIds(store, ENTRY_POINT_V06)).toEqual([
                    2, 3, 4
                ])
            }
        )

        it("still hands a same-slot successor back instead of into a second bundle", async () => {
            // One sender, nonces 0-6: the chain pops in nonce order.
            const chain = Array.from({ length: 7 }, (_, i) =>
                makeUserOpInfoV06(i + 1, {
                    sender: senderOf(1),
                    nonce: BigInt(i)
                })
            )
            const { mempool, store, storeSpies } =
                await harnessSeededWith(chain)
            const writesAtHandOver: number[] = []
            const { onBundle, ids } = recordHandOvers(() => {
                writesAtHandOver.push(
                    storeSpies.addOutstanding.mock.calls.length
                )
            })

            const bundles = await mempool.getBundles(undefined, onBundle)

            // Bundle 1 was already handed over when the carried nonce 3 met
            // the guard, and the guard still sent it back and ended the pass.
            expect(ids).toEqual([[1, 2, 3]])
            expect(bundleIds(bundles)).toEqual([[1, 2, 3]])
            expect(writesAtHandOver).toEqual([0])
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            const [[written]] = storeSpies.addOutstanding.mock.calls
            expect(written.userOpInfo.userOpHash).toBe(hash(4))
            expect(written.userOpInfo.reentered).toBe(true)
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
                4, 5, 6, 7
            ])
        })

        it("keeps a handed bundle with its owner when later packing fails", async () => {
            const { mempool, store, storeSpies } = await harnessSeededWith(
                sevenGasOps()
            )
            throwOnSetupCall(mempool, 2, "entities unavailable")
            const resubmit = vi
                .spyOn(mempool, "resubmitUserOps")
                .mockResolvedValue(undefined)
            const { onBundle, ids } = recordHandOvers()

            await expect(
                mempool.getBundles(undefined, onBundle)
            ).rejects.toThrow("entities unavailable")

            // Handed over once and left with its owner: not requeued, not
            // handed over again.
            expect(ids).toEqual([[1, 2, 3]])
            expect(resubmit).not.toHaveBeenCalled()
            expect(await processingIds(store, ENTRY_POINT_V06)).toEqual([
                1, 2, 3
            ])

            // The carried op went back exactly once.
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            expect(
                storeSpies.addOutstanding.mock.calls[0][0].userOpInfo.userOpHash
            ).toBe(hash(4))
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
                4, 5, 6, 7
            ])
        })

        it("lets a held sibling hand over after getBundles rejects, once per bundle", async () => {
            const { mempool, store, storeSpies } = await twoEntryPointHarness(
                sevenGasOps(),
                v07Ops(4)
            )
            const siblingHeld = deferred()
            const release = deferred()
            hookSetups(mempool, (entryPoint, call) => {
                if (entryPoint === ENTRY_POINT_V06 && call === 2) {
                    throw new Error("entities unavailable")
                }
                if (entryPoint === ENTRY_POINT_V07 && call === 1) {
                    siblingHeld.resolve()
                    return release.promise
                }
                return undefined
            })
            const passFor = capturePasses(mempool)
            const resubmit = vi
                .spyOn(mempool, "resubmitUserOps")
                .mockResolvedValue(undefined)
            const { onBundle, handed } = recordHandOvers()

            const unhandled = await collectUnhandledRejections(async () => {
                await expect(
                    mempool.getBundles(undefined, onBundle)
                ).rejects.toThrow("entities unavailable")
                await siblingHeld.promise

                // Only the failed entry point's first bundle so far.
                expect(handed().map((bundle) => bundle.entryPoint)).toEqual([
                    ENTRY_POINT_V06
                ])

                // getBundles has rejected, but the sibling pass was never
                // cancelled: released now, it packs and hands over as usual.
                release.resolve()
                const siblingBundles = await passFor(ENTRY_POINT_V07)

                expect(bundleIds(siblingBundles)).toEqual([[1, 2, 3], [4]])
                expect(handed()).toHaveLength(3)
                expect(handed()[1]).toBe(siblingBundles[0])
                expect(handed()[2]).toBe(siblingBundles[1])
            })

            expect(unhandled).toEqual([])

            // Each op handed over once across both entry points, and none of
            // them requeued: every hand-over kept its owner.
            const handedKeys = handed().flatMap((bundle) =>
                bundle.userOps.map(
                    (userOpInfo) =>
                        `${bundle.entryPoint}:${userOpInfo.userOpHash}`
                )
            )
            expect(new Set(handedKeys).size).toBe(handedKeys.length)
            expect(resubmit).not.toHaveBeenCalled()

            // The failed entry point's carry went back once; the sibling had
            // nothing to write back.
            expect(storeSpies.addOutstanding).toHaveBeenCalledTimes(1)
            const [[written]] = storeSpies.addOutstanding.mock.calls
            expect(written.entryPoint).toBe(ENTRY_POINT_V06)
            expect(written.userOpInfo.userOpHash).toBe(hash(4))
            expect(await outstandingIds(store, ENTRY_POINT_V06)).toEqual([
                4, 5, 6, 7
            ])
            expect(await outstandingIds(store, ENTRY_POINT_V07)).toEqual([])
        })
    })
})

describe("userOpInfoSchema stage stamps", () => {
    // Reproduces the Redis outstanding store's serializer, which is not
    // exported (createRedisOutstandingStore.ts:19-23).
    const serializeUserOpInfo = (userOpInfo: UserOpInfo): string =>
        JSON.stringify(userOpInfo, (_, value) =>
            typeof value === "bigint" ? toHex(value) : value
        )

    it("round-trips bundledAt, dispatchedAt and walletAcquiredAt", () => {
        const userOpInfo: UserOpInfo = {
            ...makeUserOpInfoV06(1),
            processingAt: 1100,
            bundledAt: 1130,
            dispatchedAt: 1190,
            walletAcquiredAt: 1290,
            submittedAt: 1500
        }

        const parsed = userOpInfoSchema.parse(
            JSON.parse(serializeUserOpInfo(userOpInfo))
        )

        expect(parsed.bundledAt).toBe(1130)
        expect(parsed.dispatchedAt).toBe(1190)
        expect(parsed.walletAcquiredAt).toBe(1290)
    })

    it("parses a legacy record without the new stamps, leaving them absent", () => {
        const userOpInfo = makeUserOpInfoV06(1)

        const parsed = userOpInfoSchema.parse(
            JSON.parse(serializeUserOpInfo(userOpInfo))
        )

        expect("bundledAt" in parsed).toBe(false)
        expect("dispatchedAt" in parsed).toBe(false)
        expect("walletAcquiredAt" in parsed).toBe(false)
    })
})

describe("Mempool.resubmitUserOps", () => {
    it("re-adds through add() with processing-stage stamps cleared", async () => {
        const monitor = { setUserOpStatus: vi.fn() } as unknown as Monitor
        const eventManager = {
            emitAddedToMempool: vi.fn()
        } as unknown as EventManager
        const { mempool, store } = makeHarness({
            config: makeConfig(),
            monitor,
            eventManager
        })

        const userOpInfo: UserOpInfo = {
            ...makeUserOpInfoV06(1),
            processingAt: 1100,
            bundledAt: 1130,
            dispatchedAt: 1190,
            walletAcquiredAt: 1290,
            submittedAt: 1500
        }

        await mempool.resubmitUserOps({
            userOps: [userOpInfo],
            entryPoint: ENTRY_POINT_V06,
            reason: "test"
        })

        const [restored] = await store.dumpOutstanding(ENTRY_POINT_V06)

        expect(restored.receivedAt).toBe(900)
        expect(restored.reentered).toBe(true)
        expect("processingAt" in restored).toBe(false)
        expect("bundledAt" in restored).toBe(false)
        expect("dispatchedAt" in restored).toBe(false)
        expect("walletAcquiredAt" in restored).toBe(false)
        expect("submittedAt" in restored).toBe(false)
    })

    // The drop after a refused re-add is launched without await. A rejected
    // drop must be logged rather than escape as an unhandled rejection, which
    // shuts the process down, and must not hold up or fail resubmitUserOps.
    it("logs a failed drop after a refused re-add and still resolves", async () => {
        const { mempool } = makeHarness({ config: makeConfig() })
        vi.spyOn(mempool, "add").mockResolvedValue([false, "re-add refused"])
        const drop = deferred()
        const dropCalls: Parameters<Mempool["dropUserOps"]>[] = []
        // A plain stub, not vi.spyOn: a spy attaches its own handlers to the
        // promise it returns (to record how it settled), which would hide the
        // very unhandled rejection this test is about.
        mempool.dropUserOps = (...args) => {
            dropCalls.push(args)
            return drop.promise
        }
        const dropError = new Error("drop failed")
        const userOpInfo = makeUserOpInfoV06(1)

        const unhandled = await collectUnhandledRejections(async () => {
            const resubmitted = mempool.resubmitUserOps({
                userOps: [userOpInfo],
                entryPoint: ENTRY_POINT_V06,
                reason: "test"
            })
            const isSettled = trackSettled(resubmitted)
            await nextTurn()

            // Settled while the drop is still pending: the drop stays
            // detached, so callers see the same timing as before.
            expect(isSettled()).toBe(true)
            await expect(resubmitted).resolves.toBeUndefined()

            drop.reject(dropError)
        })

        expect(unhandled).toEqual([])
        expect(dropCalls).toEqual([
            [ENTRY_POINT_V06, [{ ...userOpInfo, reason: "re-add refused" }]]
        ])
        expect(silentLogger.error).toHaveBeenCalledWith(
            { err: dropError, userOpHash: hash(1) },
            `failed to drop userOp ${hash(1)} after its re-add was refused`
        )
    })
})
