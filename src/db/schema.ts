import {
    index,
    integer,
    pgTable,
    primaryKey,
    text,
    timestamp
} from "drizzle-orm/pg-core"

export const userOpStatusType = pgTable("userop_status_type", {
    status: text("status").primaryKey()
})

export const userOpStatus = pgTable(
    "userop_status",
    {
        userOpHash: text("user_op_hash").notNull(),
        chainId: integer("chain_id").notNull(),
        entryPoint: text("entry_point"),
        sender: text("sender"),
        nonce: text("nonce"),
        status: text("status")
            .notNull()
            .references(() => userOpStatusType.status),
        transactionHash: text("transaction_hash"),
        errorMessage: text("error_message"),
        aaError: text("aa_error"),
        retryCount: integer("retry_count").notNull().default(0),
        maxFeePerGas: text("max_fee_per_gas"),
        maxPriorityFeePerGas: text("max_priority_fee_per_gas"),
        effectiveGasPrice: text("effective_gas_price"),
        sentAt: timestamp("sent_at", { withTimezone: true }),
        includedAt: timestamp("included_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.userOpHash, table.chainId]
        }),
        chainSenderIdx: index("idx_userop_status_chain_sender").on(
            table.chainId,
            table.sender
        ),
        statusUpdatedIdx: index("idx_userop_status_status_updated").on(
            table.status,
            table.updatedAt
        )
    })
)

export type UserOpStatusInsert = typeof userOpStatus.$inferInsert
export type UserOpStatusSelect = typeof userOpStatus.$inferSelect
