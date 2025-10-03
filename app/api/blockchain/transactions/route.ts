import { NextRequest, NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const stream = searchParams.get('stream')
    const limit = parseInt(searchParams.get('limit') || '100')

    const transactions = await blockchainService.getTransactionHistory(stream || undefined, limit)
    
    return NextResponse.json({
      success: true,
      transactions,
      count: transactions.length
    })

  } catch (error) {
    console.error('Error fetching transaction history:', error)
    
    return NextResponse.json(
      { 
        error: 'Failed to fetch transaction history',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
