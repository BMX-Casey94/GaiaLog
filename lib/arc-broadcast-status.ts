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

export async function getArcBroadcastPhase(txid: string): Promise<ArcPhase | null> {
  try {
    const result = await query<{ phase: ArcPhase }>(
      `SELECT phase FROM arc_broadcast_status WHERE txid = $1 LIMIT 1`,
      [txid],
    )
    const row = result.rows[0]
    if (!row) return null
    return row.phase
  } catch (error) {
    console.warn(
      `⚠️  arc_broadcast_status phase read failed for ${txid}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}
