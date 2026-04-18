import { NextResponse } from 'next/server'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    console.log('🧪 Testing simple data collection...')

    // Test WeatherAPI (we have this key)
    console.log('1️⃣ Testing WeatherAPI.com...')
    let weatherData = null
    try {
      const response = await fetch(
        `https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHERAPI_KEY}&q=London&aqi=yes`
      )
      weatherData = await response.json()
      console.log(`✅ WeatherAPI: ${weatherData.location?.name} - ${weatherData.current?.temp_c}°C`)
    } catch (error) {
      console.log('❌ WeatherAPI failed:', error)
    }

    // Test USGS (no key needed)
    console.log('2️⃣ Testing USGS Earthquake API...')
    let seismicData = null
    try {
      const response = await fetch(
        'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2024-01-01&endtime=2024-01-02&minmagnitude=2.5&orderby=time'
      )
      seismicData = await response.json()
      console.log(`✅ USGS API: ${seismicData.features?.length || 0} earthquakes found`)
    } catch (error) {
      console.log('❌ USGS API failed:', error)
    }

    // Test NOAA (no key needed)
    console.log('3️⃣ Testing NOAA Tides & Currents API...')
    let waterData = null
    try {
      const response = await fetch(
        'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels'
      )
      waterData = await response.json()
      console.log(`✅ NOAA API: ${waterData.stations?.length || 0} stations found`)
    } catch (error) {
      console.log('❌ NOAA API failed:', error)
    }

    console.log('🎉 Simple API testing completed!')

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      message: 'Simple API test completed successfully',
      data: {
        weather: weatherData ? {
          location: weatherData.location?.name,
          temperature: weatherData.current?.temp_c,
          airQuality: weatherData.current?.air_quality?.['us-epa-index']
        } : null,
        seismic: seismicData ? {
          earthquakesFound: seismicData.features?.length || 0
        } : null,
        water: waterData ? {
          stationsFound: waterData.stations?.length || 0
        } : null
      }
    })

  } catch (error) {
    console.error('❌ Error in test data collection:', error)
    
    return NextResponse.json(
      { 
        error: 'Failed to test data collection',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
