/**
 * Data Explorer Search API (Database-less)
 * 
 * GET /api/explorer/search
 * 
 * Uses JSON file storage instead of PostgreSQL.
 * 
 * Query parameters:
 *   q - Location search text
 *   lat - Latitude for radius search
 *   lon - Longitude for radius search
 *   radius - Radius in km (requires lat/lon)
 *   type - Data type filter (air_quality, water_levels, seismic_activity, advanced_metrics)
 *   from - Start date (ISO 8601)
 *   to - End date (ISO 8601)
 *   page - Page number (default: 1)
 *   pageSize - Items per page (default: 50, max: 500)
 */

import { NextRequest, NextResponse } from 'next/server'
import { searchReadings, getAggregates, type SearchParams } from '@/lib/explorer-store'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    
    // Parse query parameters
    const params: SearchParams = {}
    
    const q = searchParams.get('q')
    if (q) params.q = q
    
    const lat = searchParams.get('lat')
    const lon = searchParams.get('lon')
    const radius = searchParams.get('radius')
    if (lat && lon) {
      params.lat = parseFloat(lat)
      params.lon = parseFloat(lon)
      params.radiusKm = radius ? parseFloat(radius) : 50 // Default 50km radius
    }
    
    const dataType = searchParams.get('type')
    if (dataType && ['air_quality', 'water_levels', 'seismic_activity', 'advanced_metrics'].includes(dataType)) {
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
    
    // Fetch results from JSON store
    const results = searchReadings(params)
    const aggregates = getAggregates(params)
    
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
      // Generate WhatsonChain link
      wocUrl: `https://whatsonchain.com/tx/${item.txid}`,
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
            min: aggregates.dateRange.min ? new Date(aggregates.dateRange.min).toISOString() : null,
            max: aggregates.dateRange.max ? new Date(aggregates.dateRange.max).toISOString() : null,
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
