-- Per-row propagation grace for newly admitted change/split outputs.
--
-- A fresh change UTXO becomes acquirable only once its parent transaction has
-- had time to propagate across all ARC relays. Without this, a second worker
-- can grab the change before the parent reaches every relay, producing an
-- ARC 460 "parent transaction not found" rejection on the child broadcast.
--
-- Backwards-compatible: NOT NULL + DEFAULT now() means existing rows get a
-- past timestamp at migration time and remain immediately acquirable.
-- Only new admissions emitted by consumeAndAdmitChange / admitSplitOutputs
-- will set a future timestamp.

ALTER TABLE overlay_admitted_utxos
  ADD COLUMN IF NOT EXISTS acquirable_at timestamptz NOT NULL DEFAULT now();
