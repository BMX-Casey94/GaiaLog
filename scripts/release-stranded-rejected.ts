import dotenv from 'dotenv'
import path from 'path'
import { Pool } from 'pg'

dotenv.config({ path: path.join(process.cwd(), '.env'), override: true })

function createPool(): Pool {
  const host = process.env.PGHOST || 'localhost'
  const isSupabase = host.includes('supabase.co') || host.includes('pooler.supabase')
  const isSupabasePooler = host.includes('pooler.supabase')
  const requestedPort = Number(process.env.PGPORT || 0)
  const forceSessionMode = process.env.PG_FORCE_SESSION_MODE === 'true'
  const port =
    isSupabasePooler && !forceSessionMode && (!requestedPort || requestedPort === 5432)
      ? 6543
      : requestedPort || 5432

  return new Pool({
    host,
    port,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'postgres',
    ssl: isSupabase ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 15_000,
  })
}

interface CandidateRow {
  txid: string
  inputs_spent: number
  inputs_sats: string
  live_outputs: number
  removed_outputs: number
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const pool = createPool()

  try {
    const candidates = await pool.query<CandidateRow>(`
      WITH spent_inputs AS (
        SELECT spending_txid AS txid,
               COUNT(*)::int AS inputs_spent,
               COALESCE(SUM(satoshis), 0)::bigint AS inputs_sats
          FROM overlay_admitted_utxos
         WHERE removed = true
           AND spending_txid IS NOT NULL
         GROUP BY spending_txid
      ),
      tx_outputs AS (
        SELECT txid,
               COUNT(*) FILTER (WHERE removed = false)::int AS live_outputs,
               COUNT(*) FILTER (WHERE removed = true)::int AS removed_outputs
          FROM overlay_admitted_utxos
         GROUP BY txid
      )
      SELECT s.txid,
             si.inputs_spent,
             si.inputs_sats,
             COALESCE(o.live_outputs, 0)::int AS live_outputs,
             COALESCE(o.removed_outputs, 0)::int AS removed_outputs
        FROM arc_broadcast_status s
        JOIN spent_inputs si ON si.txid = s.txid
        LEFT JOIN tx_outputs o ON o.txid = s.txid
       WHERE s.provider = 'broadcaster'
         AND s.phase = 'rejected'
         AND s.tx_status = 'REJECTED'
         AND s.block_height IS NULL
         AND s.block_hash IS NULL
         AND COALESCE(o.removed_outputs, 0) = 0
       ORDER BY s.txid
    `)

    const rows = candidates.rows
    const totalInputs = rows.reduce((sum, r) => sum + r.inputs_spent, 0)
    const totalSats = rows.reduce((sum, r) => sum + Number(r.inputs_sats), 0)

    console.log(
      `Found ${rows.length} stranded rejected broadcaster tx(s) with ${totalInputs} spent input(s) (${totalSats} sats) and 0 spent outputs.`,
    )

    if (!apply) {
      console.log('Dry-run only. Re-run with --apply to release these inputs.')
      return
    }

    let released = 0
    let skipped = 0

    for (const row of rows) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL statement_timeout = 15000')

        const outputs = await client.query<{ removed: boolean }>(
          `SELECT removed
             FROM overlay_admitted_utxos
            WHERE txid = $1
            FOR UPDATE`,
          [row.txid],
        )

        if ((outputs.rows ?? []).some((o) => o.removed === true)) {
          await client.query('ROLLBACK')
          skipped++
          continue
        }

        await client.query(
          `SELECT 1
             FROM overlay_admitted_utxos
            WHERE spending_txid = $1
              AND removed = true
            FOR UPDATE`,
          [row.txid],
        )

        await client.query(
          `UPDATE overlay_admitted_utxos
              SET removed = true,
                  removed_at = now(),
                  spending_txid = 'broadcaster-rejected'
            WHERE txid = $1
              AND removed = false`,
          [row.txid],
        )

        await client.query(
          `UPDATE overlay_admitted_utxos
              SET removed = false,
                  removed_at = NULL,
                  spending_txid = NULL,
                  locked = false,
                  locked_by = NULL,
                  locked_at = NULL,
                  acquirable_at = now()
            WHERE spending_txid = $1
              AND removed = true`,
          [row.txid],
        )

        await client.query('COMMIT')
        released++
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        console.warn(`Failed to release ${row.txid.substring(0, 12)}…:`, err)
      } finally {
        client.release()
      }

      await pool
        .query(
          `UPDATE tx_log
              SET status = 'failed',
                  error = 'broadcaster-rejected',
                  onchain_at = NULL
            WHERE txid = $1
              AND status <> 'confirmed'`,
          [row.txid],
        )
        .catch(() => {})
    }

    console.log(`Done. Released ${released} tx(s), skipped ${skipped} tx(s).`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
