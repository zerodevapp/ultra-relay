import { type Address, type Hex, type StateOverride, concat } from "viem"
import type { UserOperation } from "../types/schemas"

export const getEip7702DelegationOverrides = (
    userOps: UserOperation[]
): StateOverride | undefined => {
    // Dedupe by sender. When a bundle contains multiple userOps from the
    // same sender (a common back-to-back submission pattern), pushing one
    // stateOverride entry per userOp produces duplicate `address` entries
    // in the array. viem rejects that with:
    //   `State for account "0x..." is set multiple times.`
    // The whole filterOps simulation aborts and both userOps get evicted
    // from the mempool. The delegate code is the same for every userOp
    // from a given sender (the EIP-7702 authorization points at the same
    // implementation), so collapsing to one entry per sender is safe.
    const codeBySender = new Map<Address, Hex>()

    for (const userOp of userOps) {
        if (!userOp.eip7702Auth) continue

        const delegate =
            "address" in userOp.eip7702Auth
                ? userOp.eip7702Auth.address
                : userOp.eip7702Auth.contractAddress

        codeBySender.set(userOp.sender, concat(["0xef0100", delegate]))
    }

    if (codeBySender.size === 0) {
        return undefined
    }

    return Array.from(codeBySender, ([address, code]) => ({ address, code }))
}
