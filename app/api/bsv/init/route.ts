import { NextResponse } from 'next/server'
import { autoInitializeWorkers } from '@/lib/worker-auto-init'

/**
 * BSV Initialization Endpoint
 * 
 * This endpoint initializes all BSV services and workers.
 * Now uses the centralized auto-initialization module for consistency.
 */
export async function POST() {
  try {
    console.log('🔄 Initializing BSV services...')
    
    // Use the centralized auto-initialization module
    const result = await autoInitializeWorkers()
    
    if (result.success) {
    console.log('✅ BSV services initialization completed')
      console.log('📊 Final Status:', result.status)

    return NextResponse.json({
      success: true,
        message: result.message,
        status: result.status
      })
    } else {
      console.error('❌ BSV services initialization failed')
      
      return NextResponse.json(
        { 
          success: false, 
          error: 'Failed to initialize BSV services',
          details: result.error
        },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('❌ Error initializing BSV services:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to initialize BSV services',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
