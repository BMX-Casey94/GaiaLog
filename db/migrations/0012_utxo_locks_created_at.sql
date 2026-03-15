-- Add created_at to utxo_locks for compatibility with queries that ORDER BY created_at.
-- utxo_locks uses reserved_at; created_at is an alias for ordering/debugging.

BEGIN;

-- Add column if table exists (utxo_locks is created at runtime by ensureUtxoLocksTable)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'utxo_locks') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'utxo_locks' AND column_name = 'created_at') THEN
      ALTER TABLE utxo_locks ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'utxo_locks' AND column_name = 'reserved_at') THEN
        UPDATE utxo_locks SET created_at = reserved_at;
      END IF;
      CREATE INDEX IF NOT EXISTS utxo_locks_created_at_idx ON utxo_locks(created_at DESC);
    END IF;
  END IF;
END $$;

COMMIT;
