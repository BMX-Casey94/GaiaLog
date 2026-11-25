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

// Build connection config explicitly to override environment variables.
// All limits are tunable via env so we can adjust without redeploys.
const connectionConfig = {
  host: pgHost,
  port: resolvedPort,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gaialog',
  max: Math.max(1, Number(process.env.PGPOOL_MAX || 10)),
  ssl: sslConfig,
  connectionTimeoutMillis: Math.max(1000, Number(process.env.PG_CONNECT_TIMEOUT_MS || 15000)),
  idleTimeoutMillis: Math.max(1000, Number(process.env.PG_IDLE_TIMEOUT_MS || 30000)),
  // Keep pooler-side sessions short and predictable; clients are short-lived in
  // transaction mode so a tight statement timeout protects against runaway queries.
  statement_timeout: Math.max(0, Number(process.env.PG_STATEMENT_TIMEOUT_MS || 0)) || undefined,
  // TCP-level keepalives reduce the chance Supavisor silently reaps us as
  // "idle". Enabled by default; tunable via env without a redeploy.
  keepAlive: process.env.PG_TCP_KEEPALIVE !== 'false',
  keepAliveInitialDelayMillis: Math.max(
    1000,
    Number(process.env.PG_TCP_KEEPALIVE_DELAY_MS || 10_000),
  ),
}

const shouldUseSSL = !!isSupabase
const DB_DISABLED = process.env.GAIALOG_NO_DB === 'true'
let dbWarned = false
let poolInfoLogged = false

const MAX_QUERY_RETRIES = Math.max(0, Number(process.env.PGQUERY_RETRIES || 2))
const POOL_RETRY_BASE_MS = Math.max(100, Number(process.env.PGQUERY_RETRY_BASE_MS || 250))
// Errors that are safe to retry: transient pool/connection issues that usually
// resolve on the next attempt (idle client kicked by pooler, brief connection
// timeout under load, TLS reset, etc.). Application-level errors (constraint
// violations, syntax errors, etc.) are NOT included here.
const POOL_EXHAUSTION_RE =
  /MaxClientsInSessionMode|too many clients|too many connections|remaining connection slots|timeout exceeded when trying to connect|Connection terminated|ECONNRESET|ETIMEDOUT|EPIPE|DbHandler exited|server closed the connection unexpectedly/i

// Keep the pool initialized so we can re-enable later without code churn.
export const dbPool = new Pool(connectionConfig)

// CRITICAL: Without this listener, an idle-client error (e.g. Supavisor
// terminating an idle connection, "DbHandler exited", a transient TLS reset)
// emits an 'error' event on the Pool that has no handler, causing Node to
// crash the entire worker process with "Unhandled 'error' event". With the
// listener attached, the bad client is dropped silently and the pool keeps
// serving traffic through its other connections.
let lastPoolErrorLogAt = 0
let suppressedPoolErrorCount = 0
const POOL_ERROR_LOG_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.PG_POOL_ERROR_LOG_INTERVAL_MS || 30_000),
)

dbPool.on('error', (err) => {
  const now = Date.now()
  if (now - lastPoolErrorLogAt >= POOL_ERROR_LOG_INTERVAL_MS) {
    const suppressedNote =
      suppressedPoolErrorCount > 0
        ? ` (+${suppressedPoolErrorCount} suppressed in last ${Math.round(POOL_ERROR_LOG_INTERVAL_MS / 1000)}s)`
        : ''
    console.error(
      `🗄️  DB pool idle-client error (non-fatal, client dropped): ${err.message}${suppressedNote}`,
    )
    lastPoolErrorLogAt = now
    suppressedPoolErrorCount = 0
  } else {
    suppressedPoolErrorCount += 1
  }
})

