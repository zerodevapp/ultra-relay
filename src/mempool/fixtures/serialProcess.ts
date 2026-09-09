// Frozen queue/cap/commit oracle from 524b802, before unifying the production engines.
// Intentionally retain the historical serial loop; do not refactor it alongside process().
import type {
    Address,
    EntryPointVersion,
    StorageMap,
    UserOpInfo,
    UserOperationBundle
} from "@alto/types"
import {
    getSerializedHandleOpsTx,
    isVersion07,
    isVersion08,
    minBigInt,
    scaleBigIntByPercent
} from "@alto/utils"
import type { Logger } from "@alto/utils"
import { size } from "viem"
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts"
import type { AltoConfig } from "../../createConfig"
import { bundleByteThreshold, getBundleCaps } from "../../executor/bundleCaps"
import { calculateAA95GasFloor } from "../../executor/utils"
import type { Mempool } from "../mempool"
import type { InterfaceReputationManager } from "../reputationManager"

type SerialContext = Pick<
    Mempool,
    "store" | "shouldSkip" | "getKnownEntities"
> & {
    config: AltoConfig
    logger: Logger
    reputationManager: Pick<InterfaceReputationManager, "decreaseUserOpCount">
}

// Returns a bundle of userOperations in array format.
export async function serialProcess(
    this: SerialContext,
    {
        maxGasLimit,
        entryPoint,
        minOpsPerBundle,
        maxBundleCount
    }: {
        maxGasLimit: bigint
        entryPoint: Address
        minOpsPerBundle: number
        maxBundleCount?: number
    }
): Promise<UserOperationBundle[]> {
    // Check if there are any operations in the store
    const firstOp = await this.store.peekOutstanding(entryPoint)
    if (!firstOp) {
        return []
    }

    // Get EntryPoint version
    const bundles: UserOperationBundle[] = []
    const seenOps = new Set()
    const deferred: UserOpInfo[] = []
    let breakLoop = false

    // Process operations until no more are available or we hit maxBundleCount
    while (await this.store.peekOutstanding(entryPoint)) {
        // If maxBundles is set and we reached the limit, break
        if (maxBundleCount && bundles.length >= maxBundleCount) {
            break
        }

        // Derive version
        let version: EntryPointVersion
        if (isVersion08(firstOp.userOp, entryPoint)) {
            version = "0.8"
        } else if (isVersion07(firstOp.userOp)) {
            version = "0.7"
        } else {
            version = "0.6"
        }

        // Setup for next bundle
        const currentBundle: UserOperationBundle = {
            entryPoint,
            version,
            userOps: [],
            submissionAttempts: 0
        }
        let gasUsed = 0n
        let eip7702Overhead = 0n
        const caps = getBundleCaps(this.config)
        const gasCeiling = minBigInt(maxGasLimit, caps.gasCap)
        const byteThreshold = bundleByteThreshold(caps.byteCap)
        let paymasterDeposit: { [paymaster: string]: bigint } = {}
        let stakedEntityCount: { [addr: string]: number } = {}
        let senders = new Set<string>()
        let knownEntities = await this.getKnownEntities(entryPoint)
        let storageMap: StorageMap = {}

        if (breakLoop) {
            break
        }

        // Keep adding ops to current bundle
        while (await this.store.peekOutstanding(entryPoint)) {
            const userOpInfo = await this.store.popOutstanding(entryPoint)
            if (!userOpInfo) {
                break
            }

            if (seenOps.has(userOpInfo.userOpHash)) {
                breakLoop = true
                userOpInfo.reentered = true
                await this.store.addOutstanding({
                    entryPoint,
                    userOpInfo
                })
                break
            }

            seenOps.add(userOpInfo.userOpHash)

            // An operation in infrastructure backoff must not return to the
            // head of the queue: with distinct fees it would be popped again
            // immediately, trip the reentry guard and end the tick for every
            // other operation. Hold it aside and restore it after the tick.
            if ((userOpInfo.retryAfter ?? 0) > Date.now()) {
                deferred.push(userOpInfo)
                continue
            }

            const { userOp } = userOpInfo

            // Check if we should skip this operation
            const skipResult = await this.shouldSkip({
                userOpInfo,
                paymasterDeposit,
                stakedEntityCount,
                knownEntities,
                senders,
                storageMap,
                entryPoint
            })

            if (skipResult.skip) {
                // Re-add to outstanding
                if (!skipResult.removeOutstanding) {
                    userOpInfo.reentered = true
                    await this.store.addOutstanding({
                        entryPoint,
                        userOpInfo
                    })
                }
                continue
            }

            const beneficiary =
                this.config.utilityPrivateKey?.address ||
                privateKeyToAddress(generatePrivateKey())

            gasUsed += calculateAA95GasFloor({
                userOps: [userOp],
                beneficiary
            })
            if (userOp.eip7702Auth) {
                eip7702Overhead += 40_000n
            }

            // Project the ACTUAL submitted tx gas (executor scales the floor
            // by 105%), not the raw floor, so the budget matches what the
            // node sees against the per-tx gas cap.
            const projectedGas = scaleBigIntByPercent(
                gasUsed + eip7702Overhead,
                105n
            )

            // Project the serialized tx byte size if this op is added.
            // O(n^2): re-serializes the growing candidate bundle per op.
            // Bounded by bundle size (gas cap keeps n small) and runs once
            // per bundling tick; switch to a running per-op size delta if
            // packing latency ever shows up in profiles.
            const candidateUserOps = [
                ...currentBundle.userOps.map((info) => info.userOp),
                userOp
            ]
            const projectedBytes = size(
                getSerializedHandleOpsTx({
                    userOps: candidateUserOps,
                    entryPoint,
                    chainId: this.config.chainId,
                    removeZeros: false
                })
            )

            const exceedsGas = projectedGas > gasCeiling
            const exceedsBytes = projectedBytes > byteThreshold

            // Only break once we have at least minOpsPerBundle ops; a lone
            // over-cap op is handled at ingress (rejected on proven-cap
            // chains) or by the executor (dropped on a ground-truth node
            // rejection) rather than black-holed here.
            if (
                (exceedsGas || exceedsBytes) &&
                currentBundle.userOps.length >= minOpsPerBundle
            ) {
                this.logger.debug(
                    {
                        event: "userOpSkipped",
                        reason: exceedsBytes
                            ? "Bundle byte size limit exceeded"
                            : "Bundle gas limit exceeded",
                        userOpHash: userOpInfo.userOpHash,
                        projectedGas: projectedGas.toString(),
                        gasCeiling: gasCeiling.toString(),
                        projectedBytes,
                        byteThreshold
                    },
                    `Skipping userOp ${userOpInfo.userOpHash}, would exceed bundle cap.`
                )

                // Put the operation back in the store
                userOpInfo.reentered = true
                await this.store.addOutstanding({ entryPoint, userOpInfo })
                break
            }

            // Update state based on skip result
            paymasterDeposit = skipResult.paymasterDeposit
            stakedEntityCount = skipResult.stakedEntityCount
            knownEntities = skipResult.knownEntities
            senders = skipResult.senders
            storageMap = skipResult.storageMap

            this.reputationManager.decreaseUserOpCount(userOp)
            userOpInfo.processingAt = Date.now()
            this.store.addProcessing({ entryPoint, userOpInfo })

            // Add op to current bundle
            currentBundle.userOps.push(userOpInfo)
        }

        if (currentBundle.userOps.length > 0) {
            bundles.push(currentBundle)
        }
    }

    for (const userOpInfo of deferred) {
        await this.store.addOutstanding({ entryPoint, userOpInfo })
    }

    return bundles
}
