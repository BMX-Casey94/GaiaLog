import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  // Show what environment variables Vercel is actually seeing
  const envInfo = {
    PGHOST: process.env.PGHOST || 'NOT SET',
    PGPORT: process.env.PGPORT || 'NOT SET',
    PGUSER: process.env.PGUSER || 'NOT SET',
    PGDATABASE: process.env.PGDATABASE || 'NOT SET',
    PGPASSWORD: process.env.PGPASSWORD ? `SET (${process.env.PGPASSWORD.substring(0, 4)}...)` : 'NOT SET',
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL ? 'true' : 'false',
    VERCEL_ENV: process.env.VERCEL_ENV || 'NOT SET'
  }

  return NextResponse.json({
    success: true,
    environment: envInfo,
    timestamp: new Date().toISOString()
  })
}

