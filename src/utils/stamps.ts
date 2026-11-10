import type { UserOpInfo } from "@alto/types"

// Stage stamps on userOp records; the rule each one follows is described on
// userOpInfoSchema.
type StageStamp = "bundledAt" | "dispatchedAt" | "walletAcquiredAt"

// Overwrites the stamp on every record.
export function stampLatest(
    userOps: UserOpInfo[],
    field: StageStamp,
    at: number
): void {
    for (const userOpInfo of userOps) {
        userOpInfo[field] = at
    }
}

// Sets the stamp only where it is still unset, so the first value wins.
export function stampFirst(
    userOps: UserOpInfo[],
    field: StageStamp,
    at: number
): void {
    for (const userOpInfo of userOps) {
        userOpInfo[field] ??= at
    }
}
