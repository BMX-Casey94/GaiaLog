BEGIN;

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS wallet_index smallint;

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS utxo_role text;

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS locked_by text;

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

UPDATE overlay_admitted_utxos
   SET wallet_index = GREATEST(0, ((regexp_match(topic, ':W([0-9]+)$'))[1])::int - 1)
 WHERE wallet_index IS NULL
   AND topic ~ ':W[0-9]+$';

UPDATE overlay_admitted_utxos
   SET wallet_index = 0
 WHERE wallet_index IS NULL;

UPDATE overlay_admitted_utxos
   SET utxo_role = 'pool'
 WHERE utxo_role IS NULL
    OR btrim(utxo_role) = '';

UPDATE overlay_admitted_utxos
   SET locked = false,
       locked_by = NULL,
       locked_at = NULL
 WHERE locked = true;

ALTER TABLE overlay_admitted_utxos
  ALTER COLUMN wallet_index SET NOT NULL;

ALTER TABLE overlay_admitted_utxos
  ALTER COLUMN utxo_role SET NOT NULL;

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

CREATE INDEX IF NOT EXISTS overlay_admitted_utxos_inventory_idx
  ON overlay_admitted_utxos(wallet_index, utxo_role, removed, locked, confirmed, satoshis, admitted_at);

CREATE INDEX IF NOT EXISTS overlay_admitted_utxos_wallet_outpoint_idx
  ON overlay_admitted_utxos(wallet_index, txid, vout);

COMMIT;
