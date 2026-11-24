import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { applyPublicReadCacheHeaders } from "@/lib/cache-headers"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/advanced-metrics
 *
 * PUBLIC read endpoint. `components/panels/overview-panel.tsx` (via
 * `hooks/use-environmental-data.ts` -> `lib/api-client.ts`) polls this every
 * 15 minutes, so it must stay unauthenticated.
 *
 * It serves the newest reading already persisted by the collector workers and
 * no longer calls `dataCollector.collectAdvancedMetricsData()`. That call
 * fetched upstream providers, inserted a row, and invoked `writeToBlockchain()`,
 * so an anonymous GET could trigger an on-chain write whenever the serving
 * process ran with `GAIALOG_WORKER_PROCESS=1`. Collection belongs to the workers
 * process and the authenticated `POST /api/data/collect`.
 */
export async function GET() {
  try {
    const result = await query<any>(
      `SELECT provider, city, lat, lon, uv_index, soil_moisture_pct, wildfire_risk,
              environmental_score, temperature_c, humidity_pct, pressure_mb,
              wind_kph, wind_deg, collected_at
         FROM advanced_metrics_readings
        ORDER BY collected_at DESC
        LIMIT 1`,
    )

    const row = result.rows?.[0]
    if (!row) {
      return NextResponse.json({ error: "No advanced metrics data" }, { status: 502 })
    }

    // `soil_moisture_pct` is stored 0-100 (the collector persists
    // `Math.round(soil_moisture * 100)`), matching the percentage the previous
    // live-collector response produced.
    const soilMoisturePct = toNumber(row.soil_moisture_pct, 0)
    const wildfireRisk = toNumber(row.wildfire_risk, 0)
    const uvIndex = toNumber(row.uv_index, 0)
    const lat = nullableNumber(row.lat)
    const lon = nullableNumber(row.lon)

    // Response shape preserved from the previous live-collector version.
    const apiData = {
      timestamp: toIsoTimestamp(row.collected_at),
      soil_moisture: {
        value: soilMoisturePct,
        unit: "%",
        status: soilMoisturePct > 50 ? "normal" : "low",
      },
      wildfire_risk: {
        level: wildfireRisk,
        status: wildfireRisk > 5 ? "elevated" : "low",
        affected_areas: ["Global Monitoring"],
      },
      uv_index: {
        value: uvIndex,
        status: uvIndex > 8 ? "high" : uvIndex > 6 ? "moderate" : "low",
      },
      source: row.provider || "Unknown",
      temperature_c: nullableNumber(row.temperature_c),
      humidity_pct: nullableNumber(row.humidity_pct),
      pressure_mb: nullableNumber(row.pressure_mb),
      wind_kph: nullableNumber(row.wind_kph),
      wind_deg: nullableNumber(row.wind_deg),
      location: row.city || "Unknown",
      coordinates: lat != null && lon != null ? { lat, lon } : null,
    }

    return applyPublicReadCacheHeaders(NextResponse.json(apiData))
  } catch (error) {
    console.error("Advanced metrics API error:", error)
    return NextResponse.json({ error: "Failed to fetch advanced metrics" }, { status: 500 })
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
