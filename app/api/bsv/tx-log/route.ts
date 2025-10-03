import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

type Row = {
  txid: string
  type: string
  provider: string
  collected_at: string
  onchain_at: string | null
  status: 'pending' | 'confirmed' | 'failed'
  fee_sats: number | null
  wallet_index: number | null
  retries: number | null
  error: string | null
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const limit = Math.min(Number(searchParams.get('limit') || '50'), 200)
    const rows = await query<Row>(
      `SELECT txid, type, provider, collected_at, onchain_at, status, fee_sats, wallet_index, retries, error
       FROM tx_log
       ORDER BY COALESCE(onchain_at, collected_at) DESC
       LIMIT $1`,
      [limit],
    )

    const network = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'

    return NextResponse.json({
      success: true,
      network,
      items: rows.rows,
    })
  } catch (error) {
    console.error('tx-log API error:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch tx log' }, { status: 500 })
  }
}


