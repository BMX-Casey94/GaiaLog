import { NextRequest, NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

export async function POST(request: NextRequest) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    const body = await request.json()
    const { stream, payload } = body

    if (!stream || !payload) {
      return NextResponse.json(
        { error: 'Missing required fields: stream and payload' },
        { status: 400 }
      )
    }

    const data = {
      stream,
      timestamp: Date.now(),
      payload
    }

    const txid = await blockchainService.writeToChain(data)

    return NextResponse.json({
      success: true,
      txid,
      stream,
      timestamp: data.timestamp
    })

  } catch (error) {
    console.error('Error in blockchain write API:', error)
    
    return NextResponse.json(
      { 
        error: 'Failed to write to blockchain',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
