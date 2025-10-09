-- Performance optimization for tx_log table queries
-- This migration adds indexes to speed up the blockchain verification queries

-- Index for recent readings query (used by blockchain explorer)
-- Covers the WHERE clause filters and ORDER BY
CREATE INDEX IF NOT EXISTS idx_tx_log_recent_readings 
ON tx_log (type, status, collected_at DESC, onchain_at DESC)
WHERE status IN ('confirmed', 'pending')
  AND txid IS NOT NULL
  AND txid != 'failed'
  AND txid != ''
  AND LENGTH(txid) = 64;

-- Index for status and timestamp lookups
CREATE INDEX IF NOT EXISTS idx_tx_log_status_time 
ON tx_log (status, collected_at DESC)
WHERE status IN ('confirmed', 'pending');

-- Index for type-based queries
CREATE INDEX IF NOT EXISTS idx_tx_log_type_time 
ON tx_log (type, collected_at DESC);

-- Index for latest transaction query (used by hero stats "Last TX")
CREATE INDEX IF NOT EXISTS idx_tx_log_onchain_time
ON tx_log (onchain_at DESC)
WHERE status IN ('confirmed', 'pending')
  AND onchain_at IS NOT NULL;

-- Analyze the table to update statistics
ANALYZE tx_log;



