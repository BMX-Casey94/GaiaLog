import { NextResponse } from "next/server"
import { getLatestWaterLevel } from "@/lib/latest-environmental"
import { applyPublicReadCacheHeaders } from "@/lib/cache-headers"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 10

/**
 * GET /api/water-levels
 *
 * PUBLIC read endpoint consumed by `components/panels/overview-panel.tsx` via
 * `hooks/use-environmental-data.ts` -> `lib/api-client.ts`, so it stays
 * unauthenticated.
 *
 * It serves the newest reading the collector workers have already persisted and
 * never calls `dataCollector.collectWaterLevelData()`. That path issued a dozen
 * NOAA requests and an on-chain write, and returned `null` whenever NOAA was
 * slow — which this route reported as 502 Bad Gateway. The read path is now a
 * bounded database query with an overlay fallback behind a
 * stale-while-revalidate cache.
 *
 * Status contract: 200 whenever the endpoint itself is healthy, with
 * `available: false` when no reading exists yet.
 */
export async function GET() {
  try {
    const { value, cached, stale } = await getLatestWaterLevel()

    // Shape preserved from the live-collector version. Fields with no persisted
    // column (water temperature, wave proximity, pH) are returned as null rather
    // than omitted so consumers can rely on the keys.
    return applyPublicReadCacheHeaders(
      NextResponse.json({
        available: true,
        timestamp: value.collectedAt,
        stations: [
          {
            id: value.stationCode || "unknown",
            name: value.location || value.stationCode || "Unknown station",
            // Null, not 0: a station that reported no surface level has not
            // measured a flat calm sea.
            level: value.levelM,
            unit: "m",
            status: value.levelM == null ? "unknown" : "normal",
            trend: "stable",
            tide_height: value.tideHeightM,
            water_temperature: null,
            wave_height: value.waveHeightM,
            wave_height_is_nearby: null,
            wave_nearby_distance_km: null,
            wave_nearby_station: null,
            salinity: value.salinityPsu,
            ph: null,
            dissolved_oxygen: value.dissolvedOxygenMgL,
            turbidity: value.turbidityNtu,
            current_speed: value.currentSpeedMs,
            current_direction: value.currentDirectionDeg,
            wind_speed: value.windKph,
            wind_direction: value.windDeg,
          },
        ],
        source: value.provider || "Unknown",
        coordinates:
          value.lat != null && value.lon != null ? { lat: value.lat, lon: value.lon } : null,
        cache: { cached, stale, source: value.origin },
      }),
    )
  } catch (error) {
    console.warn(
      "Water levels API: no reading available:",
      error instanceof Error ? error.message : error,
    )
    const response = NextResponse.json({
      available: false,
      timestamp: null,
      stations: [],
      source: "Unknown",
      coordinates: null,
      error: "No water level reading has been collected yet",
    })
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
}
