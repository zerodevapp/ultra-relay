import { describe, expect, it } from "vitest"
import type { AltoConfig } from "../../createConfig"
import { getRedisKeys, getRedisStorePrefix } from "./redisKeys"

const cfg = (chainId: number, redisKeyPrefix?: string) =>
    ({ chainId, redisKeyPrefix }) as unknown as AltoConfig

describe("getRedisStorePrefix", () => {
    it("keeps the legacy bare chainId layout for the default prefix", () => {
        expect(getRedisStorePrefix(cfg(8453, "alto"))).toBe("8453")
    })

    it("keeps the legacy layout when no prefix is configured", () => {
        expect(getRedisStorePrefix(cfg(1))).toBe("1")
    })

    it("namespaces store keys under an explicit prefix", () => {
        expect(
            getRedisStorePrefix(cfg(42161, "ur-arbitrum-mainnet-ostium"))
        ).toBe("ur-arbitrum-mainnet-ostium:42161")
    })
})

describe("getRedisKeys", () => {
    it("is unchanged for the default prefix", () => {
        expect(getRedisKeys(cfg(8453, "alto")).senderManagerQueue).toBe(
            "alto:8453:sender-manager"
        )
    })

    it("namespaces under an explicit prefix", () => {
        expect(
            getRedisKeys(cfg(42161, "ur-arbitrum-mainnet-ostium"))
                .userOpStatusQueue
        ).toBe("ur-arbitrum-mainnet-ostium:42161:userop-status")
    })
})
