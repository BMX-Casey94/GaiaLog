-- CREATE INDEX CONCURRENTLY must run outside an explicit transaction
-- (one statement per migrate round-trip).
--
-- Partial index for reverse-lookup of spent inputs when a broadcast is
-- rejected and its inputs must be released (sse-subscriber, reconcile-poll,
-- arc-status-poller). Without this index, `WHERE spending_txid = $1` forces
-- a full sequential scan of overlay_admitted_utxos, hitting the statement
-- timeout on every rejected SSE event and stalling the entire status stream.

CREATE INDEX CONCURRENTLY IF NOT EXISTS overlay_admitted_utxos_spending_txid_idx
  ON overlay_admitted_utxos (spending_txid)
  WHERE spending_txid IS NOT NULL;
