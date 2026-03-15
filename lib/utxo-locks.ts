import { query } from '@/lib/db'

export interface UtxoLockMetrics {
  pruneRuns: number
  lastPrunedAt: number | null
  lastExpiredReclaimed: number
  totalExpiredReclaimed: number
}

const _g = globalThis as any
if (!_g.__GAIALOG_UTXO_LOCK_METRICS__) {
  _g.__GAIALOG_UTXO_LOCK_METRICS__ = {
    pruneRuns: 0,
    lastPrunedAt: null,
    lastExpiredReclaimed: 0,
    totalExpiredReclaimed: 0,
  } satisfies UtxoLockMetrics
}
const lockMetrics: UtxoLockMetrics = _g.__GAIALOG_UTXO_LOCK_METRICS__

let PROCESS_OWNER_ID: string | null = null
export function getLockOwnerId(): string {
  if (!PROCESS_OWNER_ID) {
    const rand = Math.random().toString(36).slice(2, 10)
    PROCESS_OWNER_ID = `proc_${process.pid}_${rand}`
  }
  return PROCESS_OWNER_ID
}

let _locksTableReady: Promise<void> | null = null

export function ensureUtxoLocksTable(): Promise<void> {
  if (!_locksTableReady) {
    _locksTableReady = query(`
      CREATE TABLE IF NOT EXISTS utxo_locks (
        utxo_key text PRIMARY KEY,
        reserved_by text NOT NULL,
        reserved_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS utxo_locks_expires_idx ON utxo_locks(expires_at);
    `).then(() => {}).catch((err) => {
      _locksTableReady = null
      throw err
    })
  }
  return _locksTableReady
}

export async function pruneExpiredLocks(): Promise<number> {
  await ensureUtxoLocksTable()
  const res = await query<{ utxo_key: string }>(
    `DELETE FROM utxo_locks
     WHERE expires_at < now()
     RETURNING utxo_key`
  )
  const reclaimed = res.rowCount || res.rows.length || 0
  lockMetrics.pruneRuns += 1
  lockMetrics.lastPrunedAt = Date.now()
  lockMetrics.lastExpiredReclaimed = reclaimed
  lockMetrics.totalExpiredReclaimed += reclaimed
  if (reclaimed > 0) {
    console.log(`🧹 Reclaimed ${reclaimed} expired UTXO lock(s)`)
  }
  return reclaimed
}

// Compatibility adapter for existing callers while Phase 0 hardening lands.
export async function releaseAllExpiredLocks(): Promise<number> {
  return pruneExpiredLocks()
}

export function getUtxoLockMetrics(): UtxoLockMetrics {
  return { ...lockMetrics }
}

export async function reserveUtxoKeys(keys: string[], ownerId?: string, ttlMs: number = Number(process.env.BSV_UTXO_LOCK_TTL_MS || 2 * 60 * 1000)): Promise<string[]> {
  await ensureUtxoLocksTable()
  const owner = ownerId || getLockOwnerId()
  const reserved: string[] = []
  const ttlMsSafe = Math.max(1000, ttlMs)
  for (const key of keys) {
    try {
      const res = await query(
        `INSERT INTO utxo_locks (utxo_key, reserved_by, expires_at)
         VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'))
         ON CONFLICT (utxo_key) DO NOTHING
         RETURNING utxo_key`,
        [key, owner, ttlMsSafe]
      )
      if (res.rowCount > 0) reserved.push(key)
    } catch {}
  }
  return reserved
}

export async function releaseUtxoKeys(keys: string[], ownerId?: string): Promise<void> {
  if (!keys || keys.length === 0) return
  await ensureUtxoLocksTable()
  const owner = ownerId || getLockOwnerId()
  try {
    await query(`DELETE FROM utxo_locks WHERE utxo_key = ANY($1) AND reserved_by = $2`, [keys, owner])
  } catch {}
}

export async function getReservedUtxoKeys(keys: string[]): Promise<string[]> {
  if (!keys || keys.length === 0) return []
  await ensureUtxoLocksTable()
  try {
    const res = await query<{ utxo_key: string }>(
      `SELECT utxo_key
       FROM utxo_locks
       WHERE utxo_key = ANY($1)
         AND expires_at >= now()`,
      [keys]
    )
    return res.rows.map(row => row.utxo_key)
  } catch {
    return []
  }
}


