-- Written-reading idempotency ledger.
--
-- Before this table, the only post-broadcast record that a reading had been
-- written lived in the per-family legacy reading tables (`air_quality_readings`
-- and three siblings) via their `txid` column. That covered four of the
-- seventeen data families. The other thirteen had no durable record at all, so
-- a restart re-enqueued work that had already been broadcast: the only gate was
-- an in-memory dedupe store, which is empty on boot.
--
-- This table is the durable, family-agnostic form. One row per
-- (data_family, source_hash) that has been broadcast, carrying the txid that
-- paid for it. The worker queue consults it before broadcasting and writes it
-- before marking the queue row complete, so a crash between the two leaves a
-- ledger row (harmless duplicate prevention) rather than an orphaned reading.
--
-- Additive only: no existing table, column, or index is altered or dropped, and
-- no data is removed. Safe to apply on a live database.

CREATE TABLE IF NOT EXISTS written_readings (
  data_family TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  txid TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (data_family, source_hash)
);

-- Retention pruning and operational queries age rows on created_at.
CREATE INDEX IF NOT EXISTS written_readings_created_at_idx ON written_readings (created_at);
