import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getBSVNetwork, isValidTxId } from '@/lib/utils'
import { createClient } from '@supabase/supabase-js'

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
  const network = getBSVNetwork()
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

    return NextResponse.json({ success: true, network, readings })
  } catch (error) {
    console.error('Recent readings API error, trying Supabase fallback:', error)
    // Fallback via Supabase HTTP
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env missing')

      const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })

      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
      const resp = await supabase
        .from('tx_log')
        .select('txid, type, provider, collected_at, onchain_at, status')
        .in('status', ['pending', 'confirmed'])
        .gte('collected_at', since)
        .order('collected_at', { ascending: false })
        .limit(500)

      let latestByType: Record<string, { txid: string; type: string; timestamp: string; status: string; data: { provider: string } }> = {}
      if (!resp.error && Array.isArray(resp.data)) {
        for (const r of resp.data) {
          const txid = r?.txid
          if (!txid || txid === 'failed' || txid === '' || txid.startsWith('local_') || txid.startsWith('error_')) continue
          if (!isValidTxId(txid)) continue
          const ts = (r.onchain_at || r.collected_at) as string
          const key = r.type as string
          const prev = latestByType[key]
          if (!prev || new Date(ts).getTime() > new Date(prev.timestamp).getTime()) {
            latestByType[key] = {
              txid,
              type: key,
              timestamp: ts,
              status: r.status || 'confirmed',
              data: { provider: r.provider },
            }
          }
        }
      }

      const readings = Object.values(latestByType)
      return NextResponse.json({ success: true, network, readings })
    } catch (e) {
      console.error('Supabase fallback failed:', e)
      // Last resort: avoid 500s
      return NextResponse.json({ success: true, network, readings: [] })
    }
  }
}