// CRITICAL: pool.on('error') only catches errors on *idle* clients. Any
// client checked out via dbPool.connect() is the caller's responsibility:
// if Supavisor severs the TCP socket mid-query (common on transaction-mode
// pooling, port 6543), the in-flight client.query() promise rejects AND the
// underlying Connection emits an 'error' event on the Client object. Without
// a per-client listener, Node's EventEmitter throws "Unhandled 'error' event"
// and terminates the process, which manifests as a silent PM2 crash loop
// (no app-level stack trace, no OOM signal). Use this helper for every
// dbPool.connect() site so a stray disconnect becomes a logged warning
// instead of a process crash.
let lastClientErrorLogAt = 0
let suppressedClientErrorCount = 0
const CLIENT_ERROR_HANDLER_ATTACHED = Symbol.for('gaialog.pgClientErrorHandler')
export function attachClientErrorHandler(client: PoolClient): void {
  // Pool clients are reused; attaching on every checkout stacked listeners
  // until MaxListenersExceededWarning fired (seen during consolidate sweeps).
  const tagged = client as PoolClient & { [CLIENT_ERROR_HANDLER_ATTACHED]?: boolean }
  if (tagged[CLIENT_ERROR_HANDLER_ATTACHED]) return
  tagged[CLIENT_ERROR_HANDLER_ATTACHED] = true
  client.on('error', (err) => {
    const now = Date.now()
    if (now - lastClientErrorLogAt >= POOL_ERROR_LOG_INTERVAL_MS) {
      const suppressedNote =
        suppressedClientErrorCount > 0
          ? ` (+${suppressedClientErrorCount} suppressed in last ${Math.round(POOL_ERROR_LOG_INTERVAL_MS / 1000)}s)`
          : ''
      console.error(
        `🗄️  DB checked-out client error (non-fatal, client will be discarded): ${err.message}${suppressedNote}`,
      )
      lastClientErrorLogAt = now
      suppressedClientErrorCount = 0
    } else {
      suppressedClientErrorCount += 1
    }
  })
}

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
    let clientError: Error | null = null
    try {
      client = await dbPool.connect()
      attachClientErrorHandler(client)
      const res = await client.query<T>(text, params)
      return {
        rows: res.rows,
        rowCount: typeof res.rowCount === 'number' ? res.rowCount : res.rows.length,
        command: res.command || 'UNKNOWN',
      }
    } catch (error) {
      lastError = error
      // Tag the client for destruction on release if this was a connection-level
      // failure. Returning a half-broken client to the pool causes the next
      // caller to inherit the same crash.
      if (error instanceof Error && shouldRetryDbError(error)) {
        clientError = error
      }
      if (attempt < MAX_QUERY_RETRIES && shouldRetryDbError(error)) {
        await sleep(POOL_RETRY_BASE_MS * (attempt + 1))
        continue
      }
      throw error
    } finally {
      // pg accepts an Error to release(); the pool then destroys the client
      // instead of returning it. Safe even when clientError is null.
      client?.release(clientError ?? undefined)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Unknown database error'))
}

/**
 * Deadline for a single public-read statement, in milliseconds.
 *
 * Public read endpoints must answer before the reverse proxy gives up. The
 * pool's own `statement_timeout` is 0 (disabled) by default because long
 * retention/broadcast statements legitimately need minutes; that default must
 * not be inherited by request-scoped reads, or a slow plan turns into a hung
 * HTTP request and the proxy reports 502.
 */
const DEFAULT_READ_DEADLINE_MS = Math.max(
  500,
  Number(process.env.PG_READ_DEADLINE_MS || 4000),
)

export interface QueryDeadlineOptions {
  /** Hard cap for this statement. Defaults to `PG_READ_DEADLINE_MS` (4000ms). */
  timeoutMs?: number
  /** Included in timeout messages so the log names the failing read. */
  label?: string
}

/** Bound for the best-effort ROLLBACK issued after a failed read. */
const ROLLBACK_GRACE_MS = 250

