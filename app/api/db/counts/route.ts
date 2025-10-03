import { NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const tables = [
      'air_quality_readings',
      'water_level_readings',
      'seismic_readings',
      'advanced_metrics_readings',
    ]
    const results: Record<string, number> = {}
    for (const t of tables) {
      const { rows } = await query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${t}`)
      results[t] = rows[0]?.c ?? 0
    }
    return NextResponse.json({ success: true, counts: results })
  } catch (error) {
    console.error('DB counts error:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch counts' }, { status: 500 })
  }
}


