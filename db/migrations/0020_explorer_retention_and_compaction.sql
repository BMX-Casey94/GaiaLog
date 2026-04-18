BEGIN;

-- ─── Explorer Retention & Archive Infrastructure ─────────────────────────────
-- Adds the database-side machinery required to safely prune
-- overlay_explorer_readings without corrupting the trigger-maintained rollups
-- (overlay_explorer_stats, overlay_explorer_family_counts,
-- overlay_explorer_location_keys), and to retain *aggregate* historical
-- counts of pruned rows so the home-page can keep reporting an accurate
-- "total readings ever recorded" figure even after retention has run.
--
-- The runtime retention job lives in lib/retention.ts and is invoked via
-- the auth-protected route at app/api/maintenance/retention.  This migration
-- only ensures the schema can absorb DELETEs without drift and that nothing
-- of long-term value is lost (the chain itself remains the source of truth;
-- explorer-sync can backfill any pruned row from WhatsonChain on demand).

-- ─── Archive log: per-day, per-family aggregate of pruned rows ───────────────
-- One row per (UTC date, data_family).  Increments transactionally inside the
-- AFTER DELETE trigger below so every delete — whether from retention,
-- manual cleanup, or future code paths — keeps the archived totals accurate.
-- Storage cost is negligible (≤ 20 families * 365 days/yr ≈ 7k rows/yr).

CREATE TABLE IF NOT EXISTS overlay_explorer_archive_log (
  archive_day              date        NOT NULL,
  data_family              text        NOT NULL,
  pruned_count             bigint      NOT NULL DEFAULT 0,
  pruned_confirmed_count   bigint      NOT NULL DEFAULT 0,
  first_pruned_reading_ts  timestamptz,
  last_pruned_reading_ts   timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (archive_day, data_family)
);

CREATE INDEX IF NOT EXISTS oeal_family_day_idx
  ON overlay_explorer_archive_log(data_family, archive_day DESC);

