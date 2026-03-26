-- Inventory columns for overlay UTXOs.
-- Uses NOT NULL + DEFAULT so existing rows do not require a full-table rewrite (PG11+).
-- Only rows with :Wn in topic get a non-default wallet_index.

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS wallet_index smallint NOT NULL DEFAULT 0;

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS utxo_role text NOT NULL DEFAULT 'pool';

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS locked_by text;

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- Backfill only live spendable rows. Historical removed rows do not need a
-- wallet_index for runtime inventory acquisition, and touching them all is too
-- expensive on large production tables.
UPDATE overlay_admitted_utxos
   SET wallet_index = GREATEST(0, ((regexp_match(topic, ':W([0-9]+)$'))[1])::int - 1)
 WHERE removed = false
   AND topic ~ ':W[0-9]+$';

ALTER TABLE overlay_admitted_utxos
  ALTER COLUMN utxo_role SET DEFAULT 'pool';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'overlay_admitted_utxos_utxo_role_check'
  ) THEN
    ALTER TABLE overlay_admitted_utxos
      ADD CONSTRAINT overlay_admitted_utxos_utxo_role_check
      CHECK (utxo_role IN ('pool', 'reserve'));
  END IF;
END $$;
