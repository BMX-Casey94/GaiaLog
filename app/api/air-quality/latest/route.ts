import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET() {
  try {
    // Use Supabase REST API directly (Vercel serverless-friendly)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    
    if (!supabaseUrl || !supabaseKey) {
      console.error('Missing Supabase configuration')
      return NextResponse.json({
        success: false,
        message: 'Database configuration missing'
      }, { status: 500 })
    }

    const headers = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json'
    }

    // Add 30s timeout to prevent Supabase hanging
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000)

    const url = `${supabaseUrl}/rest/v1/air_quality_readings?select=aqi,pm25,pm10,city,lat,lon,provider,collected_at&order=collected_at.desc&limit=1`
    
    const response = await fetch(url, { 
      headers,
      signal: controller.signal
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Supabase API error:', response.status, errorText)
      return NextResponse.json({
        success: false,
        message: `Supabase returned ${response.status}`
      }, { status: 500 })
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
        country: '',
        lat: reading.lat || 0,
        lon: reading.lon || 0,
        source: reading.provider || 'Unknown',
        timestamp: reading.collected_at
      }
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('Supabase query timed out after 30s')
      return NextResponse.json({
        success: false,
        message: 'Database query timeout'
      }, { status: 504 })
    }
    
    console.error('Air quality API error:', error)
    return NextResponse.json({
      success: false,
      message: 'Database error'
    }, { status: 500 })
  }
}
