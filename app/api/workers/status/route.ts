/**
 * Worker Status Endpoint
 * 
 * Provides detailed status information about all workers and queue.
 * Can optionally trigger auto-initialization if workers aren't running.
 */

import { NextResponse } from 'next/server'
import { getWorkerStatus, autoInitializeWorkers, areWorkersInitialized } from '@/lib/worker-auto-init'

export const dynamic = 'force-dynamic'

/**
 * GET handler - Return current worker status
 * Query params:
 *   - autoStart=true: Automatically start workers if not initialized
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const autoStart = searchParams.get('autoStart') === 'true'

    // Auto-start workers if requested and not initialized
    if (autoStart && !areWorkersInitialized()) {
      console.log('🚀 Auto-start requested, initializing workers...')
      await autoInitializeWorkers()
    }

    const status = getWorkerStatus()

    return NextResponse.json({
      success: true,
      status,
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error('❌ Error getting worker status:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}

