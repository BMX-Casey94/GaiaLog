import { NextResponse } from 'next/server'
import { ensureConnected, getDbInfo, query } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const info = getDbInfo()
    await ensureConnected()
    // Planner statistics instead of COUNT(*): tx_log is tens of millions of
    // rows and an exact count takes ~50s of CPU per call. This endpoint is
    // polled by monitoring, and those stacked COUNT(*) scans were a primary
    // driver of sustained 100% database CPU. n_live_tup is continuously
    // maintained by the stats collector; reltuples is the ANALYZE fallback.
    const txLog = await query<{ c: string }>(
      `SELECT COALESCE(NULLIF(ps.n_live_tup, 0), pc.reltuples::bigint, 0)::text AS c
         FROM pg_class pc
         LEFT JOIN pg_stat_user_tables ps ON ps.relid = pc.oid
        WHERE pc.oid = 'tx_log'::regclass`,
    )
    let workerQueueCount = '0'
    let workerQueueBreakdown: Array<{ status: string; c: string; latest: string | null }> = []
    try {
      const q = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM worker_queue`)
      workerQueueCount = q.rows?.[0]?.c || '0'
      const breakdown = await query<{ status: string; c: string; latest: string | null }>(
        `SELECT status, COUNT(*)::text AS c, to_char(MAX(updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest
         FROM worker_queue
         GROUP BY status
         ORDER BY status`
      )
      workerQueueBreakdown = breakdown.rows || []
    } catch (e) {
      // worker_queue may not exist yet
      if (process.env.DEBUG_DB_WRITES === '1') {
        try { console.error('worker_queue count error:', e) } catch {}
      }
    }

    return NextResponse.json({
      success: true,
      db: info,
      counts: {
        tx_log: Number(txLog.rows?.[0]?.c || '0'),
        worker_queue: Number(workerQueueCount || '0'),
      },
      worker_queue_status: workerQueueBreakdown,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}

