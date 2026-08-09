import { query } from '@/lib/db'

/**
 * One-shot relation bootstrap for tables that used to be created with
 * `CREATE TABLE IF NOT EXISTS` on every hot path.
 *
 * Prefer a cheap `to_regclass` probe. Only run DDL when the relation is
 * missing (fresh DB / pre-migration). Callers memoize the returned Promise
 * and may reset it on failure so a transient outage can retry.
 */
export async function ensureRelationExists(
  qualifiedName: string,
  createSql: string,
): Promise<void> {
  const existing = await query<{ reg: string | null }>(
    `SELECT to_regclass($1)::text AS reg`,
    [qualifiedName],
  )
  if (existing.rows[0]?.reg) return
  await query(createSql)
}

export async function ensureRelationsExist(
  qualifiedNames: string[],
  createSql: string,
): Promise<void> {
  if (qualifiedNames.length === 0) return
  const checks = qualifiedNames.map((_, i) => `to_regclass($${i + 1}) IS NOT NULL`).join(' AND ')
  const res = await query<{ ok: boolean }>(
    `SELECT (${checks}) AS ok`,
    qualifiedNames,
  )
  if (res.rows[0]?.ok) return
  await query(createSql)
}
