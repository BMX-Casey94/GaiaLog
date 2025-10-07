import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

export async function GET() {
  // Safe defaults so the UI never 500s if DB is unavailable
  let airQuality: { aqi: number | null; collected_at: string | null } = { aqi: null, collected_at: null }
  let txCount = 0
  let latestTx: string | null = null

  // First try: direct Postgres
  try {
    const airQualityResult = await query(
      `SELECT aqi, collected_at
       FROM air_quality_readings
       WHERE aqi IS NOT NULL
       ORDER BY collected_at DESC
       LIMIT 1`
    )

    const txCountResult = await query(
      `SELECT COUNT(*)::text as count
       FROM tx_log`
    )

    const latestTxResult = await query(
      `SELECT COALESCE(onchain_at, collected_at) as timestamp
       FROM tx_log
       WHERE status IN ('pending', 'confirmed')
       ORDER BY COALESCE(onchain_at, collected_at) DESC
       LIMIT 1`
    )

    airQuality = airQualityResult.rows[0] || airQuality
    txCount = parseInt(txCountResult.rows[0]?.count || '0')
    latestTx = latestTxResult.rows[0]?.timestamp || null
  } catch {
    // Fallback: Supabase HTTP
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env missing')

      const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })

      const aq = await supabase
        .from('air_quality_readings')
        .select('aqi, collected_at')
        .not('aqi', 'is', null)
        .order('collected_at', { ascending: false })
        .limit(1)
      if (!aq.error && aq.data && aq.data[0]) {
        airQuality = { aqi: aq.data[0].aqi ?? null, collected_at: aq.data[0].collected_at ?? null }
      }

      const txCnt = await supabase.from('tx_log').select('*', { count: 'exact', head: true })
      if (!txCnt.error && typeof txCnt.count === 'number') {
        txCount = txCnt.count
      }

      const latest = await supabase
        .from('tx_log')
        .select('onchain_at, collected_at, status')
        .in('status', ['pending', 'confirmed'])
        .order('onchain_at', { ascending: false, nullsFirst: false })
        .order('collected_at', { ascending: false })
        .limit(1)
      if (!latest.error && latest.data && latest.data[0]) {
        latestTx = latest.data[0].onchain_at || latest.data[0].collected_at || null
      }
    } catch {
      // keep safe defaults
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      airQuality: {
        aqi: airQuality.aqi,
        lastUpdated: airQuality.collected_at,
      },
      blockchain: {
        totalTransactions: txCount,
        lastTransaction: latestTx,
      },
    },
  })
}


