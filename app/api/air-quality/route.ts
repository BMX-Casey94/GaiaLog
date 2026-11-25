import { NextResponse } from "next/server"
import { getLatestAirQuality } from "@/lib/latest-environmental"
import { applyPublicReadCacheHeaders } from "@/lib/cache-headers"

export const runtime = 'nodejs'
// Every response reflects the newest persisted reading, so the handler must run
// per request rather than being evaluated once at build time.
export const dynamic = 'force-dynamic'
// The legacy and overlay reads run concurrently under one bounded budget, so a
// cold cache answers in roughly one round-trip. This stays explicit to keep the
// budget reviewable against the platform's own timeout.
export const maxDuration = 10

/**
 * GET /api/air-quality
 *
 * PUBLIC read endpoint consumed by `components/panels/overview-panel.tsx` via
 * `hooks/use-environmental-data.ts` -> `lib/api-client.ts`, so it stays
 * unauthenticated.
 *
 * It serves the newest reading the collector workers have already persisted and
 * never calls `dataCollector.collectAirQualityData()`. That path hit the
 * upstream providers, inserted a row, and called `writeToBlockchain()`; when the
 * provider was slow, rate-limited, or the keys were absent on the serving
 * process it returned `null` and this route answered 502 Bad Gateway. The read
 * path is now a bounded database query with an overlay fallback, served from an
 * in-process stale-while-revalidate cache.
 *
 * Status contract: 200 whenever the endpoint itself is healthy, with
 * `available: false` when no reading exists yet. This route never returns a
 * gateway error, because a missing reading is not an upstream failure.
 */
export async function GET() {
  try {
    const { value, cached, stale } = await getLatestAirQuality()
    // `aqi` stays null when the reading did not carry one. Defaulting to 0
    // would label the air "Good" on the strength of no measurement at all.
    const aqi = value.aqi

    return applyPublicReadCacheHeaders(
      NextResponse.json({
        available: true,
        timestamp: value.collectedAt,
        location: value.location || "Unknown",
        aqi,
        pm25: value.pm25,
        pm10: value.pm10,
        o3: value.o3,
        no2: value.no2,
        so2: value.so2,
        co: value.co,
        temperature: value.temperatureC,
        humidity: value.humidityPct,
        pressure: value.pressureMb,
        windSpeed: value.windKph,
        windDirection: value.windDeg,
        status: aqi == null ? "unknown" : aqi <= 50 ? "good" : aqi <= 100 ? "moderate" : "unhealthy",
        source: value.provider || "Unknown",
        coordinates:
          value.lat != null && value.lon != null ? { lat: value.lat, lon: value.lon } : null,
        cache: { cached, stale, source: value.origin },
      }),
    )
  } catch (error) {
    // No reading in either source. This is a normal cold-start state for a
    // fresh database, not a gateway failure: answer 200 so the widget renders
    // its empty state instead of a transport error.
    console.warn(
      "Air quality API: no reading available:",
      error instanceof Error ? error.message : error,
    )
    const response = NextResponse.json({
      available: false,
      timestamp: null,
      location: "Unknown",
      // Nulls, not zeros: nothing was measured, so nothing is reported.
      aqi: null,
      pm25: null,
      pm10: null,
      o3: null,
      no2: null,
      so2: null,
      co: null,
      temperature: null,
      humidity: null,
      pressure: null,
      windSpeed: null,
      windDirection: null,
      status: "unknown",
      source: "Unknown",
      coordinates: null,
      error: "No air quality reading has been collected yet",
    })
    // Do not let an empty state sit in a shared cache: the next collector
    // cycle should be visible immediately.
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
}
