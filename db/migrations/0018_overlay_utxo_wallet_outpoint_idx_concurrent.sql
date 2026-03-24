-- Second concurrent index (separate file so each runs in its own autocommit round-trip).

CREATE INDEX CONCURRENTLY IF NOT EXISTS overlay_admitted_utxos_wallet_outpoint_idx
  ON overlay_admitted_utxos(wallet_index, txid, vout);