/**
 * Run a single read-only statement under a hard deadline.
 *
 * The deadline covers the whole operation — pool checkout, BEGIN, the statement
 * and COMMIT — because any of those can stall:
 *
 *   1. `SET LOCAL statement_timeout` makes Postgres abort the statement itself,
 *      so a runaway plan stops consuming CPU even after the caller has left.
 *   2. A client-side race guarantees the caller is unblocked even when the
 *      socket stalls and the server never replies at all, and it also covers a
 *      checkout that waits on an exhausted pool.
 *
 * Failure handling is deliberately non-blocking. A ROLLBACK is attempted under
 * its own short grace period and the client is then released *with* the error,
 * which makes `pg-pool` destroy the connection instead of returning it to the
 * pool. Without that, a timed-out read would hand a connection with an open
 * transaction to the next caller, and awaiting the ROLLBACK itself would hang
 * on exactly the dead socket that caused the timeout.
 *
 * Use this for request-path reads only. Workers, migrations and retention
 * sweeps keep using `query()` with their own statement timeouts.
 */
export async function queryWithDeadline<T extends PgQueryResultRow = any>(
  text: string,
  params: any[] = [],
  options: QueryDeadlineOptions = {},
): Promise<QueryResult<T>> {
  if (DB_DISABLED) {
    if (!dbWarned) {
      console.warn('🗄️ Database disabled via GAIALOG_NO_DB=true. All queries return empty rows.')
      dbWarned = true
    }
    return { rows: [] as T[], rowCount: 0, command: 'DISABLED' }
  }

  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_READ_DEADLINE_MS))
  const label = options.label || 'query'

  let timer: NodeJS.Timeout | undefined
  let deadlineFired = false
  // Held in an object because TypeScript narrows a `let` assigned only inside a
  // closure to `never` at the catch/finally sites, even though the closure has
  // run by then.
  const held: { client: PoolClient | null } = { client: null }

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadlineFired = true
      reject(new Error(`${label} exceeded its ${timeoutMs}ms deadline`))
    }, timeoutMs)
    timer.unref?.()
  })

  // Never let the race's losing branch surface as an unhandled rejection.
  deadline.catch(() => {})

  const work = (async (): Promise<QueryResult<T>> => {
    const checkedOut = await dbPool.connect()
    held.client = checkedOut
    attachClientErrorHandler(checkedOut)

    if (deadlineFired) {
      // The race was already lost while this checkout was pending. Give the
      // connection straight back untouched rather than running the statement
      // for nobody, and make sure the catch below does not destroy it.
      held.client = null
      checkedOut.release()
      throw new Error(`${label} abandoned before the statement started`)
    }

    // An explicit transaction so `SET LOCAL` scopes the statement timeout to
    // this statement and never leaks onto the pooled session.
    await checkedOut.query('BEGIN')
    await checkedOut.query(`SET LOCAL statement_timeout = ${timeoutMs}`)

    const res = await checkedOut.query<T>(text, params)
    await checkedOut.query('COMMIT')
    return {
      rows: res.rows,
      rowCount: typeof res.rowCount === 'number' ? res.rowCount : res.rows.length,
      command: res.command || 'SELECT',
    }
  })()
  // The race may be lost while this work is still in flight, leaving its
  // eventual rejection unobserved. Node 22 terminates the process on an
  // unhandled rejection, so the chain is always marked handled here as well.
  work.catch(() => {})

  try {
    return await Promise.race([work, deadline])
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    const checkedOut = held.client
    if (checkedOut) {
      held.client = null
      await Promise.race([
        checkedOut.query('ROLLBACK').catch(() => {}),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ROLLBACK_GRACE_MS)
          t.unref?.()
        }),
      ])
      // Releasing with the error destroys the connection, so a half-consumed
      // or abandoned session never reaches the next caller.
      checkedOut.release(failure)
    }
    throw failure
  } finally {
    if (timer) clearTimeout(timer)
    // A checkout that resolves after we have already thrown is released here
    // rather than leaked; it was never used for a statement.
    held.client?.release()
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


