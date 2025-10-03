import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const provider = (searchParams.get('provider') || '').toLowerCase()
    let codes: string[] = []

    if (provider === 'noaa') {
      codes = ['US']
    } else if (provider === 'weatherapi' || provider === 'owm' || provider === 'advanced') {
      // Use OWM seeded stations as authoritative list for weather-based coverage
      const rows = await query<any>(
        `SELECT DISTINCT country FROM stations WHERE provider = 'owm' AND country IS NOT NULL ORDER BY country`
      )
      codes = rows.rows.map((r: any) => String(r.country).toUpperCase())
    } else if (provider === 'waqi') {
      // Use WAQI stations if we have them persisted; fallback to OWM
      let rows = await query<any>(
        `SELECT DISTINCT country FROM stations WHERE provider = 'waqi' AND country IS NOT NULL ORDER BY country`
      )
      if (!rows.rows.length) {
        rows = await query<any>(
          `SELECT DISTINCT country FROM stations WHERE provider = 'owm' AND country IS NOT NULL ORDER BY country`
        )
      }
      codes = rows.rows.map((r: any) => String(r.country).toUpperCase())
    } else if (provider === 'usgs') {
      // Approximate via OWM station countries; USGS is global by events
      const rows = await query<any>(
        `SELECT DISTINCT country FROM stations WHERE provider = 'owm' AND country IS NOT NULL ORDER BY country`
      )
      codes = rows.rows.map((r: any) => String(r.country).toUpperCase())
    } else {
      // Fallback: try OWM; else empty
      const rows = await query<any>(
        `SELECT DISTINCT country FROM stations WHERE provider = 'owm' AND country IS NOT NULL ORDER BY country`
      )
      codes = rows.rows.map((r: any) => String(r.country).toUpperCase())
    }

    return NextResponse.json({ success: true, codes })
  } catch (e) {
    return NextResponse.json({ success: false, error: 'Failed to load provider countries' }, { status: 500 })
  }
}


