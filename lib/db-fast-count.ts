/**
 * Cheap row-count helpers for large reading tables.
 *
 * The admin data browsers and dashboard panels only need a headline total for
 * pagination, but the previous implementation ran an exact `COUNT(*)` over
 * the full table on EVERY request (even `limit=1` polls).  On multi-million
 * row tables that is a full scan per poll and was a major driver of the
 * database CPU-limit incidents.
 *
 * Strategy:
 *  - Unfiltered counts use the Postgres planner estimate (pg_class.reltuples),
 *    which is O(1) and kept accurate by autovacuum.  Good enough for
 *    pagination headlines.
 *  - Filtered counts still need the real query, but are cached in-process for
 *    a short TTL so repeat polls and page-throughs don't re-scan.
 */

import { query } from './db'

const COUNT_CACHE_TTL_MS = Math.max(5_000, Number(process.env.DB_COUNT_CACHE_TTL_MS || 60_000))
const COUNT_CACHE_MAX_ENTRIES = 200

const countCache = new Map<string, { total: number; ts: number }>()

/** O(1) planner estimate of a table's row count. Returns null pre-ANALYZE. */
export async function estimateTableCount(table: string): Promise<number | null> {
  const result = await query<{ cnt: string }>(
    `SELECT reltuples::bigint AS cnt FROM pg_class WHERE oid = $1::regclass`,
    [table],
  )
  const estimate = Number(result.rows?.[0]?.cnt ?? -1)
  return estimate >= 0 ? estimate : null
}

/**
 * Fast total for a table + optional WHERE clause.
 * `table` and `whereSql` must be trusted, code-defined strings — only the
 * bind parameters may carry user input.
 */
export async function fastTableCount(
  table: string,
  whereSql: string = '',
  params: unknown[] = [],
): Promise<number> {
  if (!whereSql.trim()) {
    const estimate = await estimateTableCount(table)
    if (estimate != null) return estimate
  }

  const cacheKey = `${table}|${whereSql}|${JSON.stringify(params)}`
  const cached = countCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < COUNT_CACHE_TTL_MS) {
    return cached.total
  }

  const result = await query<{ cnt: string }>(
    `SELECT COUNT(*)::bigint AS cnt FROM ${table} ${whereSql}`,
    params,
  )
  const total = Number(result.rows?.[0]?.cnt || 0)

  if (countCache.size >= COUNT_CACHE_MAX_ENTRIES) {
    const oldestKey = countCache.keys().next().value
    if (oldestKey !== undefined) countCache.delete(oldestKey)
  }
  countCache.set(cacheKey, { total, ts: Date.now() })

  return total
}
