import type { AltoConfig } from "../createConfig"

// EIP-7825 per-transaction gas cap (2^24). Conservative default: applies to an
// unlisted chain. The map below only RAISES this where a chain provably allows
// more; being too generous here reproduces the production oversized-tx loop.
export const DEFAULT_BUNDLE_GAS_CAP = 16_777_216n

// geth txMaxSize (128 KiB) on the full serialized transaction. Node DoS guard,
// not consensus, so it varies by client/chain. `byteCap` is always the chain's
// HARD rejection limit (the size at which the node rejects), never a
// pre-margined value -- the safety margin below is applied on top uniformly.
export const DEFAULT_BUNDLE_BYTE_CAP = 131_072

// Our serialized-tx byte estimate under-counts (omits the EIP-7702
// authorizationList and the real tx signature). `bundleByteThreshold` applies
// this margin to every chain's hard `byteCap` so we always bound below the real
// rejection limit, never at it.
export const BUNDLE_BYTE_SAFETY_PERCENT = 90

// The proven flags are PER DIMENSION: a cap may only reject a userOp at
// ingress when that specific cap is a verified hard limit for this chain
// (e.g. Polygon's byteCap is bor/geth's real txMaxSize, but its gasCap is our
// throughput choice -- byte-rejecting is safe there, gas-rejecting is not).
// An unproven cap only shapes packing and the node is the judge: a genuinely
// oversized op surfaces as a ground-truth rejection at send.
type BundleCaps = {
    gasCap: bigint
    byteCap: number
    gasCapProven: boolean
    byteCapProven: boolean
}

// Resolution precedence: chainId override > chainType family > default.
// Only list chains that PROVABLY differ from the conservative default.
const CHAIN_TYPE_CAP_OVERRIDES: Record<string, Partial<BundleCaps>> = {
    // Arbitrum/Orbit: 32M is ArbOS's enforced per-block execution gas limit
    // (hard ceiling for any tx). Its HARD byte limit is 117,964 (DataTooLarge
    // rejects above this; Arbitrum itself set that to 90% of geth's 128 KiB)
    // -- lower than the geth default, so the default byteCap would OVERFLOW
    // it. Both are raw rejection limits, not margined values:
    // bundleByteThreshold still applies the uniform safety margin on top.
    arbitrum: {
        gasCap: 32_000_000n,
        byteCap: 117_964,
        gasCapProven: true,
        byteCapProven: true
    }
}

const CHAIN_ID_CAP_OVERRIDES: Record<number, Partial<BundleCaps>> = {
    // Polygon PoS (bor): no per-tx gas cap (block limit 140M+), so the 30M
    // gasCap is OUR throughput choice, NOT a hard limit -> gasCapProven stays
    // false and ingress never gas-rejects here. Bytes inherit the geth default
    // and bor is a geth fork -> txMaxSize 131072 is its real hard limit.
    137: { gasCap: 30_000_000n, byteCapProven: true }
}

// Chains verified to enforce exactly the DEFAULT caps as hard limits.
// Gas: EIP-7825 is protocol-live on mainnet/Base (Fusaka, and empirically
// proven on Base by the prod incident this PR fixes: "gas limit too high",
// -32003) and on BNB via BEP-652 (Osaka/Mendel fork, ACTIVATED on mainnet
// 2026-04-28 -- verified activated, not just scheduled).
// Bytes: geth's 131,072 txMaxSize (empirically proven on BNB by the prod
// "oversized data: transaction size N, limit 131072" incident).
const PROVEN_DEFAULT_CAP_CHAIN_IDS = new Set<number>([
    1, // mainnet
    8453, // base
    56 // bnb
])

export const getBundleCaps = (config: AltoConfig): BundleCaps => {
    const provenDefault = PROVEN_DEFAULT_CAP_CHAIN_IDS.has(config.chainId)
    return {
        gasCap: DEFAULT_BUNDLE_GAS_CAP,
        byteCap: DEFAULT_BUNDLE_BYTE_CAP,
        gasCapProven: provenDefault,
        byteCapProven: provenDefault,
        ...CHAIN_TYPE_CAP_OVERRIDES[config.chainType],
        ...CHAIN_ID_CAP_OVERRIDES[config.chainId]
    }
}

export const bundleByteThreshold = (byteCap: number): number =>
    Math.floor((byteCap * BUNDLE_BYTE_SAFETY_PERCENT) / 100)
