import { NextResponse } from 'next/server'
import { ensureConnected, getDbInfo, query } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const info = getDbInfo()
    await ensureConnected()
    const txLog = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM tx_log`)
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

