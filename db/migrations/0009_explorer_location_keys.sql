-- Fast unique location counter for Data Explorer hero cards.
-- This avoids expensive COUNT(DISTINCT ...) scans on explorer_readings.

BEGIN;

CREATE TABLE IF NOT EXISTS explorer_location_keys (
  normalized_location text PRIMARY KEY,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);

-- Backfill from existing explorer rows.
INSERT INTO explorer_location_keys (normalized_location, first_seen, last_seen)
SELECT
  lower(btrim(location)) AS normalized_location,
  min("timestamp") AS first_seen,
  max("timestamp") AS last_seen
FROM explorer_readings
WHERE location IS NOT NULL
  AND btrim(location) <> ''
GROUP BY lower(btrim(location))
ON CONFLICT (normalized_location) DO UPDATE
SET
  first_seen = LEAST(explorer_location_keys.first_seen, EXCLUDED.first_seen),
  last_seen = GREATEST(explorer_location_keys.last_seen, EXCLUDED.last_seen);

CREATE OR REPLACE FUNCTION upsert_explorer_location_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  normalized text;
  reading_ts timestamptz;
BEGIN
  IF NEW.location IS NULL OR btrim(NEW.location) = '' THEN
    RETURN NEW;
  END IF;

  normalized := lower(btrim(NEW.location));
  reading_ts := COALESCE(NEW."timestamp", now());

  INSERT INTO explorer_location_keys (normalized_location, first_seen, last_seen)
  VALUES (normalized, reading_ts, reading_ts)
  ON CONFLICT (normalized_location) DO UPDATE
  SET last_seen = GREATEST(explorer_location_keys.last_seen, EXCLUDED.last_seen);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_explorer_location_key_upsert ON explorer_readings;

CREATE TRIGGER trg_explorer_location_key_upsert
AFTER INSERT OR UPDATE OF location, "timestamp" ON explorer_readings
FOR EACH ROW
EXECUTE FUNCTION upsert_explorer_location_key();

COMMIT;
