-- CREATE INDEX CONCURRENTLY must run outside an explicit transaction (one statement per migrate round-trip).
-- Partial index keeps the hot path focused on live spendable inventory only.

CREATE INDEX CONCURRENTLY IF NOT EXISTS overlay_admitted_utxos_inventory_idx
  ON overlay_admitted_utxos(wallet_index, utxo_role, locked, confirmed, satoshis, admitted_at)
  WHERE removed = false;
