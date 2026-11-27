-- Keep reorg rows in the poller's index. A transaction mined in a stale
-- block can be mined again; the poller must still be able to see MINED
-- and make its change spendable. The table is new in 0032, so replacing
-- the partial index here is a short lock, not a rewrite of explorer data.

DROP INDEX IF EXISTS arc_broadcast_status_open_idx;

CREATE INDEX arc_broadcast_status_open_idx
  ON arc_broadcast_status (updated_at)
  WHERE phase IN ('orphan', 'pending', 'seen', 'reorg');
