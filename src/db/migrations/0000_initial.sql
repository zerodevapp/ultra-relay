-- UserOp Status Tracking - Initial Migration
-- This migration is idempotent (safe to re-run)

-- Master table for valid status values
CREATE TABLE IF NOT EXISTS userop_status_type (
    status TEXT PRIMARY KEY
);

INSERT INTO userop_status_type (status) VALUES
    ('pending_offchain'),
    ('failure_offchain'),
    ('queued_offchain'),
    ('added_to_mempool'),
    ('pending_onchain'),
    ('success_onchain'),
    ('failure_onchain'),
    ('dropped'),
    ('frontran')
ON CONFLICT DO NOTHING;

-- Main tracking table
CREATE TABLE IF NOT EXISTS userop_status (
    user_op_hash TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL,
    entry_point TEXT,
    sender TEXT,
    nonce TEXT,
    status TEXT NOT NULL REFERENCES userop_status_type(status),
    transaction_hash TEXT,
    error_message TEXT,
    aa_error TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_fee_per_gas TEXT,
    max_priority_fee_per_gas TEXT,
    effective_gas_price TEXT,
    sent_at TIMESTAMPTZ,
    included_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_userop_status_chain_sender
    ON userop_status (chain_id, sender);

CREATE INDEX IF NOT EXISTS idx_userop_status_status_updated
    ON userop_status (status, updated_at);
