import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { heroStatsCache } from '@/lib/hero-cache'

export const runtime = 'nodejs'

export async function GET() {
  try {
    // Check cache first
    const cachedData = heroStatsCache.get('hero-stats')
    if (cachedData) {
      return NextResponse.json({
        success: true,
        data: cachedData,
        cached: true
      })
    }

    // Single optimized query to get all hero stats data
    const result = await query(`
      WITH air_quality_latest AS (
        SELECT aqi, collected_at
        FROM air_quality_readings
        WHERE aqi IS NOT NULL
        ORDER BY collected_at DESC
        LIMIT 1
      ),
      blockchain_stats AS (
        SELECT 
          COUNT(*) as total_transactions,
          MAX(COALESCE(onchain_at, collected_at)) as latest_transaction
        FROM tx_log
        WHERE status IN ('confirmed', 'pending')
          AND txid IS NOT NULL
          AND txid != 'failed'
          AND txid != ''
          AND txid NOT LIKE 'local_%'
          AND txid NOT LIKE 'error_%'
          AND LENGTH(txid) = 64
          AND txid ~ '^[0-9a-fA-F]{64}$'
      )
      SELECT 
        aq.aqi,
        aq.collected_at as air_quality_updated,
        bs.total_transactions,
        bs.latest_transaction
      FROM air_quality_latest aq
      CROSS JOIN blockchain_stats bs
    `)

    const row = result.rows[0] || {}
    const airQuality = { aqi: row.aqi, collected_at: row.air_quality_updated }
    const txCount = parseInt(row.total_transactions || '0')
    const latestTx = row.latest_transaction || null

    const responseData = {
      airQuality: {
        aqi: airQuality.aqi,
        lastUpdated: airQuality.collected_at,
      },
      blockchain: {
        totalTransactions: txCount,
        lastTransaction: latestTx,
      },
    }

    // Update cache
    heroStatsCache.set('hero-stats', responseData, 30000) // 30 seconds TTL

    return NextResponse.json({
      success: true,
      data: responseData,
      cached: false
    })
  } catch (error) {
    console.error('Hero stats API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch hero stats' },
      { status: 500 }
    )
  }
}


