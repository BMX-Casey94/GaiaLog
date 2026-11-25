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

async function main(): Promise<void> {
  const pool = createPool()
  try {
    const inventory = await pool.query(`
      SELECT wallet_index,
             COUNT(*) FILTER (WHERE removed = false AND locked = false AND utxo_role = 'pool' AND acquirable_at <= now() AND satoshis >= 135)::int AS ready_pool_135,
             COALESCE(SUM(satoshis) FILTER (WHERE removed = false AND locked = false AND utxo_role = 'pool' AND acquirable_at <= now() AND satoshis >= 135), 0)::bigint AS ready_pool_sats,
             COALESCE(MAX(satoshis) FILTER (WHERE removed = false AND locked = false AND utxo_role = 'pool' AND acquirable_at <= now()), 0)::bigint AS max_ready_pool,
             COUNT(*) FILTER (WHERE removed = false AND locked = false AND utxo_role = 'pool' AND acquirable_at = 'infinity')::int AS parked_pool,
             COALESCE(SUM(satoshis) FILTER (WHERE removed = false AND locked = false AND utxo_role = 'pool' AND acquirable_at = 'infinity'), 0)::bigint AS parked_pool_sats,
             COUNT(*) FILTER (WHERE removed = false)::int AS total_live,
             COALESCE(SUM(satoshis) FILTER (WHERE removed = false), 0)::bigint AS total_live_sats
        FROM overlay_admitted_utxos
       GROUP BY wallet_index
       ORDER BY wallet_index
    `)

    console.log('\n=== Overlay UTXO Inventory ===')
    console.table(inventory.rows)

    const queue = await pool.query(`
      SELECT phase,
             COUNT(*)::int AS rows,
             MAX(updated_at) AS newest,
             COUNT(*) FILTER (WHERE updated_at > now() - interval '10 minutes')::int AS touched_last_10m
        FROM arc_broadcast_status
       WHERE provider = 'broadcaster'
         AND phase IN ('pending', 'seen', 'rejected', 'orphan', 'reorg')
       GROUP BY phase
       ORDER BY phase
    `)

    console.log('\n=== Broadcaster Status Queue ===')
    console.table(queue.rows)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
