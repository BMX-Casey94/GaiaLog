import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { heroStatsCache } from '@/lib/stats-cache'
import { blockchainService } from '@/lib/blockchain'

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
          // Use PostgreSQL's table stats for fast approximate counts. Prefer n_live_tup when available
          // (updated by autovacuum/analyze), fallback to reltuples estimate from pg_class.
          query(`
            SELECT COALESCE(ps.n_live_tup::bigint, pc.reltuples::bigint) AS count
            FROM pg_class pc
            LEFT JOIN pg_stat_all_tables ps ON ps.relname = pc.relname
            WHERE pc.relname = 'tx_log'
          `),
          
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
        // Fast fallback: use WoC helpers with strict timeout and minimal calls
        try {
          if (process.env.GAIALOG_DISABLE_WOC_READS === 'true') {
            // Skip WoC reads entirely when disabled
            return {
              airQuality,
              blockchain: {
                totalTransactions: txCount,
                lastTransaction: latestTx,
              }
            }
          }
          const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
          const { findLatestByType, getAllWalletAddresses, fetchWalletTransactions } = await import('@/lib/woc-fetcher')
          
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('fallback_timeout')), 7000)
          )
          
          const work = (async () => {
            const addresses = getAllWalletAddresses()
            const addr = addresses[0]
            
            // Get latest air quality (quickly) and a small recent tx sample count
            const [latestAir, txs] = await Promise.all([
              findLatestByType(net, 'air_quality', 25),
              addr ? fetchWalletTransactions(net, addr, 10) : Promise.resolve([] as { tx_hash: string; height: number }[])
            ])
            
            if (latestAir?.payload) {
              const payload: any = latestAir.payload || {}
              airQuality = {
                aqi: payload.air_quality_index ?? null,
                collected_at: latestAir.timestamp ? new Date(latestAir.timestamp).toISOString() : null
              }
              if (!latestTx && latestAir.timestamp) {
                latestTx = new Date(latestAir.timestamp).toISOString()
              }
            }
            
            txCount = Array.isArray(txs) ? txs.length : 0
          })()
          
          await Promise.race([work, timeoutPromise]).catch(() => {
            // On timeout, keep defaults and return quickly
          })
        } catch {
          // Keep defaults on any error
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


