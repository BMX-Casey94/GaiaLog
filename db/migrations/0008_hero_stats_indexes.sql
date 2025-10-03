-- Add indexes for hero stats performance optimization
-- These indexes will significantly speed up the hero stats queries

-- Index for air quality readings (most recent AQI)
CREATE INDEX IF NOT EXISTS idx_air_quality_collected_at_desc 
ON air_quality_readings (collected_at DESC) 
WHERE aqi IS NOT NULL;

-- Composite index for tx_log status and timestamp queries
CREATE INDEX IF NOT EXISTS idx_tx_log_status_timestamp 
ON tx_log (status, COALESCE(onchain_at, collected_at) DESC)
WHERE txid IS NOT NULL 
  AND txid != 'failed' 
  AND txid != '' 
  AND txid NOT LIKE 'local_%' 
  AND txid NOT LIKE 'error_%'
  AND LENGTH(txid) = 64;

-- Index for tx_log transaction ID validation
CREATE INDEX IF NOT EXISTS idx_tx_log_valid_txid 
ON tx_log (txid) 
WHERE txid ~ '^[0-9a-fA-F]{64}$'
  AND LENGTH(txid) = 64;

-- Index for tx_log status filtering
CREATE INDEX IF NOT EXISTS idx_tx_log_status 
ON tx_log (status) 
WHERE status IN ('confirmed', 'pending');
