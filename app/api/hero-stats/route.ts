import { NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET() {
  try {
    // Get latest air quality data
    const airQualityResult = await query(
      `SELECT aqi, collected_at
       FROM air_quality_readings
       WHERE aqi IS NOT NULL
       ORDER BY collected_at DESC
       LIMIT 1`
    )

    // Get total transaction count from tx_log - simple count of all records
    const txCountResult = await query(
      `SELECT COUNT(*)::text as count
       FROM tx_log`
    )

    // Get latest blockchain transaction timestamp - most recent pending or confirmed
    const latestTxResult = await query(
      `SELECT COALESCE(onchain_at, collected_at) as timestamp
       FROM tx_log
       WHERE status IN ('pending', 'confirmed')
       ORDER BY COALESCE(onchain_at, collected_at) DESC
       LIMIT 1`
    )

    const airQuality = airQualityResult.rows[0] || { aqi: null, collected_at: null }
    const txCount = parseInt(txCountResult.rows[0]?.count || '0')
    const latestTx = latestTxResult.rows[0]?.timestamp || null

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
  } catch (error) {
    console.error('Hero stats API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch hero stats' },
      { status: 500 }
    )
  }
}


