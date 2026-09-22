CREATE TABLE IF NOT EXISTS arc_broadcast_status (
  txid text PRIMARY KEY,
  tx_status text NOT NULL DEFAULT '',
  phase text NOT NULL,
  accepted_via text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arc_broadcast_status_phase_chk CHECK (
    phase IN ('rejected', 'orphan', 'pending', 'seen', 'mined', 'reorg')
  )
);

CREATE INDEX IF NOT EXISTS arc_broadcast_status_open_idx
  ON arc_broadcast_status (updated_at)
  WHERE phase IN ('orphan', 'pending', 'seen');
