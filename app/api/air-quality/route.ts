import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { applyPublicReadCacheHeaders } from "@/lib/cache-headers"

export const runtime = 'nodejs'
// This handler reads the newest persisted reading on every request. Without
// force-dynamic, Next would evaluate the handler once at build time and serve a
// frozen payload forever.
export const dynamic = 'force-dynamic'

/**
 * GET /api/air-quality
 *
 * PUBLIC read endpoint. `components/panels/overview-panel.tsx` (via
 * `hooks/use-environmental-data.ts` -> `lib/api-client.ts`) calls this, so it
 * must stay unauthenticated.
 *
 * It serves the most recent reading already persisted by the collector
 * workers. It deliberately does NOT call `dataCollector.collectAirQualityData()`:
 * that path hits upstream providers, inserts a row, and calls
 * `writeToBlockchain()`. Leaving it on a public GET meant any anonymous caller
 * could trigger a blockchain write whenever the process ran with
 * `GAIALOG_WORKER_PROCESS=1`. Collection belongs to the authenticated
 * `POST /api/data/collect` endpoint and the workers process.
 */
export async function GET() {
  try {
    const result = await query<any>(
      `SELECT provider, city, lat, lon, aqi, pm25, pm10, co, no2, o3, so2,
              temperature_c, humidity_pct, pressure_mb, wind_kph, wind_deg,
              collected_at
         FROM air_quality_readings
        ORDER BY collected_at DESC
        LIMIT 1`,
    )

    const row = result.rows?.[0]
    if (!row) {
      return NextResponse.json({ error: "No air quality data" }, { status: 502 })
    }

    const aqi = toNumber(row.aqi, 0)

    // Shape preserved exactly as the previous live-collector response so
    // existing consumers keep working.
    const apiData = {
      timestamp: toIsoTimestamp(row.collected_at),
      location: row.city || "Unknown",
      aqi,
      pm25: toNumber(row.pm25, 0),
      pm10: toNumber(row.pm10, 0),
      o3: toNumber(row.o3, 0),
      no2: toNumber(row.no2, 0),
      so2: toNumber(row.so2, 0),
      co: toNumber(row.co, 0),
      temperature: toNumber(row.temperature_c, 0),
      humidity: toNumber(row.humidity_pct, 0),
      pressure: toNumber(row.pressure_mb, 0),
      windSpeed: toNumber(row.wind_kph, 0),
      windDirection: toNumber(row.wind_deg, 0),
      status: aqi <= 50 ? "good" : aqi <= 100 ? "moderate" : "unhealthy",
      source: row.provider || "Unknown",
    }

    return applyPublicReadCacheHeaders(NextResponse.json(apiData))
  } catch (error) {
    console.error("Air quality API error:", error)
    return NextResponse.json({ error: "Failed to fetch air quality data" }, { status: 500 })
  }
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toIsoTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ""))
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}
