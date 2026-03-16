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

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const source = getExplorerReadSource()
    if (source !== 'overlay') {
      return NextResponse.json({ success: true, readings: [], source: 'overlay-unavailable' })
    }

    const families = Object.keys(DATA_FAMILY_DESCRIPTORS)
    const rows = await getLatestReadingsWithMetrics(families)

    const readings = rows.map((row) => ({
      txid: row.txid,
      family: row.data_family,
      location: row.location,
      timestamp: row.reading_ts,
      provider: row.provider_id,
      metrics: row.metrics_preview ?? {},
      blockHeight: row.block_height,
      confirmed: row.confirmed,
    }))

    return NextResponse.json({ success: true, readings, source: 'overlay' })
  } catch (error) {
    console.error('Latest readings error:', error)
    return NextResponse.json({
      success: true,
      readings: [],
      error: error instanceof Error ? error.message : 'Failed to fetch latest readings',
    })
  }
}
