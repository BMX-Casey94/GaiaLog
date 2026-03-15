BEGIN;

-- ─── Drop per-row trigger that ran COUNT(*) on every INSERT/UPDATE/DELETE ───
--
-- The trigger `trg_overlay_topic_counts_apply` fired `refresh_overlay_topic_counts`
-- FOR EACH ROW, causing a full table scan on overlay_admitted_utxos per mutation.
-- On bulk operations (e.g. a UTXO split producing 1600+ outputs), this meant
-- 1600+ sequential COUNT(*) scans within a single transaction, holding a DB
-- connection for minutes and exhausting the Supabase pooler connection limit
-- (`MaxClientsInSessionMode`).
--
-- The `refresh_overlay_topic_counts(topic)` function is retained so application
-- code can call it explicitly once per topic at the end of a transaction.

DROP TRIGGER IF EXISTS trg_overlay_topic_counts_apply ON overlay_admitted_utxos;
DROP FUNCTION IF EXISTS overlay_topic_counts_apply();

COMMIT;
