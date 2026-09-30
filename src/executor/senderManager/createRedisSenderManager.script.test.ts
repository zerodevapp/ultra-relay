import { randomUUID } from "node:crypto"
import { type AddressInfo, type Socket, connect, createServer } from "node:net"
import { Redis } from "ioredis"
import { type Account, type Hex, getAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SenderManager } from "."
import { getRedisKeys } from "../../cli/config/redisKeys"
import { releaseWalletsOnShutdown } from "../../cli/shutDown"
import type { AltoConfig } from "../../createConfig"
import { createRedisSenderManager } from "./createRedisSenderManager"

// Importing cli/shutDown reaches utils/logger, which builds a Logtail
// transport at module load when BETTER_STACK_TOKEN is set; see
// executorManager.test.ts.
vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

// Contract tests for the Redis sender manager's pool scripts against a real
// Redis: Lua and multi-client interleavings cannot be faked. REDIS_URL must
// name a disposable server: one test runs SCRIPT FLUSH, which clears every
// script on the server. Tests in this file run sequentially.

const CHAIN_ID = 42161

// Deterministic keys; viem derives checksummed addresses from them.
const ACCOUNTS: Account[] = Array.from({ length: 20 }, (_, i) =>
    privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex)
)

const lower = (address: string) => address.toLowerCase()

const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))

const redisUrl = (): string => {
    const url = process.env.REDIS_URL
    if (!url) {
        throw new Error("REDIS_URL is not set")
    }
    return url
}

const makeLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn()
})

const makeMetrics = () => ({
    walletsTotal: { set: vi.fn() },
    walletsAvailable: { set: vi.fn() }
})

type Cut = "before-execution" | "after-execution"

