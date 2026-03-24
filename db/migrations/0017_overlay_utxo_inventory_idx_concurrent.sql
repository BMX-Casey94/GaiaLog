-- CREATE INDEX CONCURRENTLY must run outside an explicit transaction (one statement per migrate round-trip).

CREATE INDEX CONCURRENTLY IF NOT EXISTS overlay_admitted_utxos_inventory_idx
  ON overlay_admitted_utxos(wallet_index, utxo_role, removed, locked, confirmed, satoshis, admitted_at);
