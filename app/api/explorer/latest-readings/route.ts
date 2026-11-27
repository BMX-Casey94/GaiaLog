/**
 * Latest Readings With Metrics API
 *
 * GET /api/explorer/latest-readings
 *
 * Returns the most recent reading per data family from the overlay,
 * including metrics_preview so the Live Dashboard can compute alerts
 * without hitting 4+ separate legacy endpoints.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getExplorerReadSource } from '@/lib/explorer-read-source'
import { getLatestReadingsWithMetrics } from '@/lib/overlay-explorer-service'
import { DATA_FAMILY_DESCRIPTORS } from '@/lib/stream-registry'
import { applyPublicReadCacheHeaders } from '@/lib/cache-headers'
import { ServerSwrCache } from '@/lib/server-swr-cache'

export const dynamic = 'force-dynamic'

const latestReadingsCache = new ServerSwrCache<Array<{
  txid: string
  family: string
  location: string | null
  timestamp: string
  provider: string | null
  metrics: Record<string, unknown>
  blockHeight: number | null
  confirmed: boolean
}>>(20_000)

function jsonWithCache(body: unknown, init?: ResponseInit): NextResponse {
  return applyPublicReadCacheHeaders(NextResponse.json(body, init))
}

export async function GET(_req: NextRequest) {
  try {
    const source = getExplorerReadSource()
    if (source !== 'overlay') {
      return jsonWithCache({ success: true, readings: [], source: 'overlay-unavailable' })
    }

    const { value: readings, cached, stale } = await latestReadingsCache.get(async () => {
      const families = Object.keys(DATA_FAMILY_DESCRIPTORS)
      const rows = await getLatestReadingsWithMetrics(families)
      return rows.map((row) => ({
        txid: row.txid,
        family: row.data_family,
        location: row.location,
        timestamp: row.reading_ts,
        provider: row.provider_id,
        metrics: row.metrics_preview ?? {},
        blockHeight: row.block_height,
        confirmed: row.confirmed,
      }))
    })

    return jsonWithCache({ success: true, readings, source: 'overlay', cached, stale })
  } catch (error) {
    console.error('Latest readings error:', error)
    return jsonWithCache({
      success: true,
      readings: [],
      error: error instanceof Error ? error.message : 'Failed to fetch latest readings',
    })
  }
}
