import { NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'

export async function GET() {
  try {
    const balance = await blockchainService.checkBalance()
    
    return NextResponse.json({
      success: true,
      balance,
      address: blockchainService['wallet']?.getAddress() || 'Not configured',
      warning: balance < 0.01 ? 'Low balance warning' : null,
      configured: !!blockchainService['wallet']
    })

  } catch (error) {
    console.error('Error fetching wallet balance:', error)
    
    return NextResponse.json(
      { 
        error: 'Failed to fetch wallet balance',
        details: error instanceof Error ? error.message : 'Unknown error',
        configured: false
      },
      { status: 500 }
    )
  }
}
