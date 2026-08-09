-- CREATE INDEX CONCURRENTLY must run outside an explicit transaction
-- (one statement per migrate round-trip).
--
-- Backfill / confirmation workers page oldest-first unconfirmed explorer rows
-- with keyset (reading_ts ASC, txid ASC). The existing
-- oer_confirmed_ts_idx (confirmed, reading_ts DESC) is the wrong shape once
-- millions of rows are still unconfirmed — Postgres falls back to a parallel
-- sequential scan + sort (~15–18s per LIMIT 200), which then trips
-- statement_timeout (57014) and starves the rest of the app.
--
-- Partial ASC index matches the backfill predicate exactly.

CREATE INDEX CONCURRENTLY IF NOT EXISTS oer_unconfirmed_ts_txid_idx
  ON overlay_explorer_readings (reading_ts ASC, txid ASC)
  WHERE confirmed = false;