// Sits between one manager's client and Redis so a test can cut the
// connection around the next command: before Redis receives it, or after
// Redis ran it but before its reply gets back.
const startFaultProxy = async (target: string) => {
    const upstreamUrl = new URL(target)
    const sockets = new Set<Socket>()
    const sentAfterCut: string[] = []
    let nextCut: Cut | undefined
    let awaitingReply = false
    let cutDone = false
    let down = false

    const server = createServer((client) => {
        if (down) {
            client.destroy()
            return
        }
        const upstream = connect(
            Number(upstreamUrl.port || 6379),
            upstreamUrl.hostname
        )
        const cut = () => {
            client.destroy()
            upstream.destroy()
        }
        client.on("data", (chunk: Buffer) => {
            if (cutDone) sentAfterCut.push(chunk.toString())
            if (nextCut === "before-execution") {
                nextCut = undefined
                cutDone = true
                cut()
                return
            }
            if (nextCut === "after-execution") {
                nextCut = undefined
                awaitingReply = true
            }
            upstream.write(chunk)
        })
        upstream.on("data", (chunk: Buffer) => {
            if (awaitingReply) {
                awaitingReply = false
                cutDone = true
                cut()
                return
            }
            client.write(chunk)
        })
        for (const socket of [client, upstream]) {
            sockets.add(socket)
            socket.on("error", () => {})
            socket.on("close", () => {
                sockets.delete(socket)
                cut()
            })
        }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const proxied = new URL(target)
    proxied.hostname = "127.0.0.1"
    proxied.port = String((server.address() as AddressInfo).port)

    return {
        url: proxied.toString(),
        cutNext: (cut: Cut) => {
            nextCut = cut
            cutDone = false
            sentAfterCut.length = 0
        },
        // Everything the client sent after the cut; a replayed take or
        // return shows up here as an eval command.
        sentAfterCut: () => sentAfterCut.join(""),
        setDown: (value: boolean) => {
            down = value
            if (value) {
                for (const socket of sockets) socket.destroy()
            }
        },
        close: () =>
            new Promise<void>((resolve) => {
                down = true
                for (const socket of sockets) socket.destroy()
                server.close(() => resolve())
            })
    }
}

type Pod = {
    manager: SenderManager
    // The manager's private client: observed for its commands and used to
    // run its scripts directly, as its periodic sync does.
    client: Redis
    logger: ReturnType<typeof makeLogger>
    metrics: ReturnType<typeof makeMetrics>
}

describe.skipIf(!process.env.REDIS_URL)(
    "createRedisSenderManager against a real Redis",
    () => {
        let inspect: Redis
        let redisKeyPrefix: string
        let keys: { pool: string; inUse: string; armed: string }
        let managerClients: Set<Redis>
        // Every connect, including ioredis' own reconnect attempts.
        let connectCalls: number
        let tracked: Promise<unknown>[]

        // Registers a promise the test leaves running; cleanup waits for it
        // after closing the clients, which makes it settle.
        const track = <T>(promise: Promise<T>): Promise<T> => {
            tracked.push(promise.catch(() => undefined))
            return promise
        }

        beforeEach(async () => {
            tracked = []
            connectCalls = 0
            inspect = new Redis(redisUrl())
            await inspect.ping()
            redisKeyPrefix = `sender-manager-test-${randomUUID()}`
            const redisKeys = getRedisKeys({
                redisKeyPrefix,
                chainId: CHAIN_ID
            } as AltoConfig)
            keys = {
                pool: redisKeys.senderManagerQueue,
                inUse: redisKeys.senderManagerInUse,
                armed: redisKeys.senderManagerArmed
            }
            // Installed after inspect exists, so only manager clients are
            // recorded. Test instrumentation only; the manager exposes none.
            managerClients = new Set()
            const connect = Redis.prototype.connect
            vi.spyOn(Redis.prototype, "connect").mockImplementation(function (
                this: Redis,
                callback
            ) {
                connectCalls++
                managerClients.add(this)
                return connect.call(this, callback)
            })
        })

        afterEach(async () => {
            vi.restoreAllMocks()
            try {
                // Closing the clients makes pending takes and worker loops
                // reject; wait for them before touching the keys.
                for (const client of managerClients) {
                    client.disconnect()
                }
                await Promise.all(tracked)
                await inspect.del(keys.pool, keys.inUse, keys.armed)
            } finally {
                inspect.disconnect()
            }
        })

        const waitFor = async (condition: () => boolean, what: string) => {
            const deadline = Date.now() + 5000
            while (!condition()) {
                if (Date.now() > deadline) {
                    throw new Error(`timed out waiting for ${what}`)
                }
                await sleep(10)
            }
        }

        const arm = () => inspect.set(keys.armed, "test")

        const startPod = async (
            accounts: Account[],
            {
                maxExecutors,
                redisEndpoint = redisUrl()
            }: { maxExecutors?: number; redisEndpoint?: string } = {}
        ): Promise<Pod> => {
            const known = new Set(managerClients)
            const logger = makeLogger()
            const metrics = makeMetrics()
            const config = {
                chainId: CHAIN_ID,
                redisKeyPrefix,
                executorPrivateKeys: accounts,
                maxExecutors,
                getLogger: () => logger
            } as unknown as AltoConfig
            const manager = await createRedisSenderManager({
                config,
                metrics: metrics as never,
                redisEndpoint
            })
            // The manager's client connects before its first await, so the
            // first client this call added is its own.
            const client = [...managerClients].find((c) => !known.has(c))
            if (!client) {
                throw new Error("the manager created no client")
            }
            return { manager, client, logger, metrics }
        }

        // Atomic view of the pool; in-use sorted for comparisons.
        const snapshot = async () => {
            const replies = await inspect
                .multi()
                .lrange(keys.pool, 0, -1)
                .smembers(keys.inUse)
                .exec()
            if (!replies) {
                throw new Error("snapshot transaction aborted")
            }
            const [[listError, list], [setError, inUse]] = replies
            if (listError || setError) {
                throw listError ?? setError
            }
            return {
                list: list as string[],
                inUse: [...(inUse as string[])].sort()
            }
        }

        // The pod's periodic sync, run now on its own connection.
        const reconcile = (pod: Pod, accounts: Account[]) =>
            pod.client.reconcileWallets(
                keys.pool,
                keys.inUse,
                keys.armed,
                ...accounts.map((a) => a.address)
            )

        const addresses = (accounts: Account[]) =>
            accounts.map((a) => a.address)
        const lowered = (accounts: Account[]) =>
            accounts.map((a) => lower(a.address)).sort()
        const dumpKeys = () =>
            Promise.all(
                [keys.pool, keys.inUse, keys.armed].map((key) =>
                    inspect.dump(key)
                )
            )
        const isChecksummed = (entries: string[]) =>
            entries.every((entry) => entry === getAddress(entry))

        it("T1: seeds an empty armed pool with every eligible wallet", async () => {
            await arm()

            const pod = await startPod(ACCOUNTS)

            expect(pod.logger.info).toHaveBeenCalledWith(
                {
                    added: addresses(ACCOUNTS),
                    addedCount: 20,
                    poolSize: 20,
                    inUseCount: 0,
                    foreignCount: 0
                },
                "reconciled executor wallet pool"
            )
            const { list, inUse } = await snapshot()
            expect([...list].sort()).toEqual([...addresses(ACCOUNTS)].sort())
            expect(isChecksummed(list)).toBe(true)
            expect(inUse).toEqual([])
        })

        it("T2: adds exactly the missing wallets to a pool seeded the old way", async () => {
            await arm()
            await inspect.rpush(keys.pool, ...addresses(ACCOUNTS.slice(0, 10)))

            const pod = await startPod(ACCOUNTS)

            expect(pod.logger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    added: addresses(ACCOUNTS.slice(10)),
                    addedCount: 10,
                    poolSize: 20
                }),
                "reconciled executor wallet pool"
            )
            const { list } = await snapshot()
            expect(list).toHaveLength(20)
            expect(new Set(list.map(lower)).size).toBe(20)
        })

        it("T3: five pods starting together add each wallet once", async () => {
            await arm()

            await Promise.all(
                Array.from({ length: 5 }, () => startPod(ACCOUNTS))
            )

            const { list } = await snapshot()
            expect(list).toHaveLength(20)
            expect(new Set(list.map(lower)).size).toBe(20)
        })

        it("T4: a starting pod and periodic syncs add nothing while wallets are held", async () => {
            await arm()
            const a = await startPod(ACCOUNTS)
            const held = [
                await a.manager.getWallet(),
                await a.manager.getWallet(),
                await a.manager.getWallet()
            ]

            const b = await startPod(ACCOUNTS)

            expect(b.logger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    addedCount: 0,
                    poolSize: 17,
                    inUseCount: 3
                }),
                "reconciled executor wallet pool"
            )
            expect((await reconcile(a, ACCOUNTS))[1]).toEqual([])
            expect((await reconcile(b, ACCOUNTS))[1]).toEqual([])
            for (const wallet of held) {
                await a.manager.markWalletProcessed(wallet)
            }
            const { list, inUse } = await snapshot()
            expect(list).toHaveLength(20)
            expect(inUse).toEqual([])
        })

        it("T5: takes only its own wallets and leaves foreign ones in order", async () => {
            await arm()
            const own = ACCOUNTS.slice(0, 10)
            const foreign = ACCOUNTS.slice(10)
            // Interleaved, as two pods' seeds and returns would leave them.
            await inspect.rpush(
                keys.pool,
                ...own.flatMap((account, i) => [
                    account.address,
                    foreign[i].address
                ])
            )
            const a = await startPod(own)

            const taken: Account[] = []
            for (let i = 0; i < 10; i++) {
                taken.push(await a.manager.getWallet())
            }
            expect(taken.map((w) => lower(w.address)).sort()).toEqual(
                lowered(own)
            )
            const foreignOrder = (await snapshot()).list
            expect(foreignOrder.map(lower).sort()).toEqual(lowered(foreign))

            const sendCommand = vi.spyOn(a.client, "sendCommand")
            let settled = false
            const eleventh = track(
                a.manager.getWallet().finally(() => {
                    settled = true
                })
            )
            // Several empty polls, still waiting. The 100ms spacing itself is
            // checked with fake timers in createRedisSenderManager.test.ts.
            await waitFor(
                () => sendCommand.mock.calls.length >= 3,
                "three empty polls"
            )
            expect(settled).toBe(false)
            expect((await snapshot()).list).toEqual(foreignOrder)

            await a.manager.markWalletProcessed(taken[0])
            expect(lower((await eleventh).address)).toBe(
                lower(taken[0].address)
            )
        })

        it("T6: drops a stray copy of a held wallet instead of handing it out", async () => {
            await arm()
            const accounts = ACCOUNTS.slice(0, 2)
            const a = await startPod(accounts)
            const first = await a.manager.getWallet()
            await inspect.rpush(keys.pool, first.address)

            const second = await a.manager.getWallet()

            expect(lower(second.address)).not.toBe(lower(first.address))
            const { list, inUse } = await snapshot()
            expect(list).toEqual([])
            expect(inUse).toEqual(lowered(accounts))
        })

        it("T7: takes a lowercase entry and returns it checksummed", async () => {
            await arm()
            const [account] = ACCOUNTS
            await inspect.rpush(keys.pool, lower(account.address))
            const a = await startPod([account])

            const wallet = await a.manager.getWallet()

            expect(wallet.address).toBe(account.address)
            expect(wallet).not.toBe(account)
            await a.manager.markWalletProcessed(wallet)
            expect((await snapshot()).list).toEqual([account.address])
        })

        it("T8: one command per successful take and per return", async () => {
            await arm()
            const a = await startPod(ACCOUNTS.slice(0, 2))
            // Load the take and return scripts into Redis' cache.
            await a.manager.markWalletProcessed(await a.manager.getWallet())
            const sendCommand = vi.spyOn(a.client, "sendCommand")

            const wallet = await a.manager.getWallet()
            expect(
                sendCommand.mock.calls.map(([command]) => command.name)
            ).toEqual(["evalsha"])

            sendCommand.mockClear()
            await a.manager.markWalletProcessed(wallet)
            expect(
                sendCommand.mock.calls.map(([command]) => command.name)
            ).toEqual(["evalsha"])
            // The gauge came from the return's reply, not a separate read.
            expect(a.metrics.walletsAvailable.set).toHaveBeenLastCalledWith(2)
        })

        it("T9: still takes a wallet after the script cache is flushed", async () => {
            await arm()
            const a = await startPod(ACCOUNTS.slice(0, 1))
            // ioredis sends a script's first call on a connection as a full
            // eval; after this warm-up the next take goes out as evalsha.
            await a.manager.markWalletProcessed(await a.manager.getWallet())
            await inspect.script("FLUSH")
            const sendCommand = vi.spyOn(a.client, "sendCommand")

            const wallet = await a.manager.getWallet()

            expect(wallet.address).toBe(ACCOUNTS[0].address)
            // evalsha fails with NOSCRIPT (nothing ran), then eval.
            expect(
                sendCommand.mock.calls.map(([command]) => command.name)
            ).toEqual(["evalsha", "eval"])
        })

        it(
            "T10: never lets two workers hold one wallet",
            { timeout: 60_000 },
            async () => {
                await arm()
                const pods = await Promise.all([
                    startPod(ACCOUNTS),
                    startPod(ACCOUNTS),
                    startPod(ACCOUNTS)
                ])
                const holders = new Set<string>()
                let overlaps = 0
                const worker = async (pod: Pod) => {
                    for (let cycle = 0; cycle < 34; cycle++) {
                        const wallet = await pod.manager.getWallet()
                        const address = lower(wallet.address)
                        if (holders.has(address)) overlaps++
                        holders.add(address)
                        await sleep(Math.floor(Math.random() * 6))
                        holders.delete(address)
                        await pod.manager.markWalletProcessed(wallet)
                    }
                }

                // Tracked, so a failing worker's siblings are stopped by cleanup.
                await Promise.all(
                    pods.flatMap((pod) =>
                        Array.from({ length: 12 }, () => track(worker(pod)))
                    )
                )

                expect(overlaps).toBe(0)
                const { list, inUse } = await snapshot()
                expect(list.map(lower).sort()).toEqual(lowered(ACCOUNTS))
                expect(isChecksummed(list)).toBe(true)
                expect(inUse).toEqual([])
            }
        )

        it("T12: counts a duplicated key once and ignores keys past maxExecutors", async () => {
            await arm()
            const [first, second] = ACCOUNTS

            const pod = await startPod([first, first, second], {
                maxExecutors: 2
            })

            expect(pod.manager.getAllWallets()).toHaveLength(1)
            expect(pod.metrics.walletsTotal.set).toHaveBeenCalledWith(1)
            expect((await snapshot()).list).toEqual([first.address])
        })

        it("T13: keeps every entry checksummed across take/return cycles", async () => {
            await arm()
            const accounts = ACCOUNTS.slice(0, 5)
            // Entries as today's code seeds them.
            await inspect.rpush(keys.pool, ...addresses(accounts.slice(0, 3)))
            const a = await startPod(accounts)

            for (let cycle = 0; cycle < 40; cycle++) {
                await a.manager.markWalletProcessed(await a.manager.getWallet())
            }

            const { list } = await snapshot()
            expect(list.map(lower).sort()).toEqual(lowered(accounts))
            expect(isChecksummed(list)).toBe(true)
        })

        it("T14: ends with every wallet idle once all checkouts return", async () => {
            await arm()
            const a = await startPod(ACCOUNTS)
            const held = await Promise.all(
                Array.from({ length: 8 }, () => a.manager.getWallet())
            )

            await Promise.all(
                held.map((wallet) => a.manager.markWalletProcessed(wallet))
            )

            expect(a.manager.getActiveWallets()).toEqual([])
            const { list, inUse } = await snapshot()
            expect(list.map(lower).sort()).toEqual(lowered(ACCOUNTS))
            expect(inUse).toEqual([])
        })

        it("T15: a stale or repeated release sends nothing", async () => {
            await arm()
            const [account] = ACCOUNTS
            const a = await startPod([account])
            const old = await a.manager.getWallet()
            await a.manager.markWalletProcessed(old)
            const current = await a.manager.getWallet()
            expect(current).not.toBe(old)
            expect(current.address).toBe(old.address)
            const sendCommand = vi.spyOn(a.client, "sendCommand")

            await a.manager.markWalletProcessed(old)

            expect(sendCommand).not.toHaveBeenCalled()
            expect(a.logger.warn).toHaveBeenCalledWith(
                { executor: account.address },
                "Attempted to mark a wallet as processed that wasn't active"
            )
            expect((await snapshot()).inUse).toEqual([lower(account.address)])

            await Promise.all([
                a.manager.markWalletProcessed(current),
                a.manager.markWalletProcessed(current)
            ])
            expect(sendCommand).toHaveBeenCalledTimes(1)
            expect((await snapshot()).list).toEqual([account.address])
        })

        it("T16: only a checkout handle releases a wallet", async () => {
            await arm()
            const [account, other] = ACCOUNTS
            const a = await startPod([account])
            await a.manager.getWallet()
            const sendCommand = vi.spyOn(a.client, "sendCommand")

            await a.manager.markWalletProcessed(a.manager.getAllWallets()[0])
            await a.manager.markWalletProcessed({ ...account })

            expect(sendCommand).not.toHaveBeenCalled()
            expect(a.logger.warn).toHaveBeenCalledTimes(2)
            expect((await snapshot()).inUse).toEqual([lower(account.address)])

            // The script itself refuses an address with no reservation.
            sendCommand.mockRestore()
            expect(
                await a.client.returnWallet(
                    keys.pool,
                    keys.inUse,
                    other.address
                )
            ).toEqual([0, 0])
            expect((await snapshot()).list).toEqual([])
        })

        it("T18a: startup fails on any wrongly typed key, writes nothing and closes its client", async () => {
            const corruptions = [
                () => inspect.set(keys.pool, "x"),
                () => inspect.set(keys.inUse, "x"),
                () => inspect.rpush(keys.armed, "x")
            ]
            for (const corrupt of corruptions) {
                await inspect.del(keys.pool, keys.inUse, keys.armed)
                await corrupt()
                if ((await inspect.type(keys.armed)) === "none") {
                    await arm()
                }
                const before = await dumpKeys()

                await expect(startPod([ACCOUNTS[0]])).rejects.toThrow(
                    /WRONGTYPE/
                )

                expect(await dumpKeys()).toEqual(before)
            }
            await sleep(50)
            expect([...managerClients].map((client) => client.status)).toEqual([
                "end",
                "end",
                "end"
            ])
        })

        it("T18b: a take or return on a wrongly typed key rejects without writing", async () => {
            await arm()
            const accounts = ACCOUNTS.slice(0, 3)
            const a = await startPod(accounts)
            const first = await a.manager.getWallet()
            const second = await a.manager.getWallet()
            const [idle] = accounts.filter(
                (account) =>
                    account.address !== first.address &&
                    account.address !== second.address
            )
            // One idle wallet in the pool, both handles reserved.
            const reset = async () => {
                await inspect.del(keys.pool, keys.inUse)
                await inspect.rpush(keys.pool, idle.address)
                await inspect.sadd(
                    keys.inUse,
                    lower(first.address),
                    lower(second.address)
                )
            }
            const corrupt = async (key: string) => {
                await inspect.del(key)
                await inspect.set(key, "x")
            }

            // Take, wrongly typed set: rejects instead of polling; pool untouched.
            await reset()
            await corrupt(keys.inUse)
            await expect(a.manager.getWallet()).rejects.toThrow(/WRONGTYPE/)
            expect(await inspect.lrange(keys.pool, 0, -1)).toEqual([
                idle.address
            ])

            // The same on an empty pool.
            await inspect.del(keys.pool)
            await expect(a.manager.getWallet()).rejects.toThrow(/WRONGTYPE/)

            // Take, wrongly typed pool: rejects; set untouched.
            await reset()
            await corrupt(keys.pool)
            await expect(a.manager.getWallet()).rejects.toThrow(/WRONGTYPE/)
            expect((await inspect.smembers(keys.inUse)).sort()).toEqual(
                lowered([first, second])
            )

            // Return, wrongly typed set: rejects; pool untouched.
            await reset()
            await corrupt(keys.inUse)
            await expect(a.manager.markWalletProcessed(first)).rejects.toThrow(
                /WRONGTYPE/
            )
            expect(await inspect.lrange(keys.pool, 0, -1)).toEqual([
                idle.address
            ])

            // Return, wrongly typed pool: rejects; set untouched.
            await reset()
            await corrupt(keys.pool)
            await expect(a.manager.markWalletProcessed(second)).rejects.toThrow(
                /WRONGTYPE/
            )
            expect((await inspect.smembers(keys.inUse)).sort()).toEqual(
                lowered([first, second])
            )

            expect(
                a.logger.error.mock.calls.map(([fields, message]) => [
                    fields.executor,
                    message
                ])
            ).toEqual([
                [
                    first.address,
                    "wallet return failed; reservation requires inspection"
                ],
                [
                    second.address,
                    "wallet return failed; reservation requires inspection"
                ]
            ])
        })

        it(
            "T19: syncs and startups racing busy pods add nothing and overlap nothing",
            { timeout: 60_000 },
            async () => {
                await arm()
                const busy = [
                    await startPod(ACCOUNTS),
                    await startPod(ACCOUNTS)
                ]
                const others = [
                    await startPod(ACCOUNTS),
                    await startPod(ACCOUNTS),
                    await startPod(ACCOUNTS)
                ]
                const holders = new Set<string>()
                const problems: string[] = []
                let overlaps = 0
                let added = 0
                let running = true

                const worker = async (pod: Pod) => {
                    while (running) {
                        const wallet = await pod.manager.getWallet()
                        const address = lower(wallet.address)
                        if (holders.has(address)) overlaps++
                        holders.add(address)
                        await sleep(Math.floor(Math.random() * 3))
                        holders.delete(address)
                        await pod.manager.markWalletProcessed(wallet)
                    }
                }
                const reconciler = async (pod: Pod) => {
                    for (let i = 0; i < 300; i++) {
                        const [, addedNow] = await reconcile(pod, ACCOUNTS)
                        added += addedNow.length
                    }
                }
                // Every eligible address is in exactly one place at every instant.
                const auditor = async () => {
                    while (running) {
                        const { list, inUse } = await snapshot()
                        const all = [...list.map(lower), ...inUse]
                        if (all.length !== 20 || new Set(all).size !== 20) {
                            problems.push(JSON.stringify({ list, inUse }))
                        }
                        await sleep(5)
                    }
                }

                const workers = busy.flatMap((pod) =>
                    Array.from({ length: 10 }, () => track(worker(pod)))
                )
                const audit = track(auditor())
                let late: Pod[]
                try {
                    // The busy pods' own syncs run alongside other pods' syncs
                    // and startups.
                    const [, startedLate] = await Promise.all([
                        Promise.all([...busy, ...others].map(reconciler)),
                        Promise.all([startPod(ACCOUNTS), startPod(ACCOUNTS)])
                    ])
                    late = startedLate
                } finally {
                    running = false
                }
                await Promise.all([...workers, audit])

                expect({ added, overlaps, problems }).toEqual({
                    added: 0,
                    overlaps: 0,
                    problems: []
                })
                for (const pod of late) {
                    expect(pod.logger.info).toHaveBeenCalledWith(
                        expect.objectContaining({ addedCount: 0 }),
                        "reconciled executor wallet pool"
                    )
                }
                const { list, inUse } = await snapshot()
                expect(list.map(lower).sort()).toEqual(lowered(ACCOUNTS))
                expect(inUse).toEqual([])
            }
        )

        it("T20: refuses to start with no eligible wallet, before touching Redis", async () => {
            await arm()

            await expect(startPod([])).rejects.toThrow(
                "Redis sender manager requires an eligible wallet"
            )
            await expect(
                startPod(ACCOUNTS.slice(0, 2), { maxExecutors: 0 })
            ).rejects.toThrow(
                "Redis sender manager requires an eligible wallet"
            )
            expect(managerClients.size).toBe(0)
        })

        it(
            "T21: pods with overlapping and disjoint keys never take foreign wallets or lose them",
            { timeout: 60_000 },
            async () => {
                await arm()
                const setA = ACCOUNTS.slice(0, 10)
                const setB = ACCOUNTS.slice(5, 15)
                const setC = ACCOUNTS.slice(15)
                // A lowercase copy next to its checksummed entry, as a hand
                // repair could leave it.
                await inspect.rpush(
                    keys.pool,
                    ACCOUNTS[3].address,
                    lower(ACCOUNTS[3].address)
                )
                const pods: [Pod, Account[]][] = [
                    [await startPod(setA), setA],
                    [await startPod(setB), setB],
                    [await startPod(setC), setC]
                ]
                const holders = new Set<string>()
                const foreignTakes: string[] = []
                let overlaps = 0
                const worker = async ([pod, own]: [Pod, Account[]]) => {
                    const ownAddresses = new Set(
                        own.map((a) => lower(a.address))
                    )
                    for (let cycle = 0; cycle < 30; cycle++) {
                        const wallet = await pod.manager.getWallet()
                        const address = lower(wallet.address)
                        if (!ownAddresses.has(address))
                            foreignTakes.push(address)
                        if (holders.has(address)) overlaps++
                        holders.add(address)
                        await sleep(Math.floor(Math.random() * 3))
                        holders.delete(address)
                        await pod.manager.markWalletProcessed(wallet)
                    }
                }

                await Promise.all(
                    pods.flatMap((entry) =>
                        Array.from({ length: 4 }, () => track(worker(entry)))
                    )
                )

                expect({ overlaps, foreignTakes }).toEqual({
                    overlaps: 0,
                    foreignTakes: []
                })
                const { list, inUse } = await snapshot()
                // Every unique address survives; the stray copy may or may not
                // have been dropped, since reconcile does not deduplicate.
                expect([...new Set(list.map(lower))].sort()).toEqual(
                    lowered(ACCOUNTS)
                )
                expect([20, 21]).toContain(list.length)
                expect(inUse).toEqual([])
            }
        )

        it("T22: refuses to start on an unarmed pool and writes nothing", async () => {
            await expect(startPod(ACCOUNTS)).rejects.toThrow(/is not armed/)
            expect(
                await inspect.exists(keys.pool, keys.inUse, keys.armed)
            ).toBe(0)

            await inspect.rpush(keys.pool, ...addresses(ACCOUNTS.slice(0, 2)))
            await expect(startPod(ACCOUNTS)).rejects.toThrow(/is not armed/)
            expect(await inspect.lrange(keys.pool, 0, -1)).toEqual(
                addresses(ACCOUNTS.slice(0, 2))
            )
            expect(await inspect.exists(keys.inUse, keys.armed)).toBe(0)

            await sleep(50)
            expect([...managerClients].map((client) => client.status)).toEqual([
                "end",
                "end"
            ])
        })

        it("T23: a sync re-adds lost idle wallets but never a held one", async () => {
            await arm()
            const accounts = ACCOUNTS.slice(0, 3)
            const a = await startPod(accounts)
            const held = await a.manager.getWallet()
            const lost = accounts.filter(
                (account) => account.address !== held.address
            )
            for (const account of lost) {
                await inspect.lrem(keys.pool, 0, account.address)
            }

            const [armed, added, poolSize, inUseCount] = await reconcile(
                a,
                accounts
            )

            expect({ armed, poolSize, inUseCount }).toEqual({
                armed: 1,
                poolSize: 2,
                inUseCount: 1
            })
            expect([...added].sort()).toEqual(addresses(lost).sort())
            expect(isChecksummed((await snapshot()).list)).toBe(true)
            // Nothing is missing any more.
            expect((await reconcile(a, accounts))[1]).toEqual([])
        })

        it("T24: after a wipe the sync adds nothing and the holder's return fails closed", async () => {
            await arm()
            const [account] = ACCOUNTS
            const a = await startPod([account])
            const held = await a.manager.getWallet()
            await inspect.del(keys.pool, keys.inUse, keys.armed)

            expect(await reconcile(a, [account])).toEqual([0, [], 0, 0, 0])
            await expect(a.manager.markWalletProcessed(held)).rejects.toThrow(
                "Active wallet has no in-use reservation"
            )
            expect(a.logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ executor: account.address }),
                "wallet return failed; reservation requires inspection"
            )
            expect(
                await inspect.exists(keys.pool, keys.inUse, keys.armed)
            ).toBe(0)
        })

        it("RF: fails startup against an unreachable Redis and stops reconnecting", async () => {
            // The manager's client has no error listener, so ioredis prints
            // the refused connection itself; keep it out of the test output.
            vi.spyOn(console, "error").mockImplementation(() => undefined)
            await expect(
                startPod(ACCOUNTS, { redisEndpoint: "redis://127.0.0.1:1" })
            ).rejects.toThrow()

            // disconnect() while reconnecting never reaches status "end";
            // what matters is that no further connect attempt happens.
            // ioredis' first retries come after 50ms and 100ms.
            const attempts = connectCalls
            await sleep(400)
            expect(connectCalls).toBe(attempts)
        })

        it("shutdown leaves unresolved checkouts unavailable to the next pod", async () => {
            await arm()
            const accounts = ACCOUNTS.slice(0, 3)
            const a = await startPod(accounts)
            // Stand-ins for an in-flight send, a submitted bundle and a
            // quarantined wallet, plus a bundle still waiting for a wallet.
            const held = [
                await a.manager.getWallet(),
                await a.manager.getWallet(),
                await a.manager.getWallet()
            ]
            const waiting = track(a.manager.getWallet())
            const release = vi.spyOn(a.manager, "markWalletProcessed")
            const shutdownLogger = makeLogger()

            await releaseWalletsOnShutdown({
                config: {
                    enableHorizontalScaling: true,
                    redisEndpoint: redisUrl()
                } as AltoConfig,
                senderManager: a.manager,
                logger: shutdownLogger as never
            })

            expect(release).not.toHaveBeenCalled()
            expect(shutdownLogger.warn).toHaveBeenCalledWith(
                { count: 3, executors: held.map((w) => w.address) },
                "leaving unresolved executor wallets in use at shutdown"
            )
            // The process exits: its client closes and the waiting take fails.
            a.client.disconnect()
            await expect(waiting).rejects.toThrow()

            const b = await startPod(accounts)
            expect(b.logger.info).toHaveBeenCalledWith(
                expect.objectContaining({ addedCount: 0, inUseCount: 3 }),
                "reconciled executor wallet pool"
            )
            const next = track(b.manager.getWallet())
            expect(
                await Promise.race([
                    next.then(() => "taken"),
                    sleep(300).then(() => "waiting")
                ])
            ).toBe("waiting")
            b.client.disconnect()
            await expect(next).rejects.toThrow()
        })

        describe("T17: a lost reply is never replayed", () => {
            let proxy: Awaited<ReturnType<typeof startFaultProxy>>
            let proxiedPods: Pod[]

            beforeEach(async () => {
                proxy = await startFaultProxy(redisUrl())
                proxiedPods = []
            })
            afterEach(async () => {
                // Close proxied clients while connected: disconnect() during
                // a reconnect never emits "end", which is what cancels the
                // manager's sync timer.
                proxy.setDown(false)
                for (const pod of proxiedPods) {
                    if (pod.client.status !== "ready") {
                        await new Promise<void>((resolve) =>
                            pod.client.once("ready", () => resolve())
                        )
                    }
                    pod.client.disconnect()
                }
                await proxy.close()
            })

            // A pod connected through the proxy. One take and return first:
            // ioredis sends a script's first call on a connection as a full
            // eval, and Redis caches the script, so the cut command is an
            // evalsha that really runs, never a NOSCRIPT reply.
            const startProxiedPod = async (accounts: Account[]) => {
                const pod = await startPod(accounts, {
                    redisEndpoint: proxy.url
                })
                proxiedPods.push(pod)
                await pod.manager.markWalletProcessed(
                    await pod.manager.getWallet()
                )
                return pod
            }
            const reconnected = (pod: Pod) =>
                new Promise<void>((resolve) =>
                    pod.client.once("ready", () => resolve())
                )

            it("a take that ran but lost its reply strands the wallet and is not resent", async () => {
                await arm()
                const [account] = ACCOUNTS
                const a = await startProxiedPod([account])
                const ready = reconnected(a)
                proxy.cutNext("after-execution")

                await expect(a.manager.getWallet()).rejects.toThrow()

                expect(await snapshot()).toEqual({
                    list: [],
                    inUse: [lower(account.address)]
                })
                await ready
                await sleep(50)
                expect(proxy.sentAfterCut()).not.toMatch(/eval/i)
                expect(a.manager.getActiveWallets()).toEqual([])
                // Nobody else can take the stranded wallet either.
                const b = await startPod([account])
                const next = track(b.manager.getWallet())
                expect(
                    await Promise.race([
                        next.then(() => "taken"),
                        sleep(300).then(() => "waiting")
                    ])
                ).toBe("waiting")
                b.client.disconnect()
                await expect(next).rejects.toThrow()
            })

            it("a take cut before Redis ran it changes nothing", async () => {
                await arm()
                const [account] = ACCOUNTS
                const a = await startProxiedPod([account])
                const ready = reconnected(a)
                proxy.cutNext("before-execution")

                await expect(a.manager.getWallet()).rejects.toThrow()

                expect(await snapshot()).toEqual({
                    list: [account.address],
                    inUse: []
                })
                await ready
                const wallet = await a.manager.getWallet()
                expect(wallet.address).toBe(account.address)
                await a.manager.markWalletProcessed(wallet)
            })

            it("a return that ran but lost its reply never frees a later checkout", async () => {
                await arm()
                const [account] = ACCOUNTS
                const a = await startProxiedPod([account])
                const b = await startPod([account])
                const held = await a.manager.getWallet()
                const ready = reconnected(a)
                proxy.cutNext("after-execution")

                await expect(
                    a.manager.markWalletProcessed(held)
                ).rejects.toThrow()

                expect(a.logger.error).toHaveBeenCalledWith(
                    expect.objectContaining({ executor: account.address }),
                    "wallet return failed; reservation requires inspection"
                )
                // The return ran, so another pod takes the wallet before A reconnects.
                const taken = await b.manager.getWallet()
                expect(taken.address).toBe(account.address)
                await ready
                await sleep(50)
                expect(proxy.sentAfterCut()).not.toMatch(/eval/i)
                const sendCommand = vi.spyOn(a.client, "sendCommand")
                await a.manager.markWalletProcessed(held)
                expect(sendCommand).not.toHaveBeenCalled()
                expect(await snapshot()).toEqual({
                    list: [],
                    inUse: [lower(account.address)]
                })
                await b.manager.markWalletProcessed(taken)
            })

            it("a return cut before Redis ran it leaves the wallet reserved and is not retried", async () => {
                await arm()
                const [account] = ACCOUNTS
                const a = await startProxiedPod([account])
                const held = await a.manager.getWallet()
                const ready = reconnected(a)
                proxy.cutNext("before-execution")

                await expect(
                    a.manager.markWalletProcessed(held)
                ).rejects.toThrow()

                await ready
                await sleep(50)
                expect(proxy.sentAfterCut()).not.toMatch(/eval/i)
                expect(a.manager.getActiveWallets()).toEqual([])
                expect(await snapshot()).toEqual({
                    list: [],
                    inUse: [lower(account.address)]
                })
            })

            it("RF: a take while the connection is down rejects at once instead of queueing", async () => {
                await arm()
                const a = await startProxiedPod([ACCOUNTS[0]])
                proxy.setDown(true)
                await sleep(50)

                const started = Date.now()
                await expect(a.manager.getWallet()).rejects.toThrow()
                expect(Date.now() - started).toBeLessThan(1000)
            })

            it("defers a return while the connection is down and sends it after reconnect", async () => {
                await arm()
                const [account] = ACCOUNTS
                const a = await startProxiedPod([account])
                const held = await a.manager.getWallet()
                proxy.setDown(true)
                await waitFor(
                    () => a.client.status !== "ready",
                    "the client to notice the outage"
                )

                await a.manager.markWalletProcessed(held)

                expect(a.logger.warn).toHaveBeenCalledWith(
                    { executor: account.address },
                    "wallet return deferred until Redis reconnects"
                )
                expect(await snapshot()).toEqual({
                    list: [],
                    inUse: [lower(account.address)]
                })
                expect(a.manager.getActiveWallets()).toEqual([held])

                proxy.setDown(false)
                const deadline = Date.now() + 5000
                while ((await snapshot()).list.length === 0) {
                    if (Date.now() > deadline) {
                        throw new Error("the deferred return never arrived")
                    }
                    await sleep(20)
                }
                expect(await snapshot()).toEqual({
                    list: [account.address],
                    inUse: []
                })
                expect(a.manager.getActiveWallets()).toEqual([])
            })
        })
    }
)
