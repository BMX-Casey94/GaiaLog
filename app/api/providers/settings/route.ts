import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const rows = await query<any>('SELECT provider, allow, deny, quotas, updated_at FROM provider_country_settings')
    return NextResponse.json({ success: true, items: rows.rows })
  } catch {
    return NextResponse.json({ success: false, error: 'Failed to load settings' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const provider = String(body?.provider || '').toLowerCase()
    if (!provider) return NextResponse.json({ success: false, error: 'provider required' }, { status: 400 })
    const allow = Array.isArray(body?.allow) ? body.allow.map((c: string) => String(c).toUpperCase()) : null
    const deny = Array.isArray(body?.deny) ? body.deny.map((c: string) => String(c).toUpperCase()) : null
    const quotas = body?.quotas && typeof body.quotas === 'object' ? body.quotas : {}
    await query(
      `INSERT INTO provider_country_settings (provider, allow, deny, quotas)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider) DO UPDATE SET
         allow = EXCLUDED.allow,
         deny = EXCLUDED.deny,
         quotas = EXCLUDED.quotas,
         updated_at = now()`,
      [provider, allow, deny, quotas],
    )
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ success: false, error: 'Failed to save settings' }, { status: 500 })
  }
}






