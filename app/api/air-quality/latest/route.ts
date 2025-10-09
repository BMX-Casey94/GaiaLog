import { NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET() {
  try {
    // Read latest air quality from database (written by local workers)
    const result = await query(`
      SELECT 
        aqi,
        pm25,
        pm10,
        city,
        country,
        lat,
        lon,
        provider,
        collected_at as timestamp
      FROM air_quality_readings
      WHERE aqi IS NOT NULL
      ORDER BY collected_at DESC
      LIMIT 1
    `)

    if (result.rows.length === 0) {
      return NextResponse.json({
        success: false,
        message: 'No air quality data available'
      })
    }

    const data = result.rows[0]

    return NextResponse.json({
      success: true,
      data: {
        aqi: data.aqi,
        pm25: data.pm25 || 0,
        pm10: data.pm10 || 0,
        location: data.city || 'Unknown',
        country: data.country || '',
        lat: data.lat || 0,
        lon: data.lon || 0,
        source: data.provider || 'Unknown',
        timestamp: data.timestamp
      }
    })
  } catch (error) {
    console.error('Error fetching latest air quality:', error)
    return NextResponse.json({
      success: false,
      message: 'Database error'
    }, { status: 500 })
  }
}

