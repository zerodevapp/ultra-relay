import type { UserOpInfo } from "@alto/types"

export type InclusionTimings = {
    inclusionTimeMs: number
    totalMs: number
    validationMs: number | undefined
    outstandingMs: number | undefined
    processingMs: number | undefined
    submittedMs: number | undefined
    bundleBuildMs?: number
    handOffMs?: number
    walletWaitMs?: number
    submissionMs?: number
}

// Stage durations for the inclusion log. The first six are the existing
// fields, moved here unchanged. The last four split processingMs
// (processingAt -> submittedAt) into adjacent stages that sum to it exactly;
// they are emitted only when every stamp is present and in order, so a
// rotated or older record never reports a negative stage.
export function computeInclusionTimings(
    userOpInfo: UserOpInfo,
    blockReceivedTimestamp: number
): InclusionTimings {
    const {
        receivedAt,
        addedToMempool,
        processingAt,
        bundledAt,
        dispatchedAt,
        walletAcquiredAt,
        submittedAt,
        reentered
    } = userOpInfo

    const inclusionTimeMs = blockReceivedTimestamp - addedToMempool
    // totalMs spans the op's whole life (receivedAt survives resubmission);
    // validationMs is suppressed for reentered records, whose restamped
    // addedToMempool would make the delta span the entire prior cycle.
    const totalMs = blockReceivedTimestamp - (receivedAt ?? addedToMempool)

    const hasBreakdown =
        processingAt &&
        bundledAt &&
        dispatchedAt &&
        walletAcquiredAt &&
        submittedAt &&
        processingAt <= bundledAt &&
        bundledAt <= dispatchedAt &&
        dispatchedAt <= walletAcquiredAt &&
        walletAcquiredAt <= submittedAt

    return {
        inclusionTimeMs,
        totalMs,
        validationMs:
            receivedAt && !reentered ? addedToMempool - receivedAt : undefined,
        outstandingMs: processingAt ? processingAt - addedToMempool : undefined,
        processingMs:
            processingAt && submittedAt
                ? submittedAt - processingAt
                : undefined,
        submittedMs: submittedAt
            ? blockReceivedTimestamp - submittedAt
            : undefined,
        ...(hasBreakdown && {
            bundleBuildMs: bundledAt - processingAt,
            handOffMs: dispatchedAt - bundledAt,
            walletWaitMs: walletAcquiredAt - dispatchedAt,
            submissionMs: submittedAt - walletAcquiredAt
        })
    }
}
