/**
 * Data Explorer Search API (Supabase-backed)
 *
 * GET /api/explorer/search
 *
 * Uses the `explorer_readings` PostgreSQL table for fast filtered queries
 * with pagination, full-text location search, and type/date filters.
 *
 * Query parameters:
 *   q        - Location search text (uses pg_trgm ILIKE)
 *   type     - Data type filter (air_quality, water_levels, seismic_activity, advanced_metrics)
 *   from     - Start date (ISO 8601)
 *   to       - End date (ISO 8601)
 *   page     - Page number (default: 1)
 *   pageSize - Items per page (default: 50, max: 500)
 */

import { NextRequest, NextResponse } from 'next/server'
import { searchReadings, getAggregates, type SearchParams } from '@/lib/supabase-explorer'

export const dynamic = 'force-dynamic'

const WOC_BASE =
  process.env.BSV_NETWORK === 'mainnet'
    ? 'https://whatsonchain.com'
    : 'https://test.whatsonchain.com'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)

    // Parse query parameters
    const params: SearchParams = {}

    const q = searchParams.get('q')
    if (q) params.q = q

    const dataType = searchParams.get('type')
    if (
      dataType &&
      ['air_quality', 'water_levels', 'seismic_activity', 'advanced_metrics'].includes(dataType)
    ) {
      params.dataType = dataType
    }

    const from = searchParams.get('from')
    if (from) {
      const fromDate = new Date(from)
      if (!isNaN(fromDate.getTime())) {
        params.from = fromDate.getTime()
      }
    }

    const to = searchParams.get('to')
    if (to) {
      const toDate = new Date(to)
      if (!isNaN(toDate.getTime())) {
        params.to = toDate.getTime()
      }
    }

    const page = searchParams.get('page')
    if (page) params.page = Math.max(1, parseInt(page, 10))

    const pageSize = searchParams.get('pageSize')
    if (pageSize) params.pageSize = Math.min(500, Math.max(1, parseInt(pageSize, 10)))

    // Heavy aggregate scans can be expensive on large datasets.
    // Keep search path responsive by default, and only compute full aggregates
    // when explicitly requested.
    const includeAggregates = ['1', 'true', 'yes'].includes(
      (searchParams.get('includeAggregates') || '').toLowerCase()
    )

    // Fetch results from Supabase
    const results = await searchReadings(params)
    const aggregates = includeAggregates
      ? await getAggregates(params)
      : {
          totalReadings: results.total,
          uniqueLocations: 0,
          dateRange: { min: null, max: null },
          byType: {},
        }

    // Transform items for API response
    const items = results.items.map(item => ({
      txid: item.txid,
      dataType: item.dataType,
      location: item.location,
      lat: item.lat,
      lon: item.lon,
      timestamp: new Date(item.timestamp).toISOString(),
      metrics: item.metrics,
      provider: item.provider,
      blockHeight: item.blockHeight,
      // Default to the OP_RETURN output (GaiaLog writes it as vout 0)
      wocUrl: `${WOC_BASE}/tx/${String(item.txid).toLowerCase()}?voutOffset=0&output=0`,
    }))

    return NextResponse.json({
      success: true,
      data: {
        items,
        pagination: {
          page: results.page,
          pageSize: results.pageSize,
          total: results.total,
          hasMore: results.hasMore,
          totalPages: Math.ceil(results.total / results.pageSize),
        },
        aggregates: {
          totalReadings: aggregates.totalReadings,
          uniqueLocations: aggregates.uniqueLocations,
          dateRange: {
            min: aggregates.dateRange.min
              ? new Date(aggregates.dateRange.min).toISOString()
              : null,
            max: aggregates.dateRange.max
              ? new Date(aggregates.dateRange.max).toISOString()
              : null,
          },
          byType: aggregates.byType,
        },
      },
    })
  } catch (error) {
    console.error('Explorer search error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'An error occurred while searching',
      },
      { status: 500 }
    )
  }
}
