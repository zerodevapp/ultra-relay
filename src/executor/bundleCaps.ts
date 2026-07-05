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

// `proven` marks chains whose resolved caps are doc-verified HARD limits, not
// the conservative guess. Only proven caps may reject a userOp at ingress; on
// an unlisted chain the caps only shape packing and the node is the judge
// (a genuinely oversized op surfaces as a ground-truth rejection at send).
type BundleCaps = { gasCap: bigint; byteCap: number; proven: boolean }

// Resolution precedence: chainId override > chainType family > default.
// Only list chains that PROVABLY differ from the conservative default.
const CHAIN_TYPE_CAP_OVERRIDES: Record<
    string,
    Partial<Omit<BundleCaps, "proven">>
> = {
    // Arbitrum/Orbit: execution gas cap is 32M. Its HARD byte limit is 117,964
    // (DataTooLarge rejects above this; Arbitrum itself set that to 90% of
    // geth's 128 KiB) -- lower than the geth default, so the default byteCap
    // would OVERFLOW it. This is the raw rejection limit, not a margined value:
    // bundleByteThreshold still applies the uniform safety margin on top.
    arbitrum: { gasCap: 32_000_000n, byteCap: 117_964 }
}

const CHAIN_ID_CAP_OVERRIDES: Record<
    number,
    Partial<Omit<BundleCaps, "proven">>
> = {
    // Polygon PoS (bor): no per-tx gas cap (block limit 140M+). Raise above the
    // default 16.77M for bundle throughput. Bytes inherit the geth default
    // (bor is a geth fork -> txMaxSize 131072).
    137: { gasCap: 30_000_000n }
}

// Chains verified to enforce exactly the DEFAULT caps as hard limits:
// EIP-7825 gas cap live (mainnet/Base since Fusaka; BNB since the Apr 2026
// Osaka/Mendel fork) and geth's 131,072-byte txMaxSize.
const PROVEN_DEFAULT_CAP_CHAIN_IDS = new Set<number>([
    1, // mainnet
    8453, // base
    56 // bnb
])

export const getBundleCaps = (config: AltoConfig): BundleCaps => ({
    gasCap: DEFAULT_BUNDLE_GAS_CAP,
    byteCap: DEFAULT_BUNDLE_BYTE_CAP,
    proven:
        config.chainId in CHAIN_ID_CAP_OVERRIDES ||
        config.chainType in CHAIN_TYPE_CAP_OVERRIDES ||
        PROVEN_DEFAULT_CAP_CHAIN_IDS.has(config.chainId),
    ...CHAIN_TYPE_CAP_OVERRIDES[config.chainType],
    ...CHAIN_ID_CAP_OVERRIDES[config.chainId]
})

export const bundleByteThreshold = (byteCap: number): number =>
    Math.floor((byteCap * BUNDLE_BYTE_SAFETY_PERCENT) / 100)
