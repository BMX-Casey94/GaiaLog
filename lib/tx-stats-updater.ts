import { query } from './db'

let lastAnalyzeAt = 0
const ANALYZE_INTERVAL_MS = Number(process.env.TXLOG_ANALYZE_INTERVAL_MS || 30 * 60 * 1000) // default 30 minutes

/**
 * Manually updates tx_log statistics so reltuples reflects current count
 * Should be called periodically (e.g., every 30 seconds) by workers
 * This provides near real-time count updates without the cost of COUNT(*)
 */
export async function updateTxLogStats() {
  // Best-effort ANALYZE on a coarse interval; ignore timeouts to avoid noisy logs
  if (Date.now() - lastAnalyzeAt >= ANALYZE_INTERVAL_MS) {
    try {
      await query('ANALYZE tx_log')
      lastAnalyzeAt = Date.now()
    } catch {
      // Ignore errors (e.g., statement timeout or locks); we'll still return an estimate below
    }
  }

  try {
    const result = await query<{ reltuples: number }>(
      `SELECT reltuples::bigint as reltuples FROM pg_class WHERE relname = 'tx_log'`
    )
    const count = result.rows[0]?.reltuples || 0
    console.log(`📊 Updated tx_log stats: ${count.toLocaleString()} transactions`)
    return count
  } catch (err) {
    console.error('Failed to update tx_log stats:', err)
    return null
  }
}


