import { NextResponse } from 'next/server'
import { fastTableCount } from '@/lib/db-fast-count'

export const runtime = 'nodejs'

export async function GET() {
  const tables = [
    'air_quality_readings',
    'water_level_readings',
    'seismic_readings',
    'advanced_metrics_readings',
  ]
  const results: Record<string, number> = {}

  // Planner estimates (O(1) per table) instead of four sequential full-table
  // COUNT(*) scans, which were saturating database CPU on every dashboard poll.
  const settled = await Promise.allSettled(tables.map(t => fastTableCount(t)))
  tables.forEach((t, i) => {
    const outcome = settled[i]
    results[t] = outcome.status === 'fulfilled' ? outcome.value : 0
  })

  return NextResponse.json({ success: true, counts: results })
}


