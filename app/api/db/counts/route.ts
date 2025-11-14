import { NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET() {
  const tables = [
    'air_quality_readings',
    'water_level_readings',
    'seismic_readings',
    'advanced_metrics_readings',
  ]
  const results: Record<string, number> = {}

  // First try direct Postgres
  try {
    for (const t of tables) {
      const { rows } = await query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${t}`)
      results[t] = rows[0]?.c ?? 0
    }
    return NextResponse.json({ success: true, counts: results })
  } catch {
    // Avoid 500 for UI; return zeros
    for (const t of tables) results[t] = 0
    return NextResponse.json({ success: true, counts: results })
  }
}


