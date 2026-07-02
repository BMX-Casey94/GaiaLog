import { query } from './db'

let lastAnalyzeAt = 0
// Manual ANALYZE is now opt-in. pg_stat_user_tables.n_live_tup is maintained
// continuously by the statistics collector without any ANALYZE, and autovacuum
// autoanalyzes tx_log on its own schedule. The previous behaviour (ANALYZE
// tx_log every 30 minutes) stacked concurrent multi-minute ANALYZE passes on a
// table with tens of millions of rows: node-postgres query timeouts abandon
// the client call while the SERVER keeps scanning, and we observed 4+
// simultaneous ANALYZE tx_log backends pinning the database CPU.
const ANALYZE_INTERVAL_MS = Number(process.env.TXLOG_ANALYZE_INTERVAL_MS || 0) // 0 = disabled

/**
 * Reports the tx_log row estimate using planner statistics (no table scan).
 * Called periodically by workers for the status log line.
 */
export async function updateTxLogStats() {
  if (ANALYZE_INTERVAL_MS > 0 && Date.now() - lastAnalyzeAt >= ANALYZE_INTERVAL_MS) {
    // Gate BEFORE issuing the command: even if the ANALYZE fails or times out
    // client-side, the server-side pass is still running — re-issuing sooner
    // only stacks another one.
    lastAnalyzeAt = Date.now()
    try {
      await query('ANALYZE tx_log')
    } catch {
      // Ignore errors (e.g. statement timeout); the estimate below still works.
    }
  }

  try {
    const result = await query<{ estimate: string }>(
      `SELECT COALESCE(NULLIF(ps.n_live_tup, 0), pc.reltuples::bigint, 0)::text AS estimate
         FROM pg_class pc
         LEFT JOIN pg_stat_user_tables ps ON ps.relid = pc.oid
        WHERE pc.oid = 'tx_log'::regclass`,
    )
    const count = Number(result.rows[0]?.estimate || 0)
    console.log(`📊 Updated tx_log stats: ${count.toLocaleString()} transactions`)
    return count
  } catch (err) {
    console.error('Failed to update tx_log stats:', err)
    return null
  }
}
