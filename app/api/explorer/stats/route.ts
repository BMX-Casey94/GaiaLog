/**
 * Data Explorer Statistics API (Database-less)
 * 
 * GET /api/explorer/stats
 * 
 * Returns overall statistics about the indexed data.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getIndexStats, getAggregates } from '@/lib/explorer-store'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest) {
  try {
    const indexStats = getIndexStats()
    const aggregates = getAggregates()
    
    return NextResponse.json({
      success: true,
      data: {
        // Index file stats
        index: {
          totalReadings: indexStats.totalReadings,
          lastBlock: indexStats.lastBlock,
          lastUpdated: new Date(indexStats.lastUpdated).toISOString(),
          fileSizeKB: Math.round(indexStats.fileSizeBytes / 1024),
        },
        // Aggregate stats
        aggregates: {
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
    console.error('Explorer stats error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'An error occurred',
      },
      { status: 500 }
    )
  }
}
