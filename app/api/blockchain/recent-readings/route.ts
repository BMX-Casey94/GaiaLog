import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getBSVNetwork } from '@/lib/utils'

export const runtime = 'nodejs'

interface TxLogRecord {
  txid: string
  type: string
  provider: string
  collected_at: string
  onchain_at: string | null
  status: string
}

export async function GET(req: NextRequest) {
  try {
    // Query the tx_log table directly - this is where all blockchain transactions are recorded
    // Get the most recent transaction for each data type from the last 24 hours
    const result = await query<TxLogRecord>(
      `SELECT DISTINCT ON (type) 
        txid, 
        type, 
        provider,
        collected_at,
        onchain_at,
        status
       FROM tx_log
       WHERE status IN ('confirmed', 'pending')
         AND txid IS NOT NULL
         AND txid != 'failed'
         AND txid != ''
         AND txid NOT LIKE 'local_%'
         AND txid NOT LIKE 'error_%'
         AND LENGTH(txid) = 64
         AND txid ~ '^[0-9a-fA-F]{64}$'
         AND COALESCE(onchain_at, collected_at) > NOW() - INTERVAL '24 hours'
       ORDER BY type, COALESCE(onchain_at, collected_at) DESC`
    )

    const network = getBSVNetwork()

    // Transform tx_log records into display format
    const readings = result.rows.map((tx) => ({
      txid: tx.txid,
      type: tx.type,
      timestamp: tx.onchain_at || tx.collected_at,
      status: tx.status,
      data: {
        provider: tx.provider,
      },
    }))

    return NextResponse.json({
      success: true,
      network,
      readings,
    })
  } catch (error) {
    console.error('Recent readings API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch recent readings' },
      { status: 500 }
    )
  }
}