import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { createClient } from '@supabase/supabase-js'
import { heroStatsCache } from '@/lib/stats-cache'

export const runtime = 'nodejs'

export async function GET() {
  try {
    // Try to get cached stats first with fallback to stale data (15s cache for faster updates)
    const cachedStats = await heroStatsCache.getStats(async () => {
      let airQuality: { aqi: number | null; collected_at: string | null } = { aqi: null, collected_at: null }
      let txCount = 0
      let latestTx: string | null = null

      // Use more efficient parallel queries
      try {
        // Run all queries in parallel for better performance
        const [airQualityResult, txCountResult, latestTxResult] = await Promise.all([
          query(`SELECT aqi, collected_at
                 FROM air_quality_readings
                 WHERE aqi IS NOT NULL
                 ORDER BY collected_at DESC
                 LIMIT 1`),
          
          // Use PostgreSQL's reltuples estimate (fast) with periodic ANALYZE (30s interval)
          // Much faster than COUNT(*) on 1.7M+ rows, updates via scheduled ANALYZE
          query(`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'tx_log'`),
          
          query(`SELECT COALESCE(onchain_at, collected_at) as timestamp
                 FROM tx_log
                 WHERE status IN ('pending', 'confirmed')
                   AND onchain_at IS NOT NULL
                 ORDER BY onchain_at DESC
                 LIMIT 1`)
        ])

        airQuality = airQualityResult.rows[0] || airQuality
        txCount = parseInt(txCountResult.rows[0]?.count || '0')
        latestTx = latestTxResult.rows[0]?.timestamp || null

      } catch (dbErr) {
        // Fallback: Supabase HTTP
        console.warn('Direct DB query failed, trying Supabase fallback:', dbErr)
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
        if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env missing')

        const supabase = createClient(supabaseUrl, supabaseKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })

        // Run Supabase queries in parallel too
        const [aq, txCnt, latest] = await Promise.all([
          supabase
            .from('air_quality_readings')
            .select('aqi, collected_at')
            .not('aqi', 'is', null)
            .order('collected_at', { ascending: false })
            .limit(1),
          
          supabase.from('tx_log').select('*', { count: 'exact', head: true }),
          
          supabase
            .from('tx_log')
            .select('onchain_at, collected_at, status')
            .in('status', ['pending', 'confirmed'])
            .order('collected_at', { ascending: false })
            .limit(1)
        ])

        if (!aq.error && aq.data?.[0]) {
          airQuality = { aqi: aq.data[0].aqi ?? null, collected_at: aq.data[0].collected_at ?? null }
        }
        if (!txCnt.error && typeof txCnt.count === 'number') {
          txCount = txCnt.count
        }
        if (!latest.error && latest.data?.[0]) {
          latestTx = latest.data[0].onchain_at || latest.data[0].collected_at || null
        }
      }

      return {
        airQuality,
        blockchain: {
          totalTransactions: txCount,
          lastTransaction: latestTx,
        }
      }
    })

    const cacheAge = heroStatsCache.getCacheAge()
    const isStale = cacheAge ? cacheAge > 30000 : false

    return NextResponse.json({
      success: true,
      data: {
        airQuality: {
          aqi: cachedStats.airQuality.aqi,
          lastUpdated: cachedStats.airQuality.collected_at,
        },
        blockchain: {
          totalTransactions: cachedStats.blockchain.totalTransactions,
          lastTransaction: cachedStats.blockchain.lastTransaction,
        },
      },
      cached: true,
      cacheAge: cacheAge,
      stale: isStale
    })

  } catch (error) {
    console.error('Error fetching hero stats:', error)
    
    // Return stale cache as last resort
    const stale = heroStatsCache.getStale()
    if (stale) {
      return NextResponse.json({
        success: true,
        data: {
          airQuality: {
            aqi: stale.airQuality.aqi,
            lastUpdated: stale.airQuality.collected_at,
          },
          blockchain: {
            totalTransactions: stale.blockchain.totalTransactions,
            lastTransaction: stale.blockchain.lastTransaction,
          },
        },
        cached: true,
        stale: true,
        cacheAge: heroStatsCache.getCacheAge()
      })
    }

    // Final fallback with safe defaults
    return NextResponse.json({
      success: true,
      data: {
        airQuality: { aqi: null, lastUpdated: null },
        blockchain: { totalTransactions: 0, lastTransaction: null },
      },
      cached: false,
      error: 'Unable to fetch stats'
    })
  }
}


