-- CREATE INDEX CONCURRENTLY must run outside an explicit transaction
-- (one statement per migrate round-trip).
--
-- The seismic dedup probe (hasSeismicTxId) filters on event_id:
--
--   SELECT txid FROM seismic_readings
--    WHERE event_id = $1
--      AND txid IS NOT NULL
--      AND txid NOT LIKE 'local_%'
--      AND txid NOT LIKE 'error_%'
--    LIMIT 1
--
-- `event_id` carried no index, so every probe was a parallel sequential scan
-- of the whole table (EXPLAIN ANALYZE confirmed: Parallel Seq Scan, 124,000
-- rows filtered to zero). pg_stat_user_tables reported 4,072,209 sequential
-- scans reading 173,511,443,541 tuples against a ~118k-row table, at a mean
-- 30.9 ms per probe over 1,585,222 calls. That is the largest single CPU
-- consumer identified on the instance.
--
-- Non-destructive: index creation only, no data is modified.

CREATE INDEX CONCURRENTLY IF NOT EXISTS seismic_readings_event_id_idx
  ON seismic_readings(event_id);
