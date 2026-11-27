import { NextResponse } from "next/server"
import { getLatestSeismic } from "@/lib/latest-environmental"
import { applyPublicReadCacheHeaders } from "@/lib/cache-headers"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 10

/**
 * GET /api/seismic
 *
 * PUBLIC read endpoint consumed by `components/panels/overview-panel.tsx` via
 * `hooks/use-environmental-data.ts` -> `lib/api-client.ts`, so it stays
 * unauthenticated.
 *
 * It serves the newest reading the collector workers have already persisted and
 * never calls `dataCollector.collectSeismicData()`. That path queried the
 * upstream seismic feeds and attempted an on-chain write, and returned `null`
 * on any upstream failure — which this route reported as 502 Bad Gateway. The
 * read path is now a bounded database query with an overlay fallback behind a
 * stale-while-revalidate cache.
 *
 * Status contract: 200 whenever the endpoint itself is healthy, with
 * `available: false` when no reading exists yet.
 */
export async function GET() {
  try {
    const { value, cached, stale } = await getLatestSeismic()

    return applyPublicReadCacheHeaders(
      NextResponse.json({
        available: true,
        timestamp: value.collectedAt,
        recent_events: [
          {
            id: value.eventId,
            // Null, not 0: a null magnitude would otherwise publish "M0.0".
            magnitude: value.magnitude,
            location: value.location || "Unknown",
            depth: value.depthKm,
            time: value.collectedAt,
            coordinates:
              value.lat != null && value.lon != null
                ? { lat: value.lat, lon: value.lon }
                : null,
          },
        ],
        status: "active",
        source: value.provider || "Unknown",
        cache: { cached, stale, source: value.origin },
      }),
    )
  } catch (error) {
    console.warn(
      "Seismic API: no reading available:",
      error instanceof Error ? error.message : error,
    )
    const response = NextResponse.json({
      available: false,
      timestamp: null,
      recent_events: [],
      status: "unavailable",
      source: "Unknown",
      error: "No seismic reading has been collected yet",
    })
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
}
