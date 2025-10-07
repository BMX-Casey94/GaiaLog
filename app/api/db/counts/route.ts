import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { createClient } from '@supabase/supabase-js'

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
    // Fallback to Supabase HTTP
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env missing')

      const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })

      for (const t of tables) {
        const r = await supabase.from(t).select('*', { count: 'exact', head: true })
        results[t] = (r.error || typeof r.count !== 'number') ? 0 : r.count
      }
      return NextResponse.json({ success: true, counts: results })
    } catch {
      // Avoid 500 for UI; return zeros
      for (const t of tables) results[t] = 0
      return NextResponse.json({ success: true, counts: results })
    }
  }
}


