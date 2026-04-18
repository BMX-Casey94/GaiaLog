/**
 * Priority Alerts API
 *
 * GET /api/explorer/priority-alerts
 *
 * Returns high-priority recent readings from the overlay for hero/Live Alerts.
 * Only used when EXPLORER_READ_SOURCE=overlay; otherwise returns empty.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getExplorerReadSource } from '@/lib/explorer-read-source'
import { getPriorityAlerts } from '@/lib/overlay-explorer-service'
import { DATA_FAMILY_DESCRIPTORS } from '@/lib/stream-registry'
import type { DataFamily } from '@/lib/stream-registry'
import { applyPublicReadCacheHeaders } from '@/lib/cache-headers'

export const dynamic = 'force-dynamic'

function jsonWithCache(body: unknown, init?: ResponseInit): NextResponse {
  return applyPublicReadCacheHeaders(NextResponse.json(body, init))
}

function computeSeverityScore(
  dataFamily: string,
  metrics: Record<string, unknown>,
): number {
  let score = 50
  switch (dataFamily) {
    case 'seismic_activity': {
      const mag = Number(metrics.magnitude ?? metrics.magnitude_value ?? 0)
      score = Math.min(100, 50 + mag * 8)
      break
    }
    case 'air_quality': {
      const aqi = Number(metrics.aqi ?? metrics.air_quality_index ?? 0)
      const pm25 = Number(metrics.pm25 ?? 0)
      const val = Math.max(aqi, pm25 * 2)
      score = Math.min(100, 40 + val / 4)
      break
    }
    case 'flood_risk':
      score = 85
      break
    case 'volcanic_activity':
      score = 90
      break
    case 'natural_events':
      score = 75
      break
    case 'space_weather':
      score = 70
      break
    case 'water_levels': {
      const level = Number(metrics.river_level ?? metrics.sea_level ?? 0)
      score = level > 6 ? 85 : level > 4 ? 70 : 55
      break
    }
    case 'advanced_metrics': {
      const envScore = Number(metrics.environmental_quality_score ?? metrics.environmental_score ?? 1)
      const norm = envScore <= 1 ? envScore * 100 : envScore
      score = norm < 30 ? 90 : norm < 50 ? 75 : 55
      break
    }
    case 'geomagnetism':
      score = 55
      break
    case 'upper_atmosphere':
      score = 50
      break
    case 'hydrology':
      score = 60
      break
    case 'conservation_status':
      score = 65
      break
    case 'biodiversity':
      score = 50
      break
    case 'land_use_change':
      score = 70
      break
    case 'mining_activity':
      score = 50
      break
    case 'transport_tracking':
      score = 45
      break
    case 'planning_development':
      score = 40
      break
    default:
      score = 50
  }
  return Math.round(score)
}

function getPrimaryValue(dataFamily: string, metrics: Record<string, unknown>): string | null {
  const desc = DATA_FAMILY_DESCRIPTORS[dataFamily as DataFamily]
  if (!desc?.metricPreviewKeys) return null
  for (const key of desc.metricPreviewKeys) {
    const v = metrics[key]
    if (v != null && v !== '') return String(v)
  }
  return null
}

export async function GET(req: NextRequest) {
  try {
    const source = getExplorerReadSource()
    if (source !== 'overlay') {
      return jsonWithCache({
        success: true,
        alerts: [],
        source: 'overlay-unavailable',
        message: 'Priority alerts require EXPLORER_READ_SOURCE=overlay',
      })
    }

    const limitParam = req.nextUrl.searchParams.get('limit')
    const limit = Math.min(50, Math.max(1, parseInt(limitParam || '8', 10)) || 8)

    const rows = await getPriorityAlerts(limit)

    const alerts = rows.map((row) => {
      const metrics = (row.metrics_preview && typeof row.metrics_preview === 'object')
        ? row.metrics_preview as Record<string, unknown>
        : {}
      const desc = DATA_FAMILY_DESCRIPTORS[row.data_family as DataFamily]
      const severity = computeSeverityScore(row.data_family, metrics)
      const value = getPrimaryValue(row.data_family, metrics)

      return {
        txid: row.txid,
        family: row.data_family,
        label: desc?.label ?? row.data_family,
        severity,
        value,
        location: row.location ?? 'Unknown',
        lat: row.lat,
        lon: row.lon,
        timestamp: row.reading_ts,
        blockHeight: row.block_height,
        confirmed: row.confirmed,
        metrics,
      }
    })

    return jsonWithCache({
      success: true,
      alerts,
      source: 'overlay',
    })
  } catch (error) {
    console.error('Priority alerts error:', error)
    return jsonWithCache({
      success: true,
      alerts: [],
      error: error instanceof Error ? error.message : 'Failed to fetch priority alerts',
    })
  }
}
