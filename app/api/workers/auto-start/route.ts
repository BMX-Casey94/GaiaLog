/**
 * Worker Auto-Start Endpoint
 * 
 * This endpoint automatically initializes and starts all workers.
 * It's designed to be called on first request or via a warmup mechanism.
 * Safe to call multiple times - will only initialize once.
 */

import { NextResponse } from 'next/server'
import { autoInitializeWorkers, getWorkerStatus } from '@/lib/worker-auto-init'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

// This makes the route dynamic so it runs on every request in serverless
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET handler - Initialize workers and return status
 */
export async function GET(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    const result = await autoInitializeWorkers()
    
    if (result.success) {
      return NextResponse.json({
        success: true,
        message: result.message,
        status: result.status,
        timestamp: new Date().toISOString()
      })
    } else {
      return NextResponse.json(
        {
          success: false,
          message: result.message,
          error: result.error,
          timestamp: new Date().toISOString()
        },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('❌ Error in auto-start endpoint:', error)
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to start workers',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}

/**
 * POST handler - Same as GET for flexibility
 */
export async function POST(request: Request) {
  return GET(request)
}

