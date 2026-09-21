-- Per-table autovacuum tuning for the three tables carrying real dead-tuple bloat.
--
-- The instance-wide autovacuum_vacuum_scale_factor is 0.2, so autovacuum only
-- fires once dead tuples reach 20% of the live row count. For tx_log (7.77M live
-- rows) that means ~1.55M dead tuples are required before it triggers. Measured
-- state on 2026-09-21:
--
--   tx_log                     7,766,843 live / 1,335,201 dead (14.7%)  autovacuum_count 0, never vacuumed
--   overlay_explorer_readings  5,828,971 live /   761,744 dead (11.6%)  last autovacuum 2026-08-11
--   overlay_admitted_utxos     1,311,243 live /   114,449 dead ( 8.0%)  last autovacuum 2026-08-11
--
-- tx_log sat just under its trigger and has therefore never been vacuumed at
-- all, so its dead tuples are never reclaimed and every sequential scan reads
-- them. overlay_admitted_utxos recorded 909,992 sequential scans reading
-- 48,354,823,450 tuples against a 1.3M-row table.
--
-- Lowering the scale factor on these tables only makes autovacuum fire on them;
-- no other table's behaviour changes. The thresholds are deliberately set so a
-- small absolute dead count also triggers, because these tables are read
-- frequently enough that a 20%-of-table trigger is far too coarse.
--
-- worker_queue is included because it churns continuously (14,990,396 inserts
-- and 97,669,939 updates recorded) and is the table every worker touches on
-- boot. It is small now, so a low threshold is cheap.
--
-- cost_delay is deliberately NOT overridden. This instance is IO-constrained
-- (a 4-buffer index probe took 665 ms), so an unthrottled vacuum could saturate
-- storage and reproduce the statement timeouts this work is fixing.
--
-- Non-destructive: storage parameters only, no data is modified. Revert with
-- ALTER TABLE <name> RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold).

ALTER TABLE tx_log SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 2500
);

ALTER TABLE overlay_explorer_readings SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 2500
);

ALTER TABLE overlay_admitted_utxos SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 2000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 1000
);

ALTER TABLE worker_queue SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500
);
