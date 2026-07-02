-- ─── Trigram index for location autocomplete ────────────────────────────────
-- The explorer autocomplete (lib/overlay-explorer-repository.ts →
-- getLocationSuggestions) filters overlay_explorer_location_keys with
--   normalized_location ILIKE '%<query>%'
-- which currently sequential-scans the table on every keystroke.  A GIN
-- trigram index makes these substring matches index-backed.
--
-- Non-destructive: CREATE INDEX IF NOT EXISTS only; no data is modified.
--
-- NOTE ON APPLYING TO PRODUCTION:
-- This file uses plain CREATE INDEX inside a transaction so it is compatible
-- with migration runners.  If the table is large and you want to avoid
-- blocking writes during the build, apply the concurrent variant manually
-- instead (cannot run inside a transaction):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS oer_lockeys_trgm_idx
--     ON overlay_explorer_location_keys
--     USING gin (normalized_location gin_trgm_ops);

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS oer_lockeys_trgm_idx
  ON overlay_explorer_location_keys
  USING gin (normalized_location gin_trgm_ops);

COMMIT;
