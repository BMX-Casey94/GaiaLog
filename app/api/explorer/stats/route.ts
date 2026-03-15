/**
 * Data Explorer Statistics API (Supabase-backed)
 *
 * GET /api/explorer/stats
 *
 * Returns overall statistics about the indexed data.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getIndexStats, getUniqueLocationCountFast } from '@/lib/explorer-read-source'

export const dynamic = 'force-dynamic'

type StatsAggregates = {
  uniqueLocations: number | null
  dateRange: { min: number | null; max: number | null }
  byType: Record<string, number>
}

type IndexStats = { totalReadings: number; lastBlock: number; lastUpdated: number }
type ExplorerStatsPayload = {
  totalReadings: number
  uniqueLocations: number | null
  network: string
  index: {
    totalReadings: number
    lastBlock: number
    lastUpdated: string
  }
  aggregates: {
    uniqueLocations: number | null
    dateRange: { min: string | null; max: string | null }
    byType: Record<string, number>
  }
}

let lastKnownAggregates: StatsAggregates | null = null
let lastKnownIndexStats: IndexStats | null = null
let cachedPayload: { data: ExplorerStatsPayload; ts: number } | null = null
let refreshInFlight: Promise<void> | null = null

const STATS_CACHE_TTL_MS = Math.max(5000, Number(process.env.EXPLORER_STATS_CACHE_TTL_MS || 30000))
const INDEX_TIMEOUT_MS = Math.max(1000, Number(process.env.EXPLORER_INDEX_TIMEOUT_MS || 2500))
const LOCATION_TIMEOUT_MS = Math.max(500, Number(process.env.EXPLORER_LOCATION_TIMEOUT_MS || 1200))

function defaultAggregates(): StatsAggregates {
  return { uniqueLocations: null, dateRange: { min: null, max: null }, byType: {} }
}

function defaultIndexStats(): IndexStats {
  return { totalReadings: 0, lastBlock: 0, lastUpdated: Date.now() }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ])
}

function buildPayload(indexStats: IndexStats, aggregates: StatsAggregates): ExplorerStatsPayload {
  return {
    totalReadings: indexStats.totalReadings,
    uniqueLocations: aggregates.uniqueLocations,
    network: process.env.BSV_NETWORK || 'testnet',
    index: {
      totalReadings: indexStats.totalReadings,
      lastBlock: indexStats.lastBlock,
      lastUpdated: new Date(indexStats.lastUpdated).toISOString(),
    },
    aggregates: {
      uniqueLocations: aggregates.uniqueLocations,
      dateRange: {
        min: aggregates.dateRange.min ? new Date(aggregates.dateRange.min).toISOString() : null,
        max: aggregates.dateRange.max ? new Date(aggregates.dateRange.max).toISOString() : null,
      },
      byType: aggregates.byType,
    },
  }
}

async function refreshSnapshot(): Promise<void> {
  const [indexResult, uniqueLocationsResult] = await Promise.allSettled([
    withTimeout(getIndexStats(), INDEX_TIMEOUT_MS, 'Explorer index stats'),
    withTimeout(getUniqueLocationCountFast(), LOCATION_TIMEOUT_MS, 'Explorer unique locations'),
  ])

  const indexStats: IndexStats =
    indexResult.status === 'fulfilled' ? indexResult.value : (lastKnownIndexStats ?? defaultIndexStats())
  if (indexResult.status === 'fulfilled') {
    lastKnownIndexStats = indexResult.value
  } else {
    console.warn('Explorer index stats unavailable:', indexResult.reason)
  }

  const previousAggregates = lastKnownAggregates ?? defaultAggregates()
  const aggregates: StatsAggregates =
    uniqueLocationsResult.status === 'fulfilled' && typeof uniqueLocationsResult.value === 'number'
      ? {
          ...previousAggregates,
          uniqueLocations: uniqueLocationsResult.value,
        }
      : previousAggregates

  if (uniqueLocationsResult.status === 'fulfilled' && typeof uniqueLocationsResult.value === 'number') {
    lastKnownAggregates = aggregates
  } else {
    console.warn('Explorer unique locations unavailable:', uniqueLocationsResult.reason)
  }

  cachedPayload = {
    data: buildPayload(indexStats, aggregates),
    ts: Date.now(),
  }
}

function triggerRefresh(): void {
  if (refreshInFlight) return
  refreshInFlight = refreshSnapshot().finally(() => {
    refreshInFlight = null
  })
}

export async function GET(_request: NextRequest) {
  try {
    const now = Date.now()
    const age = cachedPayload ? now - cachedPayload.ts : null
    const fresh = age != null && age <= STATS_CACHE_TTL_MS

    if (fresh && cachedPayload) {
      return NextResponse.json({
        success: true,
        data: cachedPayload.data,
        cached: true,
        stale: false,
        cacheAge: age,
      })
    }

    if (cachedPayload) {
      // Serve stale immediately and refresh in background to keep latency low.
      triggerRefresh()
      return NextResponse.json({
        success: true,
        data: cachedPayload.data,
        cached: true,
        stale: true,
        cacheAge: age,
      })
    }

    // Cold start: do one bounded refresh so first response has best-effort values.
    await refreshSnapshot()
    const payload =
      cachedPayload?.data ??
      buildPayload(lastKnownIndexStats ?? defaultIndexStats(), lastKnownAggregates ?? defaultAggregates())

    return NextResponse.json({
      success: true,
      data: payload,
      cached: true,
      stale: false,
      cacheAge: 0,
    })
  } catch (error) {
    console.error('Explorer stats error:', error)
    const payload =
      cachedPayload?.data ??
      buildPayload(lastKnownIndexStats ?? defaultIndexStats(), lastKnownAggregates ?? defaultAggregates())
    return NextResponse.json({
      success: true,
      data: payload,
      cached: !!cachedPayload,
      stale: true,
      error: error instanceof Error ? error.message : 'Explorer stats unavailable',
    })
  }
}
