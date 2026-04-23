import type { Logger, Metrics } from "@alto/utils"
import { type Address, type Hex, toHex } from "viem"
import type { AltoConfig } from "../createConfig"
import { type DbClient, createDbClient } from "./client"
import { userOpStatus } from "./schema"

type UserOpLike = {
    sender: Address
    nonce: bigint
}

const compositeTarget = [userOpStatus.userOpHash, userOpStatus.chainId]

export class UserOpStatusTracker {
    private db: DbClient | null = null
    private logger: Logger
    private enabled = false

    constructor({
        config,
        metrics: _metrics
    }: {
        config: AltoConfig
        metrics: Metrics
    }) {
        this.logger = config.getLogger(
            { module: "userop_status_tracker" },
            { level: config.logLevel }
        )

        const databaseUrl = config.databaseUrl as string | undefined
        if (!databaseUrl) {
            this.logger.info(
                "No database-url configured, UserOp status tracking disabled"
            )
            return
        }

        try {
            this.db = createDbClient(databaseUrl)
            this.enabled = true
            this.logger.info("UserOp status tracking enabled with Postgres")
        } catch (error) {
            this.logger.warn(
                { error },
                "Failed to create database client, status tracking disabled"
            )
        }
    }

    async trackReceived(
        userOpHash: Hex,
        chainId: number,
        entryPoint: Address,
        userOp: UserOpLike
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const now = new Date()
            await this.db
                .insert(userOpStatus)
                .values({
                    userOpHash,
                    chainId,
                    entryPoint,
                    sender: userOp.sender,
                    nonce: toHex(userOp.nonce),
                    status: "pending_offchain",
                    sentAt: now,
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: compositeTarget,
                    set: {
                        status: "pending_offchain",
                        updatedAt: now
                    }
                })
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to track received status"
            )
        }
    }

    async trackFailedValidation(
        userOpHash: Hex,
        chainId: number,
        reason?: string,
        aaError?: string
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const now = new Date()
            await this.db
                .insert(userOpStatus)
                .values({
                    userOpHash,
                    chainId,
                    status: "failure_offchain",
                    errorMessage: reason,
                    aaError,
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: compositeTarget,
                    set: {
                        status: "failure_offchain",
                        errorMessage: reason,
                        aaError,
                        updatedAt: now
                    }
                })
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to track failed validation status"
            )
        }
    }

    async trackQueued(userOpHash: Hex, chainId: number): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const now = new Date()
            await this.db
                .insert(userOpStatus)
                .values({
                    userOpHash,
                    chainId,
                    status: "queued_offchain",
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: compositeTarget,
                    set: {
                        status: "queued_offchain",
                        updatedAt: now
                    }
                })
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to track queued status"
            )
        }
    }

    async trackAddedToMempool(
        userOpHash: Hex,
        chainId: number
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const now = new Date()
            await this.db
                .insert(userOpStatus)
                .values({
                    userOpHash,
                    chainId,
                    status: "added_to_mempool",
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: compositeTarget,
                    set: {
                        status: "added_to_mempool",
                        updatedAt: now
                    }
                })
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to track added to mempool status"
            )
        }
    }

    async trackSubmitted(
        userOpHashes: Hex[],
        chainId: number,
        transactionHash: Hex,
        maxFeePerGas: bigint,
        maxPriorityFeePerGas: bigint
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        const now = new Date()
        for (const userOpHash of userOpHashes) {
            try {
                await this.db
                    .insert(userOpStatus)
                    .values({
                        userOpHash,
                        chainId,
                        status: "pending_onchain",
                        transactionHash,
                        maxFeePerGas: toHex(maxFeePerGas),
                        maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
                        createdAt: now,
                        updatedAt: now
                    })
                    .onConflictDoUpdate({
                        target: compositeTarget,
                        set: {
                            status: "pending_onchain",
                            transactionHash,
                            maxFeePerGas: toHex(maxFeePerGas),
                            maxPriorityFeePerGas: toHex(
                                maxPriorityFeePerGas
                            ),
                            updatedAt: now
                        }
                    })
            } catch (error) {
                this.logger.warn(
                    { error, userOpHash },
                    "Failed to track submitted status"
                )
            }
        }
    }

    async trackIncluded(
        userOpHash: Hex,
        chainId: number,
        transactionHash: Hex,
        effectiveGasPrice?: bigint
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const now = new Date()
            await this.db
                .insert(userOpStatus)
                .values({
                    userOpHash,
                    chainId,
                    status: "success_onchain",
                    transactionHash,
                    effectiveGasPrice: effectiveGasPrice
                        ? toHex(effectiveGasPrice)
                        : undefined,
                    includedAt: now,
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: compositeTarget,
                    set: {
                        status: "success_onchain",
                        transactionHash,
                        effectiveGasPrice: effectiveGasPrice
                            ? toHex(effectiveGasPrice)
                            : undefined,
                        includedAt: now,
                        updatedAt: now
                    }
                })
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to track included status"
            )
        }
    }

    async trackExecutionReverted(
        userOpHash: Hex,
        chainId: number,
        transactionHash: Hex,
        reason?: string
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const now = new Date()
            await this.db
                .insert(userOpStatus)
                .values({
                    userOpHash,
                    chainId,
                    status: "failure_onchain",
                    transactionHash,
                    errorMessage: reason,
                    includedAt: now,
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: compositeTarget,
                    set: {
                        status: "failure_onchain",
                        transactionHash,
                        errorMessage: reason,
                        includedAt: now,
                        updatedAt: now
                    }
                })
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to track execution reverted status"
            )
        }
    }

    async trackFailedOnChain(
        userOpHash: Hex,
        chainId: number,
        transactionHash: Hex
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const now = new Date()
            await this.db
                .insert(userOpStatus)
                .values({
                    userOpHash,
                    chainId,
                    status: "failure_onchain",
                    transactionHash,
                    includedAt: now,
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: compositeTarget,
                    set: {
                        status: "failure_onchain",
                        transactionHash,
                        includedAt: now,
                        updatedAt: now
                    }
                })
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to track failed on-chain status"
            )
        }
    }

    async trackDropped(
        userOpHash: Hex,
        chainId: number,
        reason?: string,
        aaError?: string
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const now = new Date()
            await this.db
                .insert(userOpStatus)
                .values({
                    userOpHash,
                    chainId,
                    status: "dropped",
                    errorMessage: reason,
                    aaError,
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: compositeTarget,
                    set: {
                        status: "dropped",
                        errorMessage: reason,
                        aaError,
                        updatedAt: now
                    }
                })
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to track dropped status"
            )
        }
    }

    async trackFrontran(
        userOpHash: Hex,
        chainId: number,
        transactionHash: Hex
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const now = new Date()
            await this.db
                .insert(userOpStatus)
                .values({
                    userOpHash,
                    chainId,
                    status: "frontran",
                    transactionHash,
                    includedAt: now,
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: compositeTarget,
                    set: {
                        status: "frontran",
                        transactionHash,
                        includedAt: now,
                        updatedAt: now
                    }
                })
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to track frontran status"
            )
        }
    }

    async incrementRetryCount(
        userOpHash: Hex,
        chainId: number
    ): Promise<void> {
        if (!this.enabled || !this.db) return

        try {
            const { sql, and, eq } = await import("drizzle-orm")
            await this.db
                .update(userOpStatus)
                .set({
                    retryCount: sql`${userOpStatus.retryCount} + 1`,
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(userOpStatus.userOpHash, userOpHash),
                        eq(userOpStatus.chainId, chainId)
                    )
                )
        } catch (error) {
            this.logger.warn(
                { error, userOpHash },
                "Failed to increment retry count"
            )
        }
    }

    async close(): Promise<void> {
        if (!this.db) return

        try {
            const { sql } = await import("drizzle-orm")
            await this.db.execute(sql`SELECT 1`)
        } catch {
            // connection already closed
        }
        this.db = null
        this.enabled = false
        this.logger.info("UserOp status tracker closed")
    }
}
