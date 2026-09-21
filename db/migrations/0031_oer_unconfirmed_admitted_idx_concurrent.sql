-- CREATE INDEX CONCURRENTLY must run outside an explicit transaction
-- (one statement per migrate round-trip).
--
-- The confirmation worker now chases unconfirmed explorer rows by *broadcast*
-- time (`admitted_at`) rather than sensor time (`reading_ts`). The distinction
-- caused a silent, permanent confirmation gap in production:
--
--   `reading_ts` is the reading's own timestamp, and it can lag `admitted_at`
--   by hours when historical readings are ingested in a burst — or hold a
--   sentinel value entirely (observed: 2007-11-07). A row broadcast at 17:03
--   carrying reading_ts=07:18 was already 9.7 hours "old" at insert time, so
--   it satisfied neither
--     reading_ts > now() - 2h        (the primary chase window), nor
--     reading_ts <= now() - 72h      (the catch-up floor).
--   It was invisible to both windows and could never be confirmed, which is
--   how 4.2M rows accumulated at confirmed = false while their transactions
--   were mined long ago.
--
-- Partial index matching the new predicate exactly. Unlike the old
-- oer_unconfirmed_ts_txid_idx it is single-column (~4.3M entries), because the
-- worker only ever asks for the oldest or newest N within a time range.
--
-- oer_unconfirmed_ts_txid_idx is deliberately LEFT IN PLACE: it backs the
-- (reading_ts ASC, txid ASC) keyset pagination in
-- scripts/backfill-explorer-confirmations.ts. Dropping it would reintroduce
-- the 15–18s sequential scan that migration 0023 was written to remove.

CREATE INDEX CONCURRENTLY IF NOT EXISTS oer_unconfirmed_admitted_idx
  ON overlay_explorer_readings (admitted_at ASC)
  WHERE confirmed = false;
