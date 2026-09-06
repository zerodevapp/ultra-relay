import { RpcError, type UserOpInfo, ValidationErrors } from "@alto/types"

export type OperationFailure = {
    kind: "invalid_operation" | "upstream_timeout" | "upstream_error"
    retryable: boolean
    reason: string
}

export function publicOperationReason(value: unknown): string {
    const text = typeof value === "string" ? value : "Operation failed"
    return (
        text
            .slice(0, 8000)
            .replace(
                /(?:https?|wss?|rediss?|postgres(?:ql)?):\/\/[^\s"'<>`]+/gi,
                "[redacted URL]"
            )
            .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
            .replace(
                /\b(?:api[-_]?key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
                "[redacted credential]"
            )
            .replace(
                /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
                "[redacted token]"
            )
            // 32-byte hashes and single-word revert data are identity, not payload;
            // signatures and calldata are longer.
            .replace(/0x[0-9a-f]{130,}/gi, "[redacted hex]")
            .replace(
                /\b(?:calldata|signature|request body)\s*[:=][^\r\n]*/gi,
                "[redacted payload]"
            )
            .replace(/[\r\n\t]+/g, " ")
            .slice(0, 500)
    )
}

export function classifyOperationFailure(error: unknown): OperationFailure {
    // Inspect a bounded cause chain before treating any outer RpcError as an
    // invalid operation. Infrastructure errors must not damage reputation.
    const causes: Record<string, unknown>[] = []
    let current = error
    for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
        if (causes.includes(current as Record<string, unknown>)) break
        causes.push(current as Record<string, unknown>)
        current = (current as { cause?: unknown }).cause
    }
    if (
        causes.some(
            (e) =>
                e.name === "TimeoutError" ||
                ["ETIMEDOUT", "ECONNABORTED"].includes(String(e.code))
        )
    ) {
        return {
            kind: "upstream_timeout",
            retryable: true,
            reason: "Validation node timed out"
        }
    }
    if (
        causes.some(
            (e) =>
                [
                    "HttpRequestError",
                    "SocketClosedError",
                    "WebSocketRequestError"
                ].includes(String(e.name)) ||
                ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(
                    String(e.code)
                )
        )
    ) {
        return {
            kind: "upstream_error",
            retryable: true,
            reason: "Validation node unavailable"
        }
    }
    if (
        error instanceof RpcError &&
        typeof error.code === "number" &&
        Object.values(ValidationErrors).includes(error.code)
    ) {
        return {
            kind: "invalid_operation",
            retryable: false,
            reason: publicOperationReason(error.message)
        }
    }
    return {
        kind: "upstream_error",
        retryable: true,
        reason: "Unclassified infrastructure failure"
    }
}

/** Separate from broadcast/submission attempts; persisted with the operation. */
export function scheduleInfrastructureRetry(
    info: UserOpInfo,
    now = Date.now()
): boolean {
    const attempt = info.infrastructureRetries ?? 0
    if (attempt >= 3) return false
    info.infrastructureRetries = attempt + 1
    info.retryAfter = now + [250, 500, 1000][attempt]
    info.reentered = true
    return true
}
