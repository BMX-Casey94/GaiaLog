import { query } from './db'

/**
 * Manually updates tx_log statistics so reltuples reflects current count
 * Should be called periodically (e.g., every 30 seconds) by workers
 * This provides near real-time count updates without the cost of COUNT(*)
 */
export async function updateTxLogStats() {
  try {
    await query('ANALYZE tx_log')
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


