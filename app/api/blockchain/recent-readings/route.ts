import { NextRequest, NextResponse } from 'next/server'
import { query } from '../../../../lib/db'

function getBSVNetwork(): string {
  return process.env.BSV_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
}

function isValidTxId(txid: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(txid)
}

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
    // Get the latest confirmed transaction for each data type (max 4 entries)
    // Using DISTINCT ON with time window for efficient query on large tables
    const result = await Promise.race([
      query<TxLogRecord>(
        `SELECT DISTINCT ON (type)
          txid, 
          type, 
          provider,
          collected_at,
          onchain_at,
          status
         FROM tx_log
         WHERE status IN ('pending', 'confirmed')
           AND txid IS NOT NULL
           AND LENGTH(txid) = 64
           AND type IN ('air_quality', 'water_levels', 'seismic_activity', 'advanced_metrics')
           AND collected_at > NOW() - INTERVAL '7 days'
         ORDER BY type, collected_at DESC`
      ),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Query timeout')), 10000)
      )
    ])

    // Transform tx_log records into display format, filtering invalid txids
    const readings = result.rows
      .filter((tx) => {
        // Additional validation after query
        if (!tx.txid || tx.txid === 'failed' || tx.txid === '') return false
        if (tx.txid.startsWith('local_') || tx.txid.startsWith('error_')) return false
        if (!isValidTxId(tx.txid)) return false
        return true
      })
      .map((tx) => ({
        txid: tx.txid,
        type: tx.type,
        timestamp: tx.onchain_at || tx.collected_at,
        status: tx.status,
        data: {
          provider: tx.provider,
        },
      }))
      // Sort by timestamp descending for display
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    return NextResponse.json({ success: true, network, readings })
  } catch (error) {
    console.log('PostgreSQL connection failed (expected on Vercel), using Supabase REST API')
    
    // Fallback: Use Supabase REST API
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      
      if (!supabaseUrl || !supabaseKey) {
        console.error('Supabase config missing:', { hasUrl: !!supabaseUrl, hasKey: !!supabaseKey })
        throw new Error('Supabase configuration missing')
      }

      const headers = {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }

      const fetchUrl = `${supabaseUrl}/rest/v1/tx_log?select=txid,type,provider,collected_at,onchain_at,status&status=in.(pending,confirmed)&txid=not.is.null&type=in.(air_quality,water_levels,seismic_activity,advanced_metrics)&order=collected_at.desc&limit=100`
      console.log('Fetching recent transactions from Supabase REST API')
      
      // Fetch recent transactions from each type
      const response = await fetch(fetchUrl, { headers })

      console.log('Supabase REST API response status:', response.status)
      
      if (!response.ok) {
        const errorText = await response.text()
        console.error('Supabase API error:', response.status, errorText)
        throw new Error(`Supabase API error: ${response.status}`)
      }

      const txData = await response.json()
      console.log('Got transaction data from Supabase:', txData.length, 'transactions')
      
      // Get distinct latest transaction per type
      const seenTypes = new Set<string>()
      const readings = txData
        .filter((tx: TxLogRecord) => {
          if (!tx.txid || tx.txid === 'failed' || tx.txid === '') return false
          if (tx.txid.startsWith('local_') || tx.txid.startsWith('error_')) return false
          if (!isValidTxId(tx.txid)) return false
          if (seenTypes.has(tx.type)) return false
          seenTypes.add(tx.type)
          return true
        })
        .slice(0, 4)
        .map((tx: TxLogRecord) => ({
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
        fallback: true
      })
    } catch (fallbackError) {
      console.error('Supabase REST API fallback also failed:', fallbackError)
      
      // Final fallback: Return empty array
      return NextResponse.json({ 
        success: true, 
        network, 
        readings: [],
        error: 'Unable to connect to database'
      })
    }
  }
}