import type { Logger } from "pino"
import type { Account } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { AltoConfig } from "../createConfig"
import type { SenderManager } from "../executor/senderManager"
import { releaseWalletsOnShutdown } from "./shutDown"

// Importing shutDown reaches utils/logger, which builds a Logtail transport
// at module load when BETTER_STACK_TOKEN is set; see executorManager.test.ts.
vi.hoisted(() => {
    process.env.BETTER_STACK_TOKEN = ""
})

const wallets = [
    { address: "0x1111111111111111111111111111111111111111" },
    { address: "0x2222222222222222222222222222222222222222" }
] as unknown as Account[]

const makeSenderManager = (active: Account[]) => ({
    getActiveWallets: vi.fn(() => [...active]),
    markWalletProcessed: vi.fn((_wallet: Account) => Promise.resolve())
})

const run = (config: Partial<AltoConfig>, active: Account[]) => {
    const senderManager = makeSenderManager(active)
    const logger = { warn: vi.fn() }
    return releaseWalletsOnShutdown({
        config: config as AltoConfig,
        senderManager: senderManager as unknown as SenderManager,
        logger: logger as unknown as Logger
    }).then(() => ({ senderManager, logger }))
}

const REDIS = { enableHorizontalScaling: true, redisEndpoint: "redis://x" }

describe("releaseWalletsOnShutdown", () => {
    it("leaves Redis checkouts in use and names them", async () => {
        const { senderManager, logger } = await run(REDIS, wallets)

        expect(senderManager.markWalletProcessed).not.toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledWith(
            { count: 2, executors: wallets.map((w) => w.address) },
            "leaving unresolved executor wallets in use at shutdown"
        )
    })

    it("logs nothing when no Redis checkout is open", async () => {
        const { logger } = await run(REDIS, [])

        expect(logger.warn).not.toHaveBeenCalled()
    })

    it("returns every active in-memory wallet, as before", async () => {
        const { senderManager } = await run(
            { enableHorizontalScaling: false, redisEndpoint: "redis://x" },
            wallets
        )

        expect(
            senderManager.markWalletProcessed.mock.calls.map(([w]) => w)
        ).toEqual(wallets)
    })

    it("treats horizontal scaling without a Redis endpoint as in-memory", async () => {
        const { senderManager } = await run(
            { enableHorizontalScaling: true },
            wallets
        )

        expect(senderManager.markWalletProcessed).toHaveBeenCalledTimes(2)
    })
})
