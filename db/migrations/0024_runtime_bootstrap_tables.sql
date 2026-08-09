-- Tables historically created at runtime via CREATE TABLE IF NOT EXISTS on every
-- process boot / queue touch. Under pool pressure those DDL statements wait on
-- locks, hit statement_timeout, reset the in-memory "ready" promise, and spam
-- Supabase logs. Own them in migrations; app code only probes existence.

CREATE TABLE IF NOT EXISTS worker_queue (
  id text PRIMARY KEY,
  priority text NOT NULL,
  data jsonb NOT NULL,
  timestamp bigint NOT NULL,
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 3,
  status text NOT NULL DEFAULT 'queued',
  last_error text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_queue_status_idx ON worker_queue(status);
CREATE INDEX IF NOT EXISTS worker_queue_updated_idx ON worker_queue(updated_at);

CREATE TABLE IF NOT EXISTS utxo_locks (
  utxo_key text PRIMARY KEY,
  reserved_by text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS utxo_locks_expires_idx ON utxo_locks(expires_at);

CREATE TABLE IF NOT EXISTS air_quality_onchain (
  txid text PRIMARY KEY,
  provider text,
  collected_at timestamptz,
  payload jsonb
);
CREATE TABLE IF NOT EXISTS water_levels_onchain (
  txid text PRIMARY KEY,
  provider text,
  collected_at timestamptz,
  payload jsonb
);
CREATE TABLE IF NOT EXISTS seismic_onchain (
  txid text PRIMARY KEY,
  provider text,
  collected_at timestamptz,
  payload jsonb
);
CREATE TABLE IF NOT EXISTS advanced_metrics_onchain (
  txid text PRIMARY KEY,
  provider text,
  collected_at timestamptz,
  payload jsonb
);
