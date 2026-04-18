import { NextResponse } from 'next/server'
import { workerQueue } from '@/lib/worker-queue'
import { calculateSourceHash } from '@/lib/repositories'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    const now = Date.now()
    const id = workerQueue.addToQueue({
      type: 'advanced',
      timestamp: now,
      location: 'Diagnostics City',
      measurement: { test: true, uv_index: 1, soil_moisture: 0.1, wildfire_risk: 1, environmental_quality_score: 0.1 },
      source_hash: calculateSourceHash({ diag: now }),
    } as any, 'high')
    return NextResponse.json({ success: true, id, timestamp: new Date().toISOString() })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}







