import { NextResponse } from 'next/server'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { workerManager } from '@/lib/worker-threads'

export async function GET() {
  try {
    // Prefer cross-process status file written by worker runner, fallback to in-process
    try {
      const statusPath = path.join(os.tmpdir(), 'gaialog_worker_status.json')
      if (fs.existsSync(statusPath)) {
        const raw = fs.readFileSync(statusPath, 'utf8')
        const json = JSON.parse(raw)
        return NextResponse.json(json)
      }
    } catch {}

    // Fallback to in-process stats (will appear idle if workers are in a separate process)
    const fallbackStats = workerManager.getWorkerStats()
    return NextResponse.json({
      success: true,
      workers: fallbackStats,
      totalWorkers: fallbackStats.length,
      runningWorkers: fallbackStats.filter(w => w.isRunning).length
    })
  } catch (error) {
    console.error('Error fetching worker data:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to fetch worker data',
        workers: [],
        totalWorkers: 0,
        runningWorkers: 0
      },
      { status: 500 }
    )
  }
}

