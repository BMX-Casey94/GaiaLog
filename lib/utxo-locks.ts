import { query } from '@/lib/db'

let PROCESS_OWNER_ID: string | null = null
export function getLockOwnerId(): string {
  if (!PROCESS_OWNER_ID) {
    const rand = Math.random().toString(36).slice(2, 10)
    PROCESS_OWNER_ID = `proc_${process.pid}_${rand}`
  }
  return PROCESS_OWNER_ID
}

export async function ensureUtxoLocksTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS utxo_locks (
      utxo_key text PRIMARY KEY,
      reserved_by text NOT NULL,
      reserved_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS utxo_locks_expires_idx ON utxo_locks(expires_at);
  `)
}

export async function pruneExpiredLocks(): Promise<void> {
  await ensureUtxoLocksTable()
  await query(`DELETE FROM utxo_locks WHERE expires_at < now()`) // best-effort
}

export async function reserveUtxoKeys(keys: string[], ownerId?: string, ttlMs: number = Number(process.env.BSV_UTXO_LOCK_TTL_MS || 2 * 60 * 1000)): Promise<string[]> {
  await ensureUtxoLocksTable()
  const owner = ownerId || getLockOwnerId()
  const reserved: string[] = []
  const expiresAt = new Date(Date.now() + Math.max(1000, ttlMs))
  for (const key of keys) {
    try {
      const res = await query(
        `INSERT INTO utxo_locks (utxo_key, reserved_by, expires_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (utxo_key) DO NOTHING
         RETURNING utxo_key`,
        [key, owner, expiresAt]
      )
      if ((res as any).rowCount > 0) reserved.push(key)
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


