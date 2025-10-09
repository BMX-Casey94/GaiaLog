import { Pool } from 'pg'

// SSL configuration: accept all certificates including self-signed
// This must be defined before creating the Pool to override PGSSLMODE env var
const sslConfig = {
  rejectUnauthorized: false,
  checkServerIdentity: () => undefined, // Skip server identity check
}

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

const shouldUseSSL = true

export const dbPool = new Pool(connectionConfig)

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
  return {
    host: connectionConfig.host,
    database: connectionConfig.database,
    ssl: shouldUseSSL,
  }
}


