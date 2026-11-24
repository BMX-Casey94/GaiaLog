import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { applyPublicReadCacheHeaders } from "@/lib/cache-headers"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/seismic
 *
 * PUBLIC read endpoint. `components/panels/overview-panel.tsx` (via
 * `hooks/use-environmental-data.ts` -> `lib/api-client.ts`) polls this every
 * 15 minutes, so it must stay unauthenticated.
 *
 * It serves the newest reading already persisted by the collector workers and
 * no longer calls `dataCollector.collectSeismicData()`. That call queried
 * upstream seismic APIs, inserted a row, and invoked `writeToBlockchain()`, so
 * an anonymous GET could trigger an on-chain write whenever the serving process
 * ran with `GAIALOG_WORKER_PROCESS=1`. Collection belongs to the workers
 * process and the authenticated `POST /api/data/collect`.
 */
export async function GET() {
  try {
    const result = await query<any>(
      `SELECT provider, event_id, location, magnitude, depth_km, lat, lon, collected_at
         FROM seismic_readings
        ORDER BY collected_at DESC
        LIMIT 1`,
    )

    const seismic = result.rows?.[0]
    if (!seismic) {
      return NextResponse.json({ error: "No seismic data" }, { status: 502 })
    }

    const timestamp = toIsoTimestamp(seismic.collected_at)

    // Response shape preserved from the previous live-collector version.
    return applyPublicReadCacheHeaders(NextResponse.json({
      timestamp,
      recent_events: [
        {
          id: seismic.event_id || null,
          magnitude: toNumber(seismic.magnitude, 0),
          location: seismic.location || "Unknown",
          depth: toNumber(seismic.depth_km, 0),
          time: timestamp,
          coordinates: {
            lat: toNumber(seismic.lat, 0),
            lon: toNumber(seismic.lon, 0),
          },
        },
      ],
      status: "active",
      source: seismic.provider || "Unknown",
    }))
  } catch (error) {
    console.error("Seismic API error:", error)
    return NextResponse.json({ error: "Failed to fetch seismic data" }, { status: 500 })
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
