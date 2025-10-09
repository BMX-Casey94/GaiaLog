import { NextResponse } from 'next/server'
import { workerQueue } from '@/lib/worker-queue'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST() {
  try {
    const now = Date.now()
    const id = workerQueue.addToQueue({
      type: 'advanced',
      timestamp: now,
      location: 'Diagnostics City',
      measurement: { test: true, uv_index: 1, soil_moisture: 0.1, wildfire_risk: 1, environmental_quality_score: 0.1 },
      source_hash: Buffer.from(`diag:${now}`).toString('base64').slice(0, 32),
    } as any, 'high')
    return NextResponse.json({ success: true, id, timestamp: new Date().toISOString() })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}







