-- CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block, and
-- scripts/migrate.ts sends a concurrent migration as a single statement because
-- a multi-statement string is wrapped in an implicit transaction. One statement
-- per file.
--
-- overlay_admitted_utxos_topic_removed_idx (topic, removed) is a leftmost prefix
-- of both overlay_admitted_utxos_topic_removed_admitted_idx (topic, removed,
-- admitted_at) and overlay_admitted_utxos_topic_removed_confirmed_idx (topic,
-- removed, confirmed), so any query it can serve is already served by one of
-- those two. idx_scan = 0, occupying 21 MB.
--
-- Restore with:
--   CREATE INDEX CONCURRENTLY overlay_admitted_utxos_topic_removed_idx
--     ON overlay_admitted_utxos(topic, removed);

DROP INDEX CONCURRENTLY IF EXISTS overlay_admitted_utxos_topic_removed_idx;
