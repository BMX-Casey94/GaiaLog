/**
 * Warmup Endpoint
 * 
 * This endpoint is designed to be called immediately after deployment
 * to "warm up" the serverless functions and start all workers.
 * 
 * You can call this manually or set it as a Vercel deployment hook.
 */

import { NextResponse } from 'next/server'
import { autoInitializeWorkers } from '@/lib/worker-auto-init'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Allow up to 60 seconds for warmup

export async function GET(request: Request) {
  const startTime = Date.now()
  const denied = requireInternalApiAccess(request)
  if (denied) return denied
  
  try {
    console.log('🔥 Warming up application...')
    
    // Initialize all workers
    const result = await autoInitializeWorkers()
    
    const duration = Date.now() - startTime
    
    if (result.success) {
      console.log(`✅ Warmup completed in ${duration}ms`)
      
      return NextResponse.json({
        success: true,
        message: 'Application warmed up successfully',
        duration: `${duration}ms`,
        status: result.status,
        timestamp: new Date().toISOString()
      })
    } else {
      console.error(`❌ Warmup failed after ${duration}ms`)
      
      return NextResponse.json(
        {
          success: false,
          message: 'Warmup failed',
          duration: `${duration}ms`,
          error: result.error,
          timestamp: new Date().toISOString()
        },
        { status: 500 }
      )
    }
  } catch (error) {
    const duration = Date.now() - startTime
    console.error('❌ Warmup error:', error)
    
    return NextResponse.json(
      {
        success: false,
        message: 'Warmup error',
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  return GET(request)
}

