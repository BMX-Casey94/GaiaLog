-- ─── Retention + stale-lock reaper support indexes ───────────────────────────
-- Non-destructive: CREATE INDEX IF NOT EXISTS only; no data is modified.
--
-- 1. overlay_submissions(created_at)
--    The retention pass (lib/retention.ts) now prunes broadcast-audit rows
--    older than RETENTION_SUBMISSIONS_DAYS with batched
--      DELETE ... WHERE created_at < $1 LIMIT n
--    overlay_submissions was observed at 15 GB / 4.5M rows in production;
--    without this index every batch seq-scans the heap.
--
-- 2. Partial index over stale locks on overlay_admitted_utxos
--    reapStaleLocks (lib/utxo-inventory.ts) releases rows whose owner died
--    between acquire and release (e.g. PM2 cron_restart kills). Locked live
--    rows are a tiny fraction of the table, so this partial index is only a
--    few MB and makes the reaper an index-only candidate scan.
--
-- NOTE ON APPLYING TO PRODUCTION:
-- Plain CREATE INDEX blocks writes for the build duration. On the live
-- Supabase instance prefer the concurrent variants (must run outside a
-- transaction, e.g. via the SQL editor with autocommit):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS overlay_submissions_created_at_idx
--     ON overlay_submissions(created_at);
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS overlay_admitted_utxos_stale_lock_idx
--     ON overlay_admitted_utxos(locked_at)
--     WHERE removed = false AND locked = true;

BEGIN;

CREATE INDEX IF NOT EXISTS overlay_submissions_created_at_idx
  ON overlay_submissions(created_at);

CREATE INDEX IF NOT EXISTS overlay_admitted_utxos_stale_lock_idx
  ON overlay_admitted_utxos(locked_at)
  WHERE removed = false AND locked = true;

COMMIT;
