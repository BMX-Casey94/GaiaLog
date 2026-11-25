import { NextResponse } from "next/server"
import { getLatestAdvancedMetrics } from "@/lib/latest-environmental"
import { applyPublicReadCacheHeaders } from "@/lib/cache-headers"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 10

/**
 * GET /api/advanced-metrics
 *
 * PUBLIC read endpoint consumed by `components/panels/overview-panel.tsx` via
 * `hooks/use-environmental-data.ts` -> `lib/api-client.ts`, so it stays
 * unauthenticated.
 *
 * It serves the newest reading the collector workers have already persisted and
 * never calls `dataCollector.collectAdvancedMetricsData()`. That path fetched
 * WeatherAPI or OWM, inserted a row, and invoked `writeToBlockchain()`; a slow
 * or unkeyed provider made it return `null`, which this route reported as 502
 * Bad Gateway. The read path is now a bounded database query with an overlay
 * fallback behind a stale-while-revalidate cache.
 *
 * Status contract: 200 whenever the endpoint itself is healthy, with
 * `available: false` when no reading exists yet.
 */
export async function GET() {
  try {
    const { value, cached, stale } = await getLatestAdvancedMetrics()

    // A metric the reading did not carry stays null. Rounding it to 0 would
    // publish "soil moisture 0%, low" for a station that simply did not report
    // soil moisture, which is a fabricated observation.
    const soilMoisturePct = value.soilMoisturePct
    const wildfireRisk = value.wildfireRisk
    const uvIndex = value.uvIndex

    return applyPublicReadCacheHeaders(
      NextResponse.json({
        available: true,
        timestamp: value.collectedAt,
        soil_moisture: {
          value: soilMoisturePct != null ? Math.round(soilMoisturePct) : null,
          unit: "%",
          status:
            soilMoisturePct == null ? "unknown" : soilMoisturePct > 50 ? "normal" : "low",
        },
        wildfire_risk: {
          level: wildfireRisk,
          status: wildfireRisk == null ? "unknown" : wildfireRisk > 5 ? "elevated" : "low",
          affected_areas: ["Global Monitoring"],
        },
        uv_index: {
          value: uvIndex,
          status:
            uvIndex == null
              ? "unknown"
              : uvIndex > 8
                ? "high"
                : uvIndex > 6
                  ? "moderate"
                  : "low",
        },
        source: value.provider || "Unknown",
        environmental_score: value.environmentalScore,
        temperature_c: value.temperatureC,
        humidity_pct: value.humidityPct,
        pressure_mb: value.pressureMb,
        wind_kph: value.windKph,
        wind_deg: value.windDeg,
        location: value.location || "Unknown",
        coordinates:
          value.lat != null && value.lon != null ? { lat: value.lat, lon: value.lon } : null,
        cache: { cached, stale, source: value.origin },
      }),
    )
  } catch (error) {
    console.warn(
      "Advanced metrics API: no reading available:",
      error instanceof Error ? error.message : error,
    )
    const response = NextResponse.json({
      available: false,
      timestamp: null,
      soil_moisture: { value: null, unit: "%", status: "unknown" },
      wildfire_risk: { level: null, status: "unknown", affected_areas: [] },
      uv_index: { value: null, status: "unknown" },
      source: "Unknown",
      environmental_score: null,
      temperature_c: null,
      humidity_pct: null,
      pressure_mb: null,
      wind_kph: null,
      wind_deg: null,
      location: "Unknown",
      coordinates: null,
      error: "No advanced metrics reading has been collected yet",
    })
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
}
