import { NextResponse } from "next/server"
export const runtime = 'nodejs'
import { dataCollector } from "@/lib/data-collector"

export async function GET() {
  try {
    const advancedMetricsData = await dataCollector.collectAdvancedMetricsData()
    
    if (!advancedMetricsData) {
      return NextResponse.json({ error: "No advanced metrics data" }, { status: 502 })
    }

    // Transform the data to match the expected API format
    const apiData = {
      timestamp: advancedMetricsData.timestamp,
      soil_moisture: {
        value: Math.round(advancedMetricsData.soil_moisture * 100),
        unit: "%",
        status: advancedMetricsData.soil_moisture > 0.5 ? "normal" : "low",
      },
      wildfire_risk: {
        level: advancedMetricsData.wildfire_risk,
        status: advancedMetricsData.wildfire_risk > 5 ? "elevated" : "low",
        affected_areas: ["Global Monitoring"],
      },
      uv_index: {
        value: advancedMetricsData.uv_index,
        status: advancedMetricsData.uv_index > 8 ? "high" : advancedMetricsData.uv_index > 6 ? "moderate" : "low",
      },
      source: advancedMetricsData.source,
      temperature_c: advancedMetricsData.temperature_c ?? null,
      humidity_pct: advancedMetricsData.humidity_pct ?? null,
      pressure_mb: advancedMetricsData.pressure_mb ?? null,
      wind_kph: advancedMetricsData.wind_kph ?? null,
      wind_deg: advancedMetricsData.wind_deg ?? null,
      location: advancedMetricsData.location,
      coordinates: advancedMetricsData.coordinates ?? null,
    }

    return NextResponse.json(apiData)
  } catch (error) {
    console.error("Advanced metrics API error:", error)
    return NextResponse.json({ error: "Failed to fetch advanced metrics" }, { status: 500 })
  }
}
