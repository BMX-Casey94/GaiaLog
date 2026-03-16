import { Pool, type PoolClient, type QueryResultRow as PgQueryResultRow } from 'pg'

export interface QueryResult<T = any> {
  rows: T[]
  rowCount: number
  command: string
}

// SSL configuration for Supabase
// For localhost, disable SSL. For Supabase, use proper SSL with rejectUnauthorized: false
const pgHost = process.env.PGHOST || 'localhost'
const isSupabase = pgHost.includes('supabase.co') || pgHost.includes('pooler.supabase')
const isSupabasePooler = pgHost.includes('pooler.supabase')
const sslConfig = isSupabase ? { rejectUnauthorized: false } : false

// Supabase Supavisor:
// - 5432 = session mode (hard-capped by pool_size)
// - 6543 = transaction mode (safer for multi-process production traffic)
//
// If the app is pointed at the Supabase pooler and the configured port is the
// default session port, automatically switch to transaction mode unless the
// operator explicitly opts back in to session mode.
const requestedPort = Number(process.env.PGPORT || 0)
const forceSessionMode = process.env.PG_FORCE_SESSION_MODE === 'true'
const resolvedPort =
  isSupabasePooler && !forceSessionMode && (!requestedPort || requestedPort === 5432)
    ? 6543
    : Number(process.env.PGPORT || 5432)

// Build connection config explicitly to override environment variables
const connectionConfig = {
  host: pgHost,
  port: resolvedPort,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gaialog',
  max: Number(process.env.PGPOOL_MAX || 3),
  ssl: sslConfig,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
}

const shouldUseSSL = !!isSupabase
const DB_DISABLED = process.env.GAIALOG_NO_DB === 'true'
let dbWarned = false
let poolInfoLogged = false

const MAX_QUERY_RETRIES = Math.max(0, Number(process.env.PGQUERY_RETRIES || 2))
const POOL_RETRY_BASE_MS = Math.max(100, Number(process.env.PGQUERY_RETRY_BASE_MS || 250))
const POOL_EXHAUSTION_RE = /MaxClientsInSessionMode|too many clients|too many connections|remaining connection slots/i

// Keep the pool initialized so we can re-enable later without code churn.
export const dbPool = new Pool(connectionConfig)

// Drain pool on process exit so session-mode pooler connections are freed promptly
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    dbPool.end().catch(() => {})
  })
}

function shouldRetryDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return POOL_EXHAUSTION_RE.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function query<T extends PgQueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  // Temporary DB disable switch - non-destructive. Returns empty rows.
  if (DB_DISABLED) {
    if (!dbWarned) {
      console.warn('🗄️ Database disabled via GAIALOG_NO_DB=true. All queries return empty rows.')
      dbWarned = true
    }
    return { rows: [] as any, rowCount: 0, command: 'DISABLED' }
  }

  if (!poolInfoLogged) {
    poolInfoLogged = true
    const mode = isSupabasePooler
      ? (connectionConfig.port === 6543 ? 'transaction' : 'session')
      : 'direct'
    console.log(`🗄️ DB pool ready: host=${connectionConfig.host} port=${connectionConfig.port} mode=${mode} max=${connectionConfig.max}`)
    if (isSupabasePooler && connectionConfig.port === 5432) {
      console.warn('⚠️ Supabase pooler is using session mode on port 5432. Set PG_FORCE_SESSION_MODE=false or remove PGPORT to use transaction mode.')
    }
  }

  let lastError: unknown = null
  for (let attempt = 0; attempt <= MAX_QUERY_RETRIES; attempt++) {
    let client: PoolClient | null = null
    try {
      client = await dbPool.connect()
      const res = await client.query<T>(text, params)
      return {
        rows: res.rows,
        rowCount: typeof res.rowCount === 'number' ? res.rowCount : res.rows.length,
        command: res.command || 'UNKNOWN',
      }
    } catch (error) {
      lastError = error
      if (attempt < MAX_QUERY_RETRIES && shouldRetryDbError(error)) {
        await sleep(POOL_RETRY_BASE_MS * (attempt + 1))
        continue
      }
      throw error
    } finally {
      client?.release()
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Unknown database error'))
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


