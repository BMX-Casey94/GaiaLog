import { NextResponse } from "next/server"
export const runtime = 'nodejs'
import { dataCollector } from "@/lib/data-collector"

export async function GET() {
  try {
    const water = await dataCollector.collectWaterLevelData()
    if (!water) {
      return NextResponse.json({ error: "No water level data" }, { status: 502 })
    }
    return NextResponse.json({
      timestamp: water.timestamp,
      stations: [
        {
          id: water.station_id,
          name: water.location,
          level: water.sea_level,
          unit: "m",
          status: "normal",
          trend: "stable",
          tide_height: water.tide_height ?? null,
          water_temperature: water.water_temperature_c ?? null,
          wave_height: water.wave_height_m ?? null,
          wave_height_is_nearby: water.wave_height_is_nearby ?? null,
          wave_nearby_distance_km: water.wave_nearby_distance_km ?? null,
          wave_nearby_station: water.wave_nearby_station ?? null,
          salinity: water.salinity_psu ?? null,
          ph: water.ph ?? null,
          dissolved_oxygen: water.dissolved_oxygen_mg_l ?? null,
          turbidity: water.turbidity_ntu ?? null,
          wind_speed: water.wind_speed_kph ?? null,
          wind_direction: water.wind_direction_deg ?? null,
        },
      ],
      source: water.source,
    })
  } catch (error) {
    console.error("Water levels API error:", error)
    return NextResponse.json({ error: "Failed to fetch water level data" }, { status: 500 })
  }
}
