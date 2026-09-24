import type { UserOpInfo } from "@alto/types"

export type InclusionTimings = {
    inclusionTimeMs: number
    totalMs: number
    validationMs: number | undefined
    outstandingMs: number | undefined
    processingMs: number | undefined
    submittedMs: number | undefined
    bundleBuildMs: number | undefined
    handOffMs: number | undefined
    walletWaitMs: number | undefined
    submissionMs: number | undefined
}

// Stage durations for the inclusion log. The first six are the existing
// fields, moved here unchanged. The last four split processingMs
// (processingAt -> submittedAt) into adjacent stages that sum to it exactly;
// they are emitted only when every stamp is present and in order, so a
// re-picked or rotated record never reports a negative stage.
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
        processingAt !== undefined &&
        processingAt !== 0 &&
        bundledAt !== undefined &&
        dispatchedAt !== undefined &&
        walletAcquiredAt !== undefined &&
        submittedAt !== undefined &&
        submittedAt !== 0 &&
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
        bundleBuildMs: hasBreakdown ? bundledAt - processingAt : undefined,
        handOffMs: hasBreakdown ? dispatchedAt - bundledAt : undefined,
        walletWaitMs: hasBreakdown
            ? walletAcquiredAt - dispatchedAt
            : undefined,
        submissionMs: hasBreakdown ? submittedAt - walletAcquiredAt : undefined
    }
}
