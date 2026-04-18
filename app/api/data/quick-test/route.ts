import { NextResponse } from 'next/server'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

export async function GET(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    console.log('🧪 Quick test endpoint called')
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      message: 'Quick test endpoint working!',
      status: 'Server is responding correctly'
    })

  } catch (error) {
    console.error('❌ Error in quick test:', error)
    
    return NextResponse.json(
      { 
        error: 'Quick test failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    console.log('🧪 Quick test POST endpoint called')
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      message: 'Quick test POST endpoint working!',
      status: 'Server is responding correctly'
    })

  } catch (error) {
    console.error('❌ Error in quick test POST:', error)
    
    return NextResponse.json(
      { 
        error: 'Quick test POST failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
