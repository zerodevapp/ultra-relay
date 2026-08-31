import { beforeEach, describe, expect, test, vi } from "vitest"
import { ExecutorManager } from "./executorManager"

// handleBlockInner needs seven collaborators to construct normally, so build it
// through the prototype and stub only what the dispatch touches. This exercises
// the real method: the point is which RPCs it issues and which branches it
// takes, and that is only observable on the real control flow.
const makeManager = ({
    chainType = "default"
}: { chainType?: string } = {}) => {
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
        config: { chainType },
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        },
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

    // Where fees do not order, no branch downstream reads the network gas
    // price — the viability check compares against the base fee and the bid
    // ignores it — so fetching it is a round trip that buys nothing. The base
    // fee is still required, which is what separates this from the lazy gate.
    test("an arrival-ordered chain skips the gas price but keeps the base fee", async () => {
        const arb = makeManager({ chainType: "arbitrum" })
        arb.getBundleStatuses.mockResolvedValue(notFound)

        await arb.handleBlockInner(true)

        expect(arb.tryGetNetworkGasPrice).not.toHaveBeenCalled()
        expect(arb.getBaseFee).toHaveBeenCalledTimes(1)
        expect(arb.potentiallyResubmitBundle).toHaveBeenCalledTimes(1)
    })

    // The pricing that reaches re-pricing carries no network gas price at
    // all, rather than a zero that a fee comparison would silently act on.
    test("re-pricing is handed arrival-ordered pricing with no network price", async () => {
        const arb = makeManager({ chainType: "arbitrum" })
        arb.getBundleStatuses.mockResolvedValue(notFound)

        await arb.handleBlockInner(true)

        expect(arb.potentiallyResubmitBundle).toHaveBeenCalledWith(
            expect.objectContaining({
                pricing: { policy: "fcfs", networkBaseFee: 1n }
            })
        )
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

// The bundling path, which is where skipping the fetch actually buys latency:
// the three pre-bundle calls race, and the gas price is the slowest of them.
// Driven through the real method so the gate is observed where it runs, not
// where it is declared.
describe("sendBundleToExecutor skips the gas price where fees do not order", () => {
    const makeSender = ({ chainType }: { chainType: string }) => {
        const tryGetNetworkGasPrice = vi.fn().mockResolvedValue({
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n
        })
        const getBaseFee = vi.fn().mockResolvedValue(7n)
        const getTransactionCount = vi.fn().mockResolvedValue(3)
        const bundle = vi.fn().mockResolvedValue({
            success: false,
            reason: "filterops_failed",
            rejectedUserOps: [],
            recoverableOps: []
        })
        const noop = vi.fn()

        const manager = Object.create(ExecutorManager.prototype)
        Object.assign(manager, {
            config: { chainType, publicClient: { getTransactionCount } },
            logger: { info: noop, warn: noop, error: noop, debug: noop },
            senderManager: {
                getWallet: vi.fn().mockResolvedValue({ address: "0xwallet" }),
                markWalletProcessed: vi.fn().mockResolvedValue(undefined)
            },
            gasPriceManager: { tryGetNetworkGasPrice },
            getBaseFee,
            executor: { bundle },
            mempool: {
                resubmitUserOps: vi.fn().mockResolvedValue(undefined),
                dropUserOps: vi.fn().mockResolvedValue(undefined)
            }
        })

        return {
            send: () =>
                manager.sendBundleToExecutor({
                    entryPoint: "0xep",
                    version: "0.7",
                    submissionAttempts: 0,
                    userOps: [{ userOpHash: "0xop" }]
                }),
            tryGetNetworkGasPrice,
            getBaseFee,
            getTransactionCount,
            bundle
        }
    }

    test("arrival-ordered: one fewer RPC call, and the bid still gets built", async () => {
        const m = makeSender({ chainType: "arbitrum" })

        await m.send()

        expect(m.tryGetNetworkGasPrice).not.toHaveBeenCalled()
        expect(m.getBaseFee).toHaveBeenCalledTimes(1)
        expect(m.getTransactionCount).toHaveBeenCalledTimes(1)
        expect(m.bundle).toHaveBeenCalledWith(
            expect.objectContaining({
                pricing: { policy: "fcfs", networkBaseFee: 7n },
                nonce: 3
            })
        )
    })

    test("fee-ordered: the price is still fetched and still reaches the bid", async () => {
        const m = makeSender({ chainType: "default" })

        await m.send()

        expect(m.tryGetNetworkGasPrice).toHaveBeenCalledTimes(1)
        expect(m.bundle).toHaveBeenCalledWith(
            expect.objectContaining({
                pricing: {
                    policy: "priority-fee",
                    networkBaseFee: 7n,
                    networkGasPrice: {
                        maxFeePerGas: 2n,
                        maxPriorityFeePerGas: 1n
                    }
                }
            })
        )
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

    // timeboost is only reachable through an explicit policy — no chainType
    // maps to it — so without this the capability that gates early checks on
    // it is pinned by nothing but an assertion about the table's contents.
    test("on for timeboost, which submit also blocks for", () => {
        expect(
            enabled({
                earlyInclusionChecks: 4,
                chainType: "default",
                orderingPolicy: "timeboost"
            })
        ).toBe(true)
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

// A same-nonce resubmission only replaces anything where the mempool has a
// replacement rule. Driven through the real method so the choice between
// replacing, rotating and waiting is observed where it is made.
describe("recovery respects whether the sequencer has replace-by-fee", () => {
    const makeResubmit = ({
        policy,
        walletCount = 10,
        quarantined = 0
    }: {
        policy: "fcfs" | "pga" | "priority-fee"
        walletCount?: number
        quarantined?: number
    }) => {
        const replaceTransaction = vi.fn()
        const rotateStuckBundle = vi.fn().mockResolvedValue(undefined)
        const stopTrackingBundle = vi.fn()
        const warn = vi.fn()

        const manager = Object.create(ExecutorManager.prototype)
        Object.assign(manager, {
            config: {
                resubmitStuckTimeout: 0,
                maxStuckAttemptsBeforeRotation: 100,
                maxBundlingGasPrice: undefined
            },
            logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
            bundleManager: { stopTrackingBundle },
            senderManager: {
                getAllWallets: () => new Array(walletCount).fill({})
            },
            quarantinedWallets: new Map(
                Array.from({ length: quarantined }, (_, i) => [`0x${i}`, {}])
            ),
            cancelsInFlight: new Set(),
            replaceTransaction,
            rotateStuckBundle
        })

        const pricing =
            policy === "fcfs"
                ? { policy, networkBaseFee: 1n }
                : {
                      policy,
                      networkBaseFee: 1n,
                      networkGasPrice: {
                          maxFeePerGas: 1n,
                          maxPriorityFeePerGas: 1n
                      }
                  }

        return {
            // lastReplaced 0 with a zero stuck timeout makes the bundle stuck.
            run: () =>
                manager.potentiallyResubmitBundle({
                    blockReceivedTimestamp: 1,
                    submittedBundle: {
                        uid: "u",
                        executor: { address: "0xexec" },
                        lastReplaced: 0,
                        transactionRequest: {
                            nonce: 1,
                            maxFeePerGas: 10n,
                            maxPriorityFeePerGas: 10n
                        },
                        bundle: { submissionAttempts: 0 }
                    },
                    pricing
                }),
            replaceTransaction,
            rotateStuckBundle,
            stopTrackingBundle,
            warn
        }
    }

    test.each(["fcfs", "pga"] as const)(
        "%s: recovers onto a fresh nonce instead of resubmitting the old one",
        (policy) => {
            const m = makeResubmit({ policy })

            m.run()

            expect(m.rotateStuckBundle).toHaveBeenCalledTimes(1)
            expect(m.replaceTransaction).not.toHaveBeenCalled()
        }
    )

    // Rotation capped: a second copy of the nonce would only compete with the
    // first for a queue slot, so the bundle waits. It must stay tracked, or the
    // userOps are stranded with nothing scheduled to retry them.
    test("waits rather than duplicating the nonce when rotation is capped", () => {
        const m = makeResubmit({
            policy: "fcfs",
            walletCount: 4,
            quarantined: 2
        })

        m.run()

        expect(m.rotateStuckBundle).not.toHaveBeenCalled()
        expect(m.replaceTransaction).not.toHaveBeenCalled()
        expect(m.stopTrackingBundle).not.toHaveBeenCalled()
        expect(m.warn).toHaveBeenCalled()
    })

    // The mempool path is unchanged: there a resubmission does replace, and
    // rotating on the first sign of trouble would burn a wallet needlessly.
    test("priority-fee still replaces in place", () => {
        const m = makeResubmit({ policy: "priority-fee" })

        m.run()

        expect(m.replaceTransaction).toHaveBeenCalledTimes(1)
        expect(m.rotateStuckBundle).not.toHaveBeenCalled()
    })
})

// A cancel is a same-nonce transaction, so re-broadcasting it can only displace
// the original where a replacement rule exists.
describe("cancelBundle re-broadcasts only where it could win", () => {
    const makeCancel = ({ chainType }: { chainType: string }) => {
        const sendTransaction = vi.fn().mockResolvedValue("0xcancel")
        // Never clears, so the loop runs its full budget of attempts.
        const getTransactionCount = vi.fn().mockResolvedValue(1)

        const manager = Object.create(ExecutorManager.prototype)
        Object.assign(manager, {
            config: {
                chainType,
                cancelTransactionTimeout: 5,
                walletClients: { public: { sendTransaction } },
                publicClient: { getTransactionCount }
            },
            logger: {
                child: () => ({
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: vi.fn(),
                    debug: vi.fn()
                })
            }
        })

        return {
            run: () =>
                manager.cancelBundle({
                    bundle: { userOps: [] },
                    executor: { address: "0xexec" },
                    transactionHash: "0xtx",
                    transactionRequest: {
                        nonce: 1,
                        maxFeePerGas: 100n,
                        maxPriorityFeePerGas: 100n
                    }
                }),
            sendTransaction
        }
    }

    test("arrival-ordered: sent once, then the window is spent polling", async () => {
        const m = makeCancel({ chainType: "arbitrum" })

        await expect(m.run()).resolves.toBe(false)

        expect(m.sendTransaction).toHaveBeenCalledTimes(1)
    })

    test("mempool: re-broadcast each attempt at a strictly rising bid", async () => {
        const m = makeCancel({ chainType: "default" })

        await expect(m.run()).resolves.toBe(false)

        expect(m.sendTransaction.mock.calls.length).toBeGreaterThan(1)
        const bids = m.sendTransaction.mock.calls.map(
            ([tx]) => tx.maxFeePerGas as bigint
        )
        for (let i = 1; i < bids.length; i++) {
            expect(bids[i]).toBeGreaterThan(bids[i - 1])
        }
    })
})

// The early check reuses handleBlock, so it can find the bundle already
// included and run processIncludedBundle — which removes the userOps from the
// submitted store and marks them included. Ordering it before
// markUserOpsAsSubmitted therefore lets a mined userOp be re-added to the
// submitted store with its status regressed, and nothing tracks it afterwards.
// Pinned as call order because that is the whole of the fix.
describe("early inclusion checks start only after the submitted marking", () => {
    const runSubmit = async ({ enabled }: { enabled: boolean }) => {
        const order: string[] = []
        const transactionHash = "0xtx"

        const manager = Object.create(ExecutorManager.prototype)
        Object.assign(manager, {
            config: { chainType: "arbitrum", publicClient: {} },
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn()
            },
            senderManager: {
                getWallet: vi.fn().mockResolvedValue({ address: "0xwallet" }),
                markWalletProcessed: vi.fn().mockResolvedValue(undefined)
            },
            bundleManager: { trackBundle: vi.fn() },
            mempool: {
                markUserOpsAsSubmitted: vi.fn(async () => {
                    order.push("markSubmitted")
                }),
                dropUserOps: vi.fn().mockResolvedValue(undefined),
                resubmitUserOps: vi.fn().mockResolvedValue(undefined)
            },
            metrics: {
                bundlesSubmitted: { labels: () => ({ inc: vi.fn() }) },
                userOpsSubmitted: { labels: () => ({ inc: vi.fn() }) }
            },
            executor: {
                bundle: vi.fn().mockResolvedValue({
                    success: true,
                    userOpsBundled: [
                        { userOpHash: "0xop", submissionAttempts: 0 }
                    ],
                    rejectedUserOps: [],
                    transactionRequest: { nonce: 1 },
                    transactionHash
                })
            },
            resolveBundlePricing: vi
                .fn()
                .mockResolvedValue({ policy: "fcfs", networkBaseFee: 1n }),
            startWatchingBlocks: vi.fn(),
            earlyInclusionChecksEnabled: () => enabled,
            runEarlyInclusionChecks: vi.fn(async () => {
                order.push("earlyCheck")
            })
        })
        Object.assign(manager.config, {
            publicClient: { getTransactionCount: vi.fn().mockResolvedValue(3) }
        })

        await manager.sendBundleToExecutor({
            entryPoint: "0xep",
            version: "0.7",
            submissionAttempts: 0,
            userOps: [{ userOpHash: "0xop", submissionAttempts: 0 }]
        })

        return order
    }

    test("the submitted marking completes first", async () => {
        await expect(runSubmit({ enabled: true })).resolves.toEqual([
            "markSubmitted",
            "earlyCheck"
        ])
    })

    test("and where the check is disabled, nothing runs it", async () => {
        await expect(runSubmit({ enabled: false })).resolves.toEqual([
            "markSubmitted"
        ])
    })
})
