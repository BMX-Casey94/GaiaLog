import { classifyArcTxStatus, type ArcPhase } from './arc-tx-status'
import { query } from './db'

export function buildArcStatusRow(
  txStatus: string | null | undefined,
  acceptedVia: string | null,
): {
  txStatus: string
  phase: ArcPhase
  acceptedVia: string | null
} {
  const normalized = txStatus == null ? '' : txStatus.trim()
  return {
    txStatus: normalized,
    phase: classifyArcTxStatus(normalized),
    acceptedVia,
  }
}

export async function upsertArcBroadcastStatus(input: {
  txid: string
  txStatus: string | null | undefined
  acceptedVia: string | null
}): Promise<void> {
  try {
    const row = buildArcStatusRow(input.txStatus, input.acceptedVia)
    await query(
      `INSERT INTO arc_broadcast_status (txid, tx_status, phase, accepted_via, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (txid) DO UPDATE SET
         tx_status = EXCLUDED.tx_status,
         phase = EXCLUDED.phase,
         accepted_via = EXCLUDED.accepted_via,
         updated_at = now()
       WHERE arc_broadcast_status.phase <> 'mined'
          OR EXCLUDED.phase IN ('mined', 'reorg')`,
      [input.txid, row.txStatus, row.phase, row.acceptedVia],
    )
  } catch (error) {
    console.warn(
      `⚠️  arc_broadcast_status upsert failed for ${input.txid}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
