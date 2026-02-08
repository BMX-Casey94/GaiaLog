/**
 * Data Explorer Location Autocomplete API (Supabase-backed)
 *
 * GET /api/explorer/locations
 *
 * Uses the `explorer_readings` table with pg_trgm for fast location search.
 *
 * Query parameters:
 *   q     - Search text (partial match)
 *   type  - Data type filter (optional)
 *   limit - Max results (default: 20)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getLocationSuggestions } from '@/lib/supabase-explorer'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)

    const q = searchParams.get('q') || ''
    const dataType = searchParams.get('type') || undefined
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)))

    const suggestions = await getLocationSuggestions(q, dataType, limit)

    // Transform for API response
    const items = suggestions.map(s => ({
      location: s.location,
      dataType: s.dataType,
      readingCount: s.readingCount,
      lastReading: new Date(s.lastReading).toISOString(),
      coordinates: s.avgLat && s.avgLon ? { lat: s.avgLat, lon: s.avgLon } : null,
    }))

    return NextResponse.json({
      success: true,
      data: {
        suggestions: items,
        total: items.length,
      },
    })
  } catch (error) {
    console.error('Explorer locations error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'An error occurred',
      },
      { status: 500 }
    )
  }
}
