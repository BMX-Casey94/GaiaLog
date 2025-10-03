import { NextResponse } from "next/server"
export const runtime = 'nodejs'
import { dataCollector } from "@/lib/data-collector"

export async function GET() {
  try {
    const airQualityData = await dataCollector.collectAirQualityData()
    
    if (!airQualityData) {
      return NextResponse.json({ error: "No air quality data" }, { status: 502 })
    }

    // Transform the data to match the expected API format
    const apiData = {
      timestamp: airQualityData.timestamp,
      location: airQualityData.location,
      aqi: airQualityData.aqi,
      pm25: airQualityData.pm25,
      pm10: airQualityData.pm10,
      o3: airQualityData.o3,
      no2: airQualityData.no2,
      so2: airQualityData.so2,
      co: airQualityData.co,
      temperature: airQualityData.temperature ?? 0,
      humidity: airQualityData.humidity ?? 0,
      pressure: airQualityData.pressure ?? 0,
      windSpeed: airQualityData.windSpeed ?? 0,
      windDirection: airQualityData.windDirection ?? 0,
      status: airQualityData.aqi <= 50 ? "good" : airQualityData.aqi <= 100 ? "moderate" : "unhealthy",
      source: airQualityData.source,
    }

    return NextResponse.json(apiData)
  } catch (error) {
    console.error("Air quality API error:", error)
    return NextResponse.json({ error: "Failed to fetch air quality data" }, { status: 500 })
  }
}
