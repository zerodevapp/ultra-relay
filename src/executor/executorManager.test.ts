import { beforeEach, describe, expect, test, vi } from "vitest"
import { ExecutorManager } from "./executorManager"

// handleBlockInner needs seven collaborators to construct normally, so build it
// through the prototype and stub only what the dispatch touches. This exercises
// the real method: the point is which RPCs it issues and which branches it
// takes, and that is only observable on the real control flow.
const makeManager = () => {
    const tryGetNetworkGasPrice = vi.fn().mockResolvedValue({
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n
    })
    const getBaseFee = vi.fn().mockResolvedValue(1n)
    const getBundleStatuses = vi.fn()
    const processIncludedBundle = vi.fn().mockResolvedValue(undefined)
    const potentiallyResubmitBundle = vi.fn()

    const bundles = [
        { uid: "uid-1", transactionHash: "0xtx", bundle: { userOps: [] } }
    ]

    const manager = Object.create(ExecutorManager.prototype) as ExecutorManager
    Object.assign(manager, {
        currentlyHandlingBlock: false,
        bundleManager: {
            getPendingBundles: () => bundles,
            getBundleStatuses,
            processIncludedBundle,
            processRevertedBundle: vi.fn().mockResolvedValue(undefined)
        },
        gasPriceManager: { tryGetNetworkGasPrice },
        getBaseFee,
        potentiallyResubmitBundle,
        stopWatchingBlocks: vi.fn(),
        updateTransactionCostMetrics: vi.fn().mockResolvedValue(undefined)
    })

    // biome-ignore lint/suspicious/noExplicitAny: reaching a private method
    const handleBlockInner = (repriceStuckBundles?: boolean) =>
        (manager as any).handleBlockInner(undefined, repriceStuckBundles)

    return {
        handleBlockInner,
        getBundleStatuses,
        tryGetNetworkGasPrice,
        getBaseFee,
        processIncludedBundle,
        potentiallyResubmitBundle
    }
}

const notFound = [{ status: "not_found" }]
const included = [
    {
        status: "included",
        transactionHash: "0xtx",
        blockNumber: 1n,
        userOpReceipts: {}
    }
]

describe("handleBlockInner pricing is lazy", () => {
    let m: ReturnType<typeof makeManager>
    beforeEach(() => {
        m = makeManager()
    })

    test("an included bundle costs no gas price or base fee fetch", async () => {
        m.getBundleStatuses.mockResolvedValue(included)

        await m.handleBlockInner()

        expect(m.processIncludedBundle).toHaveBeenCalledTimes(1)
        expect(m.tryGetNetworkGasPrice).not.toHaveBeenCalled()
        expect(m.getBaseFee).not.toHaveBeenCalled()
    })

    test("a watcher tick finding not_found does fetch pricing and re-price", async () => {
        m.getBundleStatuses.mockResolvedValue(notFound)

        await m.handleBlockInner(true)

        expect(m.tryGetNetworkGasPrice).toHaveBeenCalledTimes(1)
        expect(m.getBaseFee).toHaveBeenCalledTimes(1)
        expect(m.potentiallyResubmitBundle).toHaveBeenCalledTimes(1)
    })
})

describe("early inclusion checks stay cheap and never re-price", () => {
    let m: ReturnType<typeof makeManager>
    beforeEach(() => {
        m = makeManager()
    })

    // The regression this pins: a freshly submitted bundle whose receipt has
    // not propagated reports not_found, so an early check that did not opt out
    // of re-pricing would fetch a gas price and base fee on every miss —
    // four RPC calls instead of one, and most expensive under exactly the read
    // lag the retries exist for.
    test("a missed early check fetches no pricing", async () => {
        m.getBundleStatuses.mockResolvedValue(notFound)

        await m.handleBlockInner(false)

        expect(m.getBundleStatuses).toHaveBeenCalledTimes(1)
        expect(m.tryGetNetworkGasPrice).not.toHaveBeenCalled()
        expect(m.getBaseFee).not.toHaveBeenCalled()
    })

    // And the safety half: the early check must not be able to resubmit the
    // transaction it has just sent.
    test("a missed early check never routes into re-pricing", async () => {
        m.getBundleStatuses.mockResolvedValue(notFound)

        await m.handleBlockInner(false)

        expect(m.potentiallyResubmitBundle).not.toHaveBeenCalled()
    })

    test("a hit still processes the inclusion", async () => {
        m.getBundleStatuses.mockResolvedValue(included)

        await m.handleBlockInner(false)

        expect(m.processIncludedBundle).toHaveBeenCalledTimes(1)
        expect(m.potentiallyResubmitBundle).not.toHaveBeenCalled()
    })
})

describe("earlyInclusionChecksEnabled", () => {
    const enabled = (config: Record<string, unknown>) => {
        const manager = Object.create(ExecutorManager.prototype)
        Object.assign(manager, { config })
        // biome-ignore lint/suspicious/noExplicitAny: reaching a private method
        return (manager as any).earlyInclusionChecksEnabled()
    }

    test("0 attempts disables it", () => {
        expect(
            enabled({ earlyInclusionChecks: 0, chainType: "arbitrum" })
        ).toBe(false)
    })

    test("on where submitting blocks until sequenced", () => {
        expect(
            enabled({ earlyInclusionChecks: 4, chainType: "arbitrum" })
        ).toBe(true)
    })

    test("off on mempool chains — the receipt cannot exist yet", () => {
        // Gating on the wrong capability would flip this: priority-fee has
        // feesAffectOrdering true but submitBlocksUntilSequenced false.
        expect(enabled({ earlyInclusionChecks: 4, chainType: "default" })).toBe(
            false
        )
    })

    test("an explicit policy overrides the chainType default", () => {
        expect(
            enabled({
                earlyInclusionChecks: 4,
                chainType: "default",
                orderingPolicy: "pga"
            })
        ).toBe(true)
    })
})

describe("runEarlyInclusionChecks", () => {
    const make = ({
        pending = [true, true, true, true],
        attempts = 4
    }: { pending?: boolean[]; attempts?: number } = {}) => {
        const handleBlock = vi.fn().mockResolvedValue(undefined)
        let call = 0
        const manager = Object.create(ExecutorManager.prototype)
        Object.assign(manager, {
            config: {
                earlyInclusionChecks: attempts,
                earlyInclusionCheckInterval: 0
            },
            bundleManager: {
                isBundlePending: vi.fn(() => pending[call++] ?? false)
            },
            handleBlock
        })
        return {
            // biome-ignore lint/suspicious/noExplicitAny: reaching a private method
            run: () => (manager as any).runEarlyInclusionChecks({ uid: "u" }),
            handleBlock
        }
    }

    // The regression, pinned at the call site rather than one level below it:
    // the early check must tell handleBlock not to re-price, or a
    // not-yet-propagated receipt turns every miss into a pricing fetch and can
    // resubmit a transaction that was just sent.
    test("every check suppresses re-pricing", async () => {
        const { run, handleBlock } = make()

        await run()

        expect(handleBlock).toHaveBeenCalled()
        for (const [, options] of handleBlock.mock.calls) {
            expect(options).toEqual({ repriceStuckBundles: false })
        }
    })

    test("stops as soon as the bundle is no longer pending", async () => {
        const { run, handleBlock } = make({ pending: [true, false] })

        await run()

        expect(handleBlock).toHaveBeenCalledTimes(1)
    })

    test("runs the configured number of attempts while still pending", async () => {
        const { run, handleBlock } = make({ attempts: 3 })

        await run()

        expect(handleBlock).toHaveBeenCalledTimes(3)
    })
})
