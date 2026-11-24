import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { applyPublicReadCacheHeaders } from "@/lib/cache-headers"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/water-levels
 *
 * PUBLIC read endpoint. `components/panels/overview-panel.tsx` (via
 * `hooks/use-environmental-data.ts` -> `lib/api-client.ts`) polls this every
 * 15 minutes, so it must stay unauthenticated.
 *
 * It serves the newest reading already persisted by the collector workers and
 * no longer calls `dataCollector.collectWaterLevelData()`. That call issued a
 * dozen NOAA requests, inserted a row, and invoked `writeToBlockchain()`, which
 * let an anonymous GET trigger an on-chain write whenever the serving process
 * ran with `GAIALOG_WORKER_PROCESS=1`. Collection is the job of the workers
 * process and the authenticated `POST /api/data/collect`.
 */
export async function GET() {
  try {
    const result = await query<any>(
      `SELECT provider, station_code, location, lat, lon, level_m, tide_height_m,
              wave_height_m, salinity_psu, dissolved_oxygen_mg_l, turbidity_ntu,
              current_speed_ms, current_direction_deg, wind_kph, wind_deg,
              collected_at
         FROM water_level_readings
        ORDER BY collected_at DESC
        LIMIT 1`,
    )

    const water = result.rows?.[0]
    if (!water) {
      return NextResponse.json({ error: "No water level data" }, { status: 502 })
    }

    // Response shape preserved from the previous live-collector version. Fields
    // with no persisted column (ph, wave proximity, gust, visibility…) are
    // returned as null rather than omitted so consumers can rely on the keys.
    return applyPublicReadCacheHeaders(NextResponse.json({
      timestamp: toIsoTimestamp(water.collected_at),
      stations: [
        {
          id: water.station_code || "unknown",
          name: water.location || water.station_code || "Unknown station",
          level: toNumber(water.level_m, 0),
          unit: "m",
          status: "normal",
          trend: "stable",
          tide_height: nullableNumber(water.tide_height_m),
          water_temperature: null,
          wave_height: nullableNumber(water.wave_height_m),
          wave_height_is_nearby: null,
          wave_nearby_distance_km: null,
          wave_nearby_station: null,
          salinity: nullableNumber(water.salinity_psu),
          ph: null,
          dissolved_oxygen: nullableNumber(water.dissolved_oxygen_mg_l),
          turbidity: nullableNumber(water.turbidity_ntu),
          wind_speed: nullableNumber(water.wind_kph),
          wind_direction: nullableNumber(water.wind_deg),
        },
      ],
      source: water.provider || "Unknown",
    }))
  } catch (error) {
    console.error("Water levels API error:", error)
    return NextResponse.json({ error: "Failed to fetch water level data" }, { status: 500 })
  }
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toIsoTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ""))
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}
