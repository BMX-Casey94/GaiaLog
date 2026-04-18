-- ─── One-shot spent-UTXO blob compaction ────────────────────────────────────
--
-- NULLs raw_tx and beef on every overlay_admitted_utxos row that has already
-- been spent (removed = true).  Reclaims the bulk of the table's bytes
-- (typically 200-2000 bytes per row, dominating storage and egress).
--
-- Designed to survive Supabase's per-statement timeout: each batch is its
-- own UPDATE inside its own transaction, so the timeout window resets every
-- BATCH_SIZE rows.  Safe to interrupt at any point — the work already done
-- is committed, and re-running picks up exactly where the previous run
-- stopped (the WHERE clause filters out already-NULL rows).
--
-- USAGE (from the VPS, with $DATABASE_URL set):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/compact-spent-utxos.sql
--
-- Optional: override batch size by passing a psql variable, e.g.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v batch_size=2000 \
--        -f scripts/sql/compact-spent-utxos.sql
--
-- Notes:
--   * Procedure is created CONDITIONALLY in the public schema.  Re-creating
--     across runs is harmless (CREATE OR REPLACE).
--   * The CALL must be issued OUTSIDE any explicit BEGIN — the procedure
--     uses COMMIT between batches, which is only legal when the procedure
--     is invoked at top level (no enclosing transaction).
--   * Statement timeout is raised to 5 minutes per batch.  Each individual
--     batched UPDATE finishes in well under that on a healthy connection;
--     the cap exists only as a safety margin if the table is unusually wide.
--   * ANALYZE at the end refreshes planner stats so subsequent retention
--     scans / acquireInventoryUtxo lookups plan against the new row widths.

\set ON_ERROR_STOP on
\if :{?batch_size}
\else
  \set batch_size 5000
\endif

SET statement_timeout = '5min';

CREATE OR REPLACE PROCEDURE compact_spent_utxos_once(batch_size int DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  rows_done   int;
  total_done  bigint := 0;
  iter        int    := 0;
BEGIN
  LOOP
    iter := iter + 1;

    WITH batch AS (
      SELECT topic, txid, vout
        FROM overlay_admitted_utxos
       WHERE removed = true
         AND (raw_tx IS NOT NULL OR beef IS NOT NULL)
       LIMIT batch_size
    )
    UPDATE overlay_admitted_utxos u
       SET raw_tx = NULL,
           beef   = NULL
      FROM batch b
     WHERE u.topic = b.topic
       AND u.txid  = b.txid
       AND u.vout  = b.vout;

    GET DIAGNOSTICS rows_done = ROW_COUNT;
    total_done := total_done + rows_done;

    RAISE NOTICE 'batch=% rows=% running_total=%', iter, rows_done, total_done;

    -- Each batch is committed independently so Supabase's per-statement
    -- timeout applies only to the next UPDATE, not the whole job.  Also
    -- frees row-level locks promptly so live spends are not blocked.
    COMMIT;

    EXIT WHEN rows_done = 0;
  END LOOP;

  RAISE NOTICE 'compaction complete: % rows total in % batch(es)', total_done, iter;
END
$$;

CALL compact_spent_utxos_once(:batch_size);

ANALYZE overlay_admitted_utxos;
