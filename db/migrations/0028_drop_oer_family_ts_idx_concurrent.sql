-- CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block, and
-- scripts/migrate.ts sends a concurrent migration as a single statement because
-- psql/PostgreSQL wrap a multi-statement string in an implicit transaction.
-- Hence one statement per file.
--
-- oer_family_ts_idx (data_family, reading_ts DESC) duplicates
-- oer_family_reading_ts_asc_idx (data_family, reading_ts). A btree can be read
-- backwards at no extra cost, so the ASC index already satisfies
-- ORDER BY reading_ts DESC. The ASC index carries the scans; this DESC variant
-- showed idx_scan = 0 across six weeks while occupying 103 MB and being
-- maintained on every insert.
--
-- Restore with:
--   CREATE INDEX CONCURRENTLY oer_family_ts_idx
--     ON overlay_explorer_readings(data_family, reading_ts DESC);

DROP INDEX CONCURRENTLY IF EXISTS oer_family_ts_idx;
