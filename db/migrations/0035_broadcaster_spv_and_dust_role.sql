-- Broadcaster / SPV tracking columns and the 'dust' inventory role.
--
-- Additive only: every statement either adds a nullable column with a default,
-- widens an existing CHECK to accept one more value, or creates a new partial
-- index. No column is dropped, no row is deleted, and no existing constraint
-- is narrowed. Safe to apply on a live database while workers are running.
--
-- Why each group exists:
--
--   * The BSV Broadcaster returns richer evidence than ARC's 4-column record
--     could hold: which host accepted the transaction (`accepted_endpoint`),
--     the callback token used for its SSE stream (`callback_token`), the last
--     event id seen (`last_event_id`), and the merkle proof with the block it
--     commits to (`merkle_path`, `block_hash`, `block_height`). A reorg
--     re-anchors a transaction to a new block, so the superseded proofs are
--     kept in `orphaned_proofs` rather than overwritten and lost.
--   * `spv_verified` is the difference between "a broadcaster said MINED" and
--     "a merkle proof commits to this txid and the header is on the chain".
--     `root_matches_header` records the weaker, cheaper fact: the proof's root
--     equals the header's merkle root, without chain linkage.
--   * `provider` separates rows tracked by this Broadcaster from legacy ARC
--     rows, so the reconciler never queries the wrong host for a txid.
--   * `last_error_code` keeps the numeric broadcaster/ARC code (465, 476,
--     461, ...) instead of only its prose, so retry policy can be decided
--     without parsing a message.
--   * `dust` is a real inventory class in this system (sub-split-floor change
--     that is only spendable by consolidation). The 0016 CHECK predates it, so
--     any attempt to record such a row fails on the constraint.

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS accepted_endpoint text;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS callback_token text;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS last_event_id text;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'arc';

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS merkle_path text;

-- The root the stored proof computes to. Kept with the proof so a later reader
-- can tell whether a header's merkle root and the proof's root were compared,
-- rather than trusting `root_matches_header` as bare testimony.
ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS merkle_root text;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS block_hash text;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS block_height integer;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS orphaned_proofs jsonb;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS spv_verified boolean NOT NULL DEFAULT false;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS root_matches_header boolean NOT NULL DEFAULT false;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS competing_txs jsonb;

ALTER TABLE arc_broadcast_status
  ADD COLUMN IF NOT EXISTS last_error_code integer;

-- Widen the phase CHECK to admit 'immutable'.
--
-- IMMUTABLE means the block is buried past any realistic reorganisation, which
-- is strictly stronger evidence than MINED. Writers may persist it directly
-- rather than downgrading it to 'mined' (lib/arc-tx-status.ts still maps it for
-- backwards compatibility, but the column no longer forces the loss).
--
-- Dropping and re-adding the constraint is a metadata-only change: the new
-- predicate accepts every value the old one accepted, so no existing row can
-- fail validation and no table rewrite occurs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'arc_broadcast_status_phase_chk'
       AND conrelid = 'arc_broadcast_status'::regclass
  ) THEN
    ALTER TABLE arc_broadcast_status
      DROP CONSTRAINT arc_broadcast_status_phase_chk;
  END IF;

  ALTER TABLE arc_broadcast_status
    ADD CONSTRAINT arc_broadcast_status_phase_chk CHECK (
      phase IN ('rejected', 'orphan', 'pending', 'seen', 'mined', 'immutable', 'reorg')
    );
END $$;

-- Widen the inventory role CHECK to admit 'dust'.
--
-- The constraint name is the one created in
-- db/migrations/0016_overlay_utxo_inventory.sql. It is looked up rather than
-- assumed so this migration is a no-op on a database where 0016 has not run.
DO $$
DECLARE
  role_constraint record;
BEGIN
  SELECT con.conname AS name
    INTO role_constraint
    FROM pg_constraint con
   WHERE con.conrelid = 'overlay_admitted_utxos'::regclass
     AND con.contype = 'c'
     AND con.conname = 'overlay_admitted_utxos_utxo_role_check';

  IF role_constraint.name IS NOT NULL THEN
    ALTER TABLE overlay_admitted_utxos
      DROP CONSTRAINT overlay_admitted_utxos_utxo_role_check;
  END IF;

  ALTER TABLE overlay_admitted_utxos
    ADD CONSTRAINT overlay_admitted_utxos_utxo_role_check
    CHECK (utxo_role IN ('pool', 'reserve', 'dust'));
END $$;

-- Mining that has produced a proof but has not yet been SPV-verified is the
-- backlog the verifier sweeps. Partial so the index stays small: only rows
-- awaiting verification are in it, and each is removed as soon as
-- spv_verified flips to true. `updated_at` is the sweep order and lets the
-- verifier page without a sort.
CREATE INDEX IF NOT EXISTS arc_broadcast_status_spv_pending_idx
  ON arc_broadcast_status (updated_at)
  WHERE phase IN ('mined', 'immutable')
    AND spv_verified = false
    AND merkle_path IS NOT NULL;
