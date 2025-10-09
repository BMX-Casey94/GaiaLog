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
    console.error('Error fetching latest air quality from DB:', error)
    
    // Fallback: Use Supabase REST API
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      
      if (!supabaseUrl || !supabaseKey) {
        throw new Error('Supabase configuration missing')
      }

      const headers = {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      }

      const response = await fetch(
        `${supabaseUrl}/rest/v1/air_quality_readings?select=aqi,pm25,pm10,city,country,lat,lon,provider,collected_at&aqi=not.is.null&order=collected_at.desc&limit=1`,
        { headers }
      )

      if (!response.ok) {
        throw new Error(`Supabase API error: ${response.status}`)
      }

      const data = await response.json()
      
      if (!data || data.length === 0) {
        return NextResponse.json({
          success: false,
          message: 'No air quality data available'
        })
      }

      const reading = data[0]
      return NextResponse.json({
        success: true,
        data: {
          aqi: reading.aqi,
          pm25: reading.pm25 || 0,
          pm10: reading.pm10 || 0,
          location: reading.city || 'Unknown',
          country: reading.country || '',
          lat: reading.lat || 0,
          lon: reading.lon || 0,
          source: reading.provider || 'Unknown',
          timestamp: reading.collected_at
        }
      })
    } catch (fallbackError) {
      console.error('Supabase REST API fallback also failed:', fallbackError)
      return NextResponse.json({
        success: false,
        message: 'Database connection error'
      }, { status: 500 })
    }
  }
}

