import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const idParam = (searchParams.get('id') || '').trim()
    const page = Math.max(Number(searchParams.get('page') || '1'), 1)
    const sort = (searchParams.get('sort') || 'collected_at_desc').toLowerCase()
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || '100'), 1), 500)
    const offset = (page - 1) * limit
    let sql = `SELECT id, provider, station_code, location, lat, lon, level_m, tide_height_m, wave_height_m,
                      salinity_psu, dissolved_oxygen_mg_l, turbidity_ntu, current_speed_ms, current_direction_deg,
                      wind_kph, wind_deg, collected_at AS timestamp, collected_at, txid, source_hash
               FROM water_level_readings`
    const params: any[] = []
    if (idParam && /^\d+$/.test(idParam)) {
      sql += ' WHERE id = $1'
      params.push(Number(idParam))
    } else if (q) {
      sql += ' WHERE station_code ILIKE $1 OR provider ILIKE $1 OR txid ILIKE $1 OR location ILIKE $1'
      params.push(`%${q}%`)
    }
    const orderBy = (() => {
      switch (sort) {
        case 'id_asc': return ' ORDER BY id ASC'
        case 'id_desc': return ' ORDER BY id DESC'
        case 'collected_at_asc': return ' ORDER BY collected_at ASC'
        default: return ' ORDER BY collected_at DESC'
      }
    })()
    const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS sub`
    const countRes = await query<any>(countSql, params)
    sql += `${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(limit, offset)
    const rows = await query<any>(sql, params)
    const total = Number(countRes.rows?.[0]?.total || 0)
    return NextResponse.json({ success: true, items: rows.rows, page, limit, total })
  } catch (e) {
    return NextResponse.json({ success: false, error: 'Failed to fetch water level entries' }, { status: 500 })
  }
}


