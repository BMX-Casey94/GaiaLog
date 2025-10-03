import { NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { query } from '@/lib/db'

export async function GET() {
  try {
    const [{ rows: aq }, { rows: w }, { rows: s }, { rows: adv }] = await Promise.all([
      query(
        `SELECT 
           COUNT(*)::int as count,
           MIN(aqi) as min,
           MAX(aqi) as max,
           AVG(aqi) as avg
         FROM air_quality_readings
         WHERE collected_at > now() - interval '24 hours'`
      ),
      query(
        `SELECT 
           COUNT(*)::int as count,
           MIN(level_m) as min,
           MAX(level_m) as max,
           AVG(level_m) as avg
         FROM water_level_readings
         WHERE collected_at > now() - interval '24 hours'`
      ),
      query(
        `SELECT 
           COUNT(*)::int as count,
           MIN(magnitude) as min,
           MAX(magnitude) as max,
           AVG(magnitude) as avg
         FROM seismic_readings
         WHERE collected_at > now() - interval '24 hours'`
      ),
      query(
        `SELECT 
           COUNT(*)::int as count,
           MIN(environmental_score) as min,
           MAX(environmental_score) as max,
           AVG(environmental_score) as avg,
           AVG(soil_moisture_pct) as soil_moisture_avg
         FROM advanced_metrics_readings
         WHERE collected_at > now() - interval '24 hours'`
      ),
    ])

    return NextResponse.json({
      success: true,
      range: '24h',
      air_quality: aq[0] || null,
      water_level: w[0] || null,
      seismic: s[0] || null,
      advanced: adv[0] || null,
    })
  } catch (error) {
    console.error('Trends API error:', error)
    const message = process.env.NODE_ENV === 'development' && error instanceof Error ? error.message : 'Failed to fetch trends'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}


