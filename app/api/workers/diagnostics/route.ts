import { NextResponse } from 'next/server'
import { workerQueue } from '@/lib/worker-queue'
import { workerManager } from '@/lib/worker-threads'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const stats = workerQueue.getQueueStats()
    const status = workerQueue.getQueueStatus()
    const gate = workerQueue.getGateInfo()
    const workers = workerManager.getWorkerStats()

    return NextResponse.json({
      success: true,
      queue: { stats, status, gate },
      workers,
      timestamp: new Date().toISOString()
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}







