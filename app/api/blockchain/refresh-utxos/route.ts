/**
 * UTXO Cache Refresh Endpoint
 * 
 * Force refreshes all UTXO caches for all configured wallets.
 * Useful when wallets have balances but no UTXOs are being detected.
 */

import { NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST handler - Force refresh all UTXO caches
 */
export async function POST(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    console.log('🔄 Manual UTXO cache refresh requested via API')
    await blockchainService.forceRefreshAllUtxoCaches()
    
    return NextResponse.json({
      success: true,
      message:
        'UTXO caches refreshed for this Next.js process only. Worker processes keep their own in-memory overlay caches — restart them (e.g. pm2 restart gaialog-workers) after chain or overlay DB changes so spend paths see fresh UTXOs.',
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
export async function GET(request: Request) {
  return POST(request)
}

