import { Pool } from 'pg'

// SSL configuration for Supabase
// For localhost, disable SSL. For Supabase, use proper SSL with rejectUnauthorized: false
const isSupabase = process.env.PGHOST?.includes('supabase.co')
const sslConfig = isSupabase ? { rejectUnauthorized: false } : false

// Build connection config explicitly to override environment variables
const connectionConfig = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gaialog',
  max: Number(process.env.PGPOOL_MAX || 10),
  ssl: sslConfig,
  connectionTimeoutMillis: 10000,
}

const shouldUseSSL = isSupabase
const DB_DISABLED = process.env.GAIALOG_NO_DB === 'true'
let dbWarned = false

// Keep the pool initialized so we can re-enable later without code churn.
export const dbPool = new Pool(connectionConfig)

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }> {
  // Temporary DB disable switch - non-destructive. Returns empty rows.
  if (DB_DISABLED) {
    if (!dbWarned) {
      console.warn('🗄️ Database disabled via GAIALOG_NO_DB=true. All queries return empty rows.')
      dbWarned = true
    }
    return { rows: [] as any }
  }
  const client = await dbPool.connect()
  try {
    const res = await client.query<T>(text, params)
    return { rows: res.rows }
  } finally {
    client.release()
  }
}

export async function ensureConnected(): Promise<void> {
  if (DB_DISABLED) return
  await query('SELECT 1')
}

export function getDbInfo(): { host: string; database: string; ssl: boolean } {
  return {
    host: connectionConfig.host,
    database: connectionConfig.database,
    ssl: shouldUseSSL,
  }
}


