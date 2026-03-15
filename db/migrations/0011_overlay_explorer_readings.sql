BEGIN;

-- ─── Overlay Explorer Readings ───────────────────────────────────────────────
-- Purpose-built read model for the /explorer page.  Replaces the ad-hoc
-- explorer_readings table with a schema that is optimised for the four actual
-- query workloads: recent feed, filtered search, location autocomplete, and
-- hero stats.
--
-- Data is owned by the overlay ingest pipeline.  Writes come from:
--   1. Local accepted broadcasts  (lib/blockchain.ts)
--   2. Live history ingestion     (lib/junglebus.ts)
--   3. Historical backfill        (scripts/backfill-explorer.ts)
--   4. Bulk seed from legacy      (scripts/seed-overlay-explorer.ts)

CREATE TABLE IF NOT EXISTS overlay_explorer_readings (
  txid              text        PRIMARY KEY,
  data_family       text        NOT NULL,
  provider_id       text,
  dataset_id        text,
  location          text,
  normalized_location text,
  lat               double precision,
  lon               double precision,
  reading_ts        timestamptz NOT NULL,
  block_height      integer     NOT NULL DEFAULT 0,
  block_time        timestamptz,
  confirmed         boolean     NOT NULL DEFAULT false,
  metrics_preview   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  admitted_at       timestamptz NOT NULL DEFAULT now()
);

-- Recent feed: ORDER BY reading_ts DESC LIMIT N
CREATE INDEX IF NOT EXISTS oer_reading_ts_idx
  ON overlay_explorer_readings(reading_ts DESC);

-- Type-filtered feed
CREATE INDEX IF NOT EXISTS oer_family_ts_idx
  ON overlay_explorer_readings(data_family, reading_ts DESC);

-- Location search (trigram)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS oer_location_trgm_idx
  ON overlay_explorer_readings
  USING gin (normalized_location gin_trgm_ops);

-- Block-height ordering
CREATE INDEX IF NOT EXISTS oer_block_height_idx
  ON overlay_explorer_readings(block_height DESC);

-- Confirmed filter
CREATE INDEX IF NOT EXISTS oer_confirmed_ts_idx
  ON overlay_explorer_readings(confirmed, reading_ts DESC);

-- ─── Pre-computed Stats Rollup ───────────────────────────────────────────────
-- Trigger-maintained so hero stats never need a full table scan.

CREATE TABLE IF NOT EXISTS overlay_explorer_stats (
  stat_key    text PRIMARY KEY,
  stat_value  bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO overlay_explorer_stats (stat_key, stat_value)
VALUES
  ('total_readings', 0),
  ('total_confirmed', 0)
ON CONFLICT (stat_key) DO NOTHING;

-- ─── Per-family count rollup ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS overlay_explorer_family_counts (
  data_family text PRIMARY KEY,
  reading_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Location keys (same pattern as migration 0009) ──────────────────────────

CREATE TABLE IF NOT EXISTS overlay_explorer_location_keys (
  normalized_location text PRIMARY KEY,
  display_location    text NOT NULL,
  data_family         text,
  reading_count       bigint NOT NULL DEFAULT 1,
  last_reading_ts     timestamptz NOT NULL DEFAULT now(),
  avg_lat             double precision,
  avg_lon             double precision
);

CREATE INDEX IF NOT EXISTS oer_lockeys_count_idx
  ON overlay_explorer_location_keys(reading_count DESC);

-- ─── Trigger: maintain stats on INSERT ───────────────────────────────────────

CREATE OR REPLACE FUNCTION oer_after_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Total readings
  UPDATE overlay_explorer_stats
     SET stat_value = stat_value + 1, updated_at = now()
   WHERE stat_key = 'total_readings';

  -- Confirmed count
  IF NEW.confirmed THEN
    UPDATE overlay_explorer_stats
       SET stat_value = stat_value + 1, updated_at = now()
     WHERE stat_key = 'total_confirmed';
  END IF;

  -- Family count
  INSERT INTO overlay_explorer_family_counts (data_family, reading_count, updated_at)
  VALUES (NEW.data_family, 1, now())
  ON CONFLICT (data_family) DO UPDATE
  SET reading_count = overlay_explorer_family_counts.reading_count + 1,
      updated_at = now();

  -- Location key
  IF NEW.normalized_location IS NOT NULL AND NEW.normalized_location <> '' THEN
    INSERT INTO overlay_explorer_location_keys
      (normalized_location, display_location, data_family, reading_count, last_reading_ts, avg_lat, avg_lon)
    VALUES
      (NEW.normalized_location, COALESCE(NEW.location, NEW.normalized_location), NEW.data_family, 1, NEW.reading_ts, NEW.lat, NEW.lon)
    ON CONFLICT (normalized_location) DO UPDATE
    SET reading_count = overlay_explorer_location_keys.reading_count + 1,
        last_reading_ts = GREATEST(overlay_explorer_location_keys.last_reading_ts, EXCLUDED.last_reading_ts),
        avg_lat = CASE
          WHEN EXCLUDED.avg_lat IS NOT NULL THEN
            (COALESCE(overlay_explorer_location_keys.avg_lat, 0) * (overlay_explorer_location_keys.reading_count - 1) + EXCLUDED.avg_lat)
            / overlay_explorer_location_keys.reading_count
          ELSE overlay_explorer_location_keys.avg_lat
        END,
        avg_lon = CASE
          WHEN EXCLUDED.avg_lon IS NOT NULL THEN
            (COALESCE(overlay_explorer_location_keys.avg_lon, 0) * (overlay_explorer_location_keys.reading_count - 1) + EXCLUDED.avg_lon)
            / overlay_explorer_location_keys.reading_count
          ELSE overlay_explorer_location_keys.avg_lon
        END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_oer_after_insert ON overlay_explorer_readings;

CREATE TRIGGER trg_oer_after_insert
AFTER INSERT ON overlay_explorer_readings
FOR EACH ROW
EXECUTE FUNCTION oer_after_insert();

-- ─── Trigger: maintain confirmed count on UPDATE ─────────────────────────────

CREATE OR REPLACE FUNCTION oer_after_confirm()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.confirmed AND NOT OLD.confirmed THEN
    UPDATE overlay_explorer_stats
       SET stat_value = stat_value + 1, updated_at = now()
     WHERE stat_key = 'total_confirmed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_oer_after_confirm ON overlay_explorer_readings;

CREATE TRIGGER trg_oer_after_confirm
AFTER UPDATE OF confirmed ON overlay_explorer_readings
FOR EACH ROW
EXECUTE FUNCTION oer_after_confirm();

COMMIT;
