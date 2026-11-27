-- Supports location pages: rows filtered by normalized_location and ordered by
-- reading_ts.
--
-- Existing indexes do not serve this shape. EXPLAIN confirmed that a trigram GIN
-- index on normalized_location was chosen for an equality predicate, which is
-- the wrong access method; (data_family, reading_ts) cannot serve a location
-- predicate; and the retention index is ordered by reading_ts ASC.
--
-- A three-column variant adding data_family was considered and rejected: the
-- page query filters families with `data_family <> ALL(...)`, an inequality the
-- planner cannot seek on, so the extra column would add write cost without
-- changing the plan. Location pages exclude only a small family, so filtering
-- the location's rows as they are read is cheap.
--
-- CONCURRENTLY so the build does not lock writes from the overlay ingest
-- pipeline. Single statement: scripts/migrate.ts detects CONCURRENTLY by
-- content and sends these files outside a transaction block.

CREATE INDEX CONCURRENTLY IF NOT EXISTS oer_location_ts_idx
  ON overlay_explorer_readings(normalized_location, reading_ts DESC);
