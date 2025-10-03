import { Pool } from 'pg'

// Connection resolution: prefer DATABASE_URL, else individual vars
function resolveConnectionString(): string | undefined {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL
  if (url) return url
  const host = process.env.PGHOST
  const port = process.env.PGPORT
  const user = process.env.PGUSER
  const password = process.env.PGPASSWORD
  const db = process.env.PGDATABASE
  if (host && port && user && db) {
    const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : `${encodeURIComponent(user)}@`
    return `postgres://${auth}${host}:${port}/${db}`
  }
  return undefined
}

const connectionString = resolveConnectionString()

const shouldUseSSL = (() => {
  if (process.env.PGSSL === 'true') return true
  if (process.env.PGSSLMODE && process.env.PGSSLMODE.toLowerCase() === 'require') return true
  if (connectionString && /sslmode=require/i.test(connectionString)) return true
  const host = process.env.PGHOST || ''
  if (host.includes('supabase.co')) return true
  if (connectionString && /supabase\.co/i.test(connectionString)) return true
  return false
})()

export const dbPool = new Pool(
  connectionString
    ? { connectionString, max: Number(process.env.PGPOOL_MAX || 10), ssl: shouldUseSSL ? { rejectUnauthorized: false } : undefined }
    : {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE || 'gaialog',
        max: Number(process.env.PGPOOL_MAX || 10),
        ssl: shouldUseSSL ? { rejectUnauthorized: false } : undefined,
      },
)

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }> {
  const client = await dbPool.connect()
  try {
    const res = await client.query<T>(text, params)
    return { rows: res.rows }
  } finally {
    client.release()
  }
}

export async function ensureConnected(): Promise<void> {
  await query('SELECT 1')
}

export function getDbInfo(): { host: string; database: string; ssl: boolean } {
  try {
    if (connectionString) {
      // postgres://user:pass@host:port/db?sslmode=require
      const url = new URL(connectionString)
      const host = url.hostname || (process.env.PGHOST || 'unknown')
      const database = (url.pathname || '').replace(/^\//, '') || (process.env.PGDATABASE || 'unknown')
      return { host, database, ssl: shouldUseSSL }
    }
    return {
      host: process.env.PGHOST || 'localhost',
      database: process.env.PGDATABASE || 'gaialog',
      ssl: shouldUseSSL,
    }
  } catch {
    return { host: process.env.PGHOST || 'unknown', database: process.env.PGDATABASE || 'unknown', ssl: shouldUseSSL }
  }
}


