-- CREATE INDEX CONCURRENTLY must run outside an explicit transaction
-- (one statement per migrate round-trip).
--
-- Partial index keeps the hot path focused on live, unlocked, currently-acquirable
-- inventory only. Complements overlay_admitted_utxos_inventory_idx, which does not
-- include acquirable_at and would otherwise have to filter post-scan when the
-- propagation grace temporarily holds back a small fraction of pending change
-- outputs.

CREATE INDEX CONCURRENTLY IF NOT EXISTS overlay_admitted_utxos_acquire_ready_idx
  ON overlay_admitted_utxos(wallet_index, utxo_role, satoshis, acquirable_at)
  WHERE removed = false AND locked = false;