-- A second small table holding the all-time archived total per family — denormalised
-- for O(1) lookups by the stats endpoint without scanning the daily log.
CREATE TABLE IF NOT EXISTS overlay_explorer_archive_totals (
  data_family              text        PRIMARY KEY,
  pruned_count             bigint      NOT NULL DEFAULT 0,
  pruned_confirmed_count   bigint      NOT NULL DEFAULT 0,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ─── AFTER DELETE trigger ────────────────────────────────────────────────────
-- Maintains:
--   1. overlay_explorer_stats          (total_readings, total_confirmed)
--   2. overlay_explorer_family_counts  (per-family live count)
--   3. overlay_explorer_location_keys  (per-location live count + GC at 0)
--   4. overlay_explorer_archive_log    (per-day per-family pruned aggregate)
--   5. overlay_explorer_archive_totals (per-family all-time pruned aggregate)

CREATE OR REPLACE FUNCTION oer_after_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 1. Live-row totals
  UPDATE overlay_explorer_stats
     SET stat_value = GREATEST(0, stat_value - 1),
         updated_at = now()
   WHERE stat_key = 'total_readings';

  IF OLD.confirmed THEN
    UPDATE overlay_explorer_stats
       SET stat_value = GREATEST(0, stat_value - 1),
           updated_at = now()
     WHERE stat_key = 'total_confirmed';
  END IF;

  -- 2. Per-family live count
  UPDATE overlay_explorer_family_counts
     SET reading_count = GREATEST(0, reading_count - 1),
         updated_at = now()
   WHERE data_family = OLD.data_family;

  -- 3. Per-location live count + GC
  IF OLD.normalized_location IS NOT NULL AND OLD.normalized_location <> '' THEN
    UPDATE overlay_explorer_location_keys
       SET reading_count = GREATEST(0, reading_count - 1)
     WHERE normalized_location = OLD.normalized_location;

    DELETE FROM overlay_explorer_location_keys
     WHERE normalized_location = OLD.normalized_location
       AND reading_count <= 0;
  END IF;

  -- 4. Daily archive log (UTC bucket)
  INSERT INTO overlay_explorer_archive_log AS log (
    archive_day,
    data_family,
    pruned_count,
    pruned_confirmed_count,
    first_pruned_reading_ts,
    last_pruned_reading_ts,
    updated_at
  ) VALUES (
    (now() AT TIME ZONE 'UTC')::date,
    OLD.data_family,
    1,
    CASE WHEN OLD.confirmed THEN 1 ELSE 0 END,
    OLD.reading_ts,
    OLD.reading_ts,
    now()
  )
  ON CONFLICT (archive_day, data_family) DO UPDATE SET
    pruned_count = log.pruned_count + 1,
    pruned_confirmed_count = log.pruned_confirmed_count
      + CASE WHEN OLD.confirmed THEN 1 ELSE 0 END,
    first_pruned_reading_ts = LEAST(log.first_pruned_reading_ts, EXCLUDED.first_pruned_reading_ts),
    last_pruned_reading_ts  = GREATEST(log.last_pruned_reading_ts, EXCLUDED.last_pruned_reading_ts),
    updated_at = now();

  -- 5. All-time archive total (denormalised for O(1) read)
  INSERT INTO overlay_explorer_archive_totals AS tot (
    data_family,
    pruned_count,
    pruned_confirmed_count,
    updated_at
  ) VALUES (
    OLD.data_family,
    1,
    CASE WHEN OLD.confirmed THEN 1 ELSE 0 END,
    now()
  )
  ON CONFLICT (data_family) DO UPDATE SET
    pruned_count = tot.pruned_count + 1,
    pruned_confirmed_count = tot.pruned_confirmed_count
      + CASE WHEN OLD.confirmed THEN 1 ELSE 0 END,
    updated_at = now();

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_oer_after_delete ON overlay_explorer_readings;

CREATE TRIGGER trg_oer_after_delete
AFTER DELETE ON overlay_explorer_readings
FOR EACH ROW
EXECUTE FUNCTION oer_after_delete();

-- ─── Stats repair helper ─────────────────────────────────────────────────────
-- Recalculates the rollup tables from the live data.  Safe to call any time;
-- intended for one-shot repair after manual interventions or to recover from
-- historical drift before this trigger existed.  Does NOT touch the archive
-- log / totals (those track deletions only and cannot be reconstructed from
-- the live data once the rows have been pruned).

CREATE OR REPLACE FUNCTION oer_repair_rollups()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE overlay_explorer_stats
     SET stat_value = (SELECT COUNT(*) FROM overlay_explorer_readings),
         updated_at = now()
   WHERE stat_key = 'total_readings';

  UPDATE overlay_explorer_stats
     SET stat_value = (SELECT COUNT(*) FROM overlay_explorer_readings WHERE confirmed),
         updated_at = now()
   WHERE stat_key = 'total_confirmed';

  TRUNCATE overlay_explorer_family_counts;
  INSERT INTO overlay_explorer_family_counts (data_family, reading_count, updated_at)
  SELECT data_family, COUNT(*), now()
    FROM overlay_explorer_readings
   GROUP BY data_family;

  TRUNCATE overlay_explorer_location_keys;
  INSERT INTO overlay_explorer_location_keys
    (normalized_location, display_location, data_family, reading_count, last_reading_ts, avg_lat, avg_lon)
  SELECT normalized_location,
         COALESCE(MAX(location), normalized_location),
         (ARRAY_AGG(data_family ORDER BY reading_ts DESC))[1],
         COUNT(*),
         MAX(reading_ts),
         AVG(lat),
         AVG(lon)
    FROM overlay_explorer_readings
   WHERE normalized_location IS NOT NULL AND normalized_location <> ''
   GROUP BY normalized_location;
END;
$$;

-- ─── Retention helper indexes ────────────────────────────────────────────────
-- Composite index that exactly matches the retention scan predicate
-- (per-family, time-ordered, picking the oldest rows first).

CREATE INDEX IF NOT EXISTS oer_family_reading_ts_asc_idx
  ON overlay_explorer_readings(data_family, reading_ts ASC);

-- ─── UTXO blob compaction prerequisites ──────────────────────────────────────
-- raw_tx / beef are only needed while a UTXO is live spendable inventory.
-- Once removed = true, the spend has already happened and these blobs are
-- dead weight (frequently 200-2000 bytes per row, dominating table size).
-- The runtime path in lib/utxo-inventory.ts already guards against acquiring
-- removed rows (WHERE removed = false), so allowing NULL on spent rows is
-- provably safe.

ALTER TABLE overlay_admitted_utxos
  ALTER COLUMN raw_tx DROP NOT NULL;
-- beef is already nullable in 0010, no change needed there.

-- NOTE on one-shot compaction:
-- An earlier draft of this migration ran a single UPDATE here to NULL out
-- raw_tx / beef across every removed row.  On Supabase that update exceeds
-- the per-statement timeout once the table grows past a few hundred thousand
-- spent rows, which rolls back the entire migration.
--
-- Compaction is therefore handled out-of-band by:
--   1. scripts/sql/compact-spent-utxos.sql  (one-shot, batched, run manually
--      against Supabase to reclaim historical bytes after this migration is
--      applied; uses a PROCEDURE with COMMIT between batches so each batch
--      gets a fresh statement-timeout window).
--   2. lib/retention.ts                     (per-cycle, batched LIMIT-N
--      compaction inside the daily cron — keeps the table small forever
--      without ever issuing an unbounded UPDATE).

COMMIT;
