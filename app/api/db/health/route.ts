import { NextResponse } from 'next/server'
import { ensureConnected, getDbInfo } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET() {
  try {
    await ensureConnected()
    return NextResponse.json({ ok: true, db: getDbInfo(), hasDatabaseUrl: !!process.env.DATABASE_URL })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, db: getDbInfo(), hasDatabaseUrl: !!process.env.DATABASE_URL, error: e?.message || String(e) },
      { status: 500 },
    )
  }
}


