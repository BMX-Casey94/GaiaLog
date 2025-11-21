/**
 * UTXO Cache Refresh Endpoint
 * 
 * Force refreshes all UTXO caches for all configured wallets.
 * Useful when wallets have balances but no UTXOs are being detected.
 */

import { NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST handler - Force refresh all UTXO caches
 */
export async function POST() {
  try {
    console.log('🔄 Manual UTXO cache refresh requested via API')
    await blockchainService.forceRefreshAllUtxoCaches()
    
    return NextResponse.json({
      success: true,
      message: 'UTXO caches refreshed successfully',
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error('❌ Error refreshing UTXO caches:', error)
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to refresh UTXO caches',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}

/**
 * GET handler - Same as POST for convenience
 */
export async function GET() {
  return POST()
}

