import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

// Debug endpoint to see what data exists in the database
export async function GET(req: NextRequest) {
  try {
    const checks = await Promise.all([
      // Check latest air quality record (with or without txid)
      query(`SELECT 
        COUNT(*) as total,
        COUNT(txid) FILTER (WHERE txid IS NOT NULL AND txid != '' AND txid != 'failed') as with_txid,
        MAX(collected_at) as latest_timestamp
        FROM air_quality_readings
        WHERE collected_at > NOW() - INTERVAL '7 days'`
      ),
      
      // Check latest water levels record
      query(`SELECT 
        COUNT(*) as total,
        COUNT(txid) FILTER (WHERE txid IS NOT NULL AND txid != '' AND txid != 'failed') as with_txid,
        MAX(collected_at) as latest_timestamp
        FROM water_level_readings
        WHERE collected_at > NOW() - INTERVAL '7 days'`
      ),
      
      // Check latest seismic record
      query(`SELECT 
        COUNT(*) as total,
        COUNT(txid) FILTER (WHERE txid IS NOT NULL AND txid != '' AND txid != 'failed') as with_txid,
        MAX(collected_at) as latest_timestamp
        FROM seismic_readings
        WHERE collected_at > NOW() - INTERVAL '7 days'`
      ),
      
      // Check latest advanced metrics record
      query(`SELECT 
        COUNT(*) as total,
        COUNT(txid) FILTER (WHERE txid IS NOT NULL AND txid != '' AND txid != 'failed') as with_txid,
        MAX(collected_at) as latest_timestamp
        FROM advanced_metrics_readings
        WHERE collected_at > NOW() - INTERVAL '7 days'`
      ),
      
      // Get actual latest records with txids
      query(`SELECT 'air_quality' as type, txid, collected_at FROM air_quality_readings 
        WHERE txid IS NOT NULL AND txid != '' AND txid != 'failed' AND txid NOT LIKE 'local_%'
        ORDER BY collected_at DESC LIMIT 1`),
      query(`SELECT 'water_levels' as type, txid, collected_at FROM water_level_readings 
        WHERE txid IS NOT NULL AND txid != '' AND txid != 'failed' AND txid NOT LIKE 'local_%'
        ORDER BY collected_at DESC LIMIT 1`),
      query(`SELECT 'seismic' as type, txid, collected_at FROM seismic_readings 
        WHERE txid IS NOT NULL AND txid != '' AND txid != 'failed' AND txid NOT LIKE 'local_%'
        ORDER BY collected_at DESC LIMIT 1`),
      query(`SELECT 'advanced_metrics' as type, txid, collected_at FROM advanced_metrics_readings 
        WHERE txid IS NOT NULL AND txid != '' AND txid != 'failed' AND txid NOT LIKE 'local_%'
        ORDER BY collected_at DESC LIMIT 1`),
    ])

    return NextResponse.json({
      success: true,
      last_7_days_summary: {
        air_quality: checks[0].rows[0],
        water_levels: checks[1].rows[0],
        seismic: checks[2].rows[0],
        advanced_metrics: checks[3].rows[0],
      },
      latest_with_txid: {
        air_quality: checks[4].rows[0] || null,
        water_levels: checks[5].rows[0] || null,
        seismic: checks[6].rows[0] || null,
        advanced_metrics: checks[7].rows[0] || null,
      },
    })
  } catch (error) {
    console.error('Debug readings API error:', error)
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    )
  }
}


