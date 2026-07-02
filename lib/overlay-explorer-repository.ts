/**
 * Overlay Explorer Repository
 *
 * Direct Postgres operations for the overlay_explorer_readings table and its
 * associated rollup tables.  Uses the shared pg Pool from lib/db.ts — no
 * Supabase REST overhead.
 *
 * Every public function is a thin SQL wrapper.  Business logic and caching
 * belong in overlay-explorer-service.ts.
 */

import { query } from './db'
import type { OverlayExplorerReading } from './explorer-decoder'
import { getDataFamilyFilterValues, normaliseDataFamily } from './stream-registry'
import type { SearchParams, StoredReading, LocationSuggestion } from './supabase-explorer'

// ─── Constants ───────────────────────────────────────────────────────────────

const COLS_PER_ROW = 13
const PG_PARAM_LIMIT = 65535
const MAX_BATCH_SIZE = Math.min(500, Math.floor(PG_PARAM_LIMIT / COLS_PER_ROW))

// ─── Write Operations ────────────────────────────────────────────────────────

export async function upsertReading(r: OverlayExplorerReading): Promise<boolean> {
  const result = await query(
    `INSERT INTO overlay_explorer_readings
       (txid, data_family, provider_id, dataset_id, location, normalized_location,
        lat, lon, reading_ts, block_height, block_time, confirmed, metrics_preview)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (txid) DO NOTHING`,
    [
      r.txid, r.dataFamily, r.providerId, r.datasetId,
      r.location, r.normalizedLocation,
      r.lat, r.lon, r.readingTs, r.blockHeight, r.blockTime,
      r.confirmed, JSON.stringify(r.metricsPreview),
    ],
  )
  return (result.rowCount ?? 0) > 0
}

export async function upsertReadingsBatch(readings: OverlayExplorerReading[]): Promise<number> {
  if (readings.length === 0) return 0

  let totalInserted = 0

  for (let offset = 0; offset < readings.length; offset += MAX_BATCH_SIZE) {
    const batch = readings.slice(offset, offset + MAX_BATCH_SIZE)
    const values: unknown[] = []
    const placeholders: string[] = []

    for (let i = 0; i < batch.length; i++) {
      const r = batch[i]
      const base = i * COLS_PER_ROW
      placeholders.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},` +
        `$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13})`,
      )
      values.push(
        r.txid, r.dataFamily, r.providerId, r.datasetId,
        r.location, r.normalizedLocation,
        r.lat, r.lon, r.readingTs, r.blockHeight, r.blockTime,
        r.confirmed, JSON.stringify(r.metricsPreview),
      )
    }

    const result = await query(
      `INSERT INTO overlay_explorer_readings
         (txid, data_family, provider_id, dataset_id, location, normalized_location,
          lat, lon, reading_ts, block_height, block_time, confirmed, metrics_preview)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (txid) DO NOTHING`,
      values,
    )
    totalInserted += result.rowCount ?? 0
  }

  return totalInserted
}

export async function confirmReading(
  txid: string,
  blockHeight: number,
  blockTime: Date | null,
): Promise<void> {
  await query(
    `UPDATE overlay_explorer_readings
        SET confirmed = true,
            block_height = GREATEST(block_height, $2),
            block_time = COALESCE($3, block_time)
      WHERE txid = $1 AND NOT confirmed`,
    [txid, blockHeight, blockTime],
  )
}

// ─── Read Operations ─────────────────────────────────────────────────────────

export async function searchReadings(params: SearchParams): Promise<{
  items: StoredReading[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}> {
  const page = params.page || 1
  const pageSize = Math.min(params.pageSize || 50, 500)
  const offset = (page - 1) * pageSize

  const { whereSql, sqlParams } = buildWhereClause(params)
  const whereParams = [...sqlParams]

  sqlParams.push(pageSize, offset)
  const limitIdx = sqlParams.length - 1
  const offsetIdx = sqlParams.length

  // Rows and total run in parallel.  The total avoids COUNT(*) OVER(), which
  // forced Postgres to count the entire filtered set on every page fetch.
  const [result, total] = await Promise.all([
    query<any>(
      `SELECT
         txid, data_family, location, lat, lon,
         reading_ts, provider_id, block_height, block_time,
         metrics_preview
       FROM overlay_explorer_readings
       ${whereSql}
       ORDER BY reading_ts DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      sqlParams,
    ),
    countSearchTotal(params, whereSql, whereParams),
  ])

  const rows = result.rows || []
  const items: StoredReading[] = rows.map(overlayRowToStoredReading)

  return { items, total, page, pageSize, hasMore: offset + items.length < total }
}

// ─── Search total helpers ────────────────────────────────────────────────────

const SEARCH_COUNT_CACHE_TTL_MS = Math.max(5000, Number(process.env.EXPLORER_SEARCH_COUNT_TTL_MS || 30000))
const SEARCH_COUNT_CACHE_MAX_ENTRIES = 200
const searchCountCache = new Map<string, { total: number; ts: number }>()

/**
 * Resolve the total row count for a search as cheaply as possible:
 *  1. Unfiltered search    → trigger-maintained overlay_explorer_stats rollup.
 *  2. Family-only filter   → trigger-maintained overlay_explorer_family_counts.
 *  3. Anything else        → COUNT(*) with a short in-process cache so repeat
 *                            pagination over the same filter set is free.
 */
async function countSearchTotal(
  params: SearchParams,
  whereSql: string,
  whereParams: unknown[],
): Promise<number> {
  const hasQuery = !!params.q?.trim()
  const hasDates = !!params.from || !!params.to

  // 1. Unfiltered (the default explorer page load).
  if (!hasQuery && !hasDates && !params.dataType) {
    const result = await query<{ stat_value: string }>(
      `SELECT stat_value FROM overlay_explorer_stats WHERE stat_key = 'total_readings'`,
    )
    return Number(result.rows?.[0]?.stat_value || 0)
  }

  // 2. Family filter only.
  if (!hasQuery && !hasDates && params.dataType) {
    const families = getDataFamilyFilterValues(params.dataType)
    if (families.length > 0) {
      const result = await query<{ total: string }>(
        `SELECT COALESCE(SUM(reading_count), 0)::bigint AS total
         FROM overlay_explorer_family_counts
         WHERE data_family = ANY($1)`,
        [families],
      )
      return Number(result.rows?.[0]?.total || 0)
    }
  }

  // 3. Filtered search — cached COUNT(*).
  const cacheKey = `${whereSql}|${JSON.stringify(whereParams)}`
  const cached = searchCountCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < SEARCH_COUNT_CACHE_TTL_MS) {
    return cached.total
  }

  const countResult = await query<{ total: string }>(
    `SELECT COUNT(*)::bigint AS total
     FROM overlay_explorer_readings
     ${whereSql}`,
    whereParams,
  )
  const total = Number(countResult.rows?.[0]?.total || 0)

  if (searchCountCache.size >= SEARCH_COUNT_CACHE_MAX_ENTRIES) {
    // Drop the oldest entry to bound memory (Map preserves insertion order).
    const oldestKey = searchCountCache.keys().next().value
    if (oldestKey !== undefined) searchCountCache.delete(oldestKey)
  }
  searchCountCache.set(cacheKey, { total, ts: Date.now() })

  return total
}

export async function getLocationSuggestions(
  searchText: string,
  dataType?: string,
  limit: number = 20,
): Promise<LocationSuggestion[]> {
  const trimmed = searchText.trim()
  if (trimmed.length < 2) return []

  const coordQuery = parseCoordinateQuery(trimmed)

  const sqlParams: unknown[] = []
  let locationFilter: string

  if (coordQuery) {
    sqlParams.push(
      coordQuery.lat - COORD_SEARCH_RADIUS_DEG,
      coordQuery.lat + COORD_SEARCH_RADIUS_DEG,
      coordQuery.lon - COORD_SEARCH_RADIUS_DEG,
      coordQuery.lon + COORD_SEARCH_RADIUS_DEG,
    )
    locationFilter = `avg_lat >= $1 AND avg_lat <= $2 AND avg_lon >= $3 AND avg_lon <= $4`
  } else {
    sqlParams.push(`%${trimmed.toLowerCase()}%`)
    locationFilter = `normalized_location ILIKE $1`
  }

  let familyFilter = ''
  if (dataType) {
    const families = getDataFamilyFilterValues(dataType)
    if (families.length === 1) {
      sqlParams.push(families[0])
      familyFilter = `AND data_family = $${sqlParams.length}`
    } else if (families.length > 1) {
      sqlParams.push(families)
      familyFilter = `AND data_family = ANY($${sqlParams.length})`
    }
  }

  sqlParams.push(Math.min(limit, 50))

  const result = await query<any>(
    `SELECT
       display_location,
       data_family,
       reading_count,
       last_reading_ts,
       avg_lat,
       avg_lon
     FROM overlay_explorer_location_keys
     WHERE ${locationFilter}
       ${familyFilter}
     ORDER BY reading_count DESC
     LIMIT $${sqlParams.length}`,
    sqlParams,
  )

  return (result.rows || []).map((row: any) => ({
    location: row.display_location,
    dataType: normaliseDataFamily(row.data_family) || row.data_family,
    readingCount: Number(row.reading_count),
    lastReading: new Date(row.last_reading_ts).getTime(),
    avgLat: row.avg_lat != null ? Number(row.avg_lat) : null,
    avgLon: row.avg_lon != null ? Number(row.avg_lon) : null,
  }))
}

export async function getUniqueLocationCount(): Promise<number> {
  // Planner estimate first: O(1) regardless of table size and immune to the
  // DB CPU saturation that made the exact COUNT(*) time out.  Autovacuum
  // keeps reltuples accurate enough for a headline stat.  Fall back to the
  // exact count only when the table has never been analysed (reltuples < 0).
  const estimateResult = await query<{ cnt: string }>(
    `SELECT reltuples::bigint AS cnt
     FROM pg_class
     WHERE oid = 'overlay_explorer_location_keys'::regclass`,
  )
  const estimate = Number(estimateResult.rows?.[0]?.cnt ?? -1)
  if (estimate >= 0) return estimate

  const result = await query<{ cnt: string }>(
    `SELECT COUNT(*)::bigint AS cnt FROM overlay_explorer_location_keys`,
  )
  return Number(result.rows?.[0]?.cnt || 0)
}

export async function getStats(): Promise<{
  totalReadings: number
  totalConfirmed: number
  byType: Record<string, number>
}> {
  const [statsResult, familyResult] = await Promise.all([
    query<{ stat_key: string; stat_value: string }>(
      `SELECT stat_key, stat_value FROM overlay_explorer_stats`,
    ),
    query<{ data_family: string; reading_count: string }>(
      `SELECT data_family, reading_count FROM overlay_explorer_family_counts ORDER BY reading_count DESC`,
    ),
  ])

  let totalReadings = 0
  let totalConfirmed = 0
  for (const row of statsResult.rows || []) {
    if (row.stat_key === 'total_readings') totalReadings = Number(row.stat_value)
    if (row.stat_key === 'total_confirmed') totalConfirmed = Number(row.stat_value)
  }

  const byType: Record<string, number> = {}
  for (const row of familyResult.rows || []) {
    const family = normaliseDataFamily(row.data_family) || row.data_family
    byType[family] = (byType[family] || 0) + Number(row.reading_count)
  }

  return { totalReadings, totalConfirmed, byType }
}

/**
 * All-time pruned-row aggregates per data family.
 *
 * Reads from overlay_explorer_archive_totals, which the AFTER DELETE trigger
 * on overlay_explorer_readings maintains transactionally on every retention
 * pass.  These rows represent records that have been removed from Supabase
 * to control storage / egress, but which remain immutable on the BSV chain
 * itself and can be backfilled at any time via explorer-sync.
 *
 * Returns zeroes if the trigger / table has not been deployed yet.
 */
export async function getArchivedTotals(): Promise<{
  totalArchived: number
  totalArchivedConfirmed: number
  byFamily: Record<string, number>
}> {
  try {
    const result = await query<{ data_family: string; pruned_count: string; pruned_confirmed_count: string }>(
      `SELECT data_family, pruned_count::text, pruned_confirmed_count::text
         FROM overlay_explorer_archive_totals`,
    )

    let totalArchived = 0
    let totalArchivedConfirmed = 0
    const byFamily: Record<string, number> = {}
    for (const row of result.rows || []) {
      const family = normaliseDataFamily(row.data_family) || row.data_family
      const count = Number(row.pruned_count || 0)
      const conf = Number(row.pruned_confirmed_count || 0)
      byFamily[family] = (byFamily[family] || 0) + count
      totalArchived += count
      totalArchivedConfirmed += conf
    }
    return { totalArchived, totalArchivedConfirmed, byFamily }
  } catch (err) {
    // Pre-migration deployments will hit "relation does not exist".  Treat as
    // a zero archive so the stats endpoint stays healthy until 0020 is run.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.toLowerCase().includes('does not exist')) {
      return { totalArchived: 0, totalArchivedConfirmed: 0, byFamily: {} }
    }
    throw err
  }
}

export async function getIndexStats(): Promise<{
  totalReadings: number
  lastBlock: number
  lastUpdated: number
}> {
  const [countResult, lastBlockResult] = await Promise.all([
    query<{ cnt: string }>(
      `SELECT stat_value::bigint AS cnt FROM overlay_explorer_stats WHERE stat_key = 'total_readings'`,
    ),
    query<{ block_height: number; admitted_at: string }>(
      `SELECT block_height, admitted_at
       FROM overlay_explorer_readings
       WHERE block_height > 0
       ORDER BY block_height DESC
       LIMIT 1`,
    ),
  ])

  return {
    totalReadings: Number(countResult.rows?.[0]?.cnt || 0),
    lastBlock: lastBlockResult.rows?.[0]?.block_height ?? 0,
    lastUpdated: lastBlockResult.rows?.[0]?.admitted_at
      ? new Date(lastBlockResult.rows[0].admitted_at).getTime()
      : Date.now(),
  }
}

export async function getDateRange(): Promise<{ min: number | null; max: number | null }> {
  const result = await query<{ min_ts: string | null; max_ts: string | null }>(
    `SELECT
       MIN(reading_ts) AS min_ts,
       MAX(reading_ts) AS max_ts
     FROM overlay_explorer_readings`,
  )
  const row = result.rows?.[0]
  return {
    min: row?.min_ts ? new Date(row.min_ts).getTime() : null,
    max: row?.max_ts ? new Date(row.max_ts).getTime() : null,
  }
}

export interface PriorityAlertRow {
  txid: string
  data_family: string
  location: string | null
  lat: number | null
  lon: number | null
  reading_ts: string
  metrics_preview: Record<string, unknown>
  block_height: number
  confirmed: boolean
}

export async function getPriorityAlerts(limit: number = 8): Promise<PriorityAlertRow[]> {
  const result = await query<PriorityAlertRow>(
    `SELECT txid, data_family, location, lat, lon, reading_ts, metrics_preview, block_height, confirmed
     FROM overlay_explorer_readings
     WHERE reading_ts > NOW() - INTERVAL '7 days'
       AND (
         (data_family = 'seismic_activity' AND COALESCE((metrics_preview->>'magnitude')::float, 0) >= 5)
         OR (data_family = 'air_quality' AND (
           COALESCE((metrics_preview->>'aqi')::int, 0) > 150
           OR COALESCE((metrics_preview->>'pm25')::float, 0) > 55
         ))
         OR (data_family = 'water_levels' AND COALESCE((metrics_preview->>'river_level')::float, COALESCE((metrics_preview->>'sea_level')::float, 0)) > 4)
         OR (data_family = 'advanced_metrics' AND COALESCE((metrics_preview->>'environmental_quality_score')::float, 1) < 0.5)
         OR (data_family = 'flood_risk')
         OR (data_family = 'volcanic_activity')
         OR (data_family = 'natural_events')
         OR (data_family = 'space_weather')
         OR (data_family = 'geomagnetism')
         OR (data_family = 'upper_atmosphere')
         OR (data_family = 'hydrology')
         OR (data_family = 'conservation_status')
         OR (data_family = 'biodiversity')
         OR (data_family = 'land_use_change')
         OR (data_family = 'mining_activity')
         OR (data_family = 'transport_tracking')
         OR (data_family = 'planning_development')
       )
     ORDER BY reading_ts DESC
     LIMIT $1`,
    [Math.min(limit, 50)],
  )
  return result.rows || []
}

export async function getLatestReadingsWithMetrics(
  families: string[],
): Promise<Array<{
  txid: string
  data_family: string
  location: string | null
  reading_ts: string
  provider_id: string | null
  metrics_preview: Record<string, unknown>
  block_height: number
  confirmed: boolean
}>> {
  if (families.length === 0) return []
  const result = await query<{
    txid: string
    data_family: string
    location: string | null
    reading_ts: string
    provider_id: string | null
    metrics_preview: Record<string, unknown>
    block_height: number
    confirmed: boolean
  }>(
    `SELECT DISTINCT ON (data_family)
       txid, data_family, location, reading_ts, provider_id, metrics_preview, block_height, confirmed
     FROM overlay_explorer_readings
     WHERE data_family = ANY($1::text[])
       AND reading_ts > NOW() - INTERVAL '7 days'
       AND (confirmed = true OR reading_ts > NOW() - INTERVAL '2 hours')
     ORDER BY data_family, confirmed DESC, reading_ts DESC`,
    [families],
  )
  return result.rows || []
}

export async function getRecentReadingsByFamily(
  families: string[],
  limitPerFamily: number = 1,
): Promise<Array<{ txid: string; data_family: string; location: string | null; reading_ts: string; provider_id: string | null; block_height: number; confirmed: boolean }>> {
  if (families.length === 0) return []

  const result = await query<{
    txid: string
    data_family: string
    location: string | null
    reading_ts: string
    provider_id: string | null
    block_height: number
    confirmed: boolean
  }>(
    `SELECT DISTINCT ON (data_family)
       txid, data_family, location, reading_ts, provider_id, block_height, confirmed
     FROM overlay_explorer_readings
     WHERE data_family = ANY($1::text[])
       AND reading_ts > NOW() - INTERVAL '7 days'
       AND (confirmed = true OR reading_ts > NOW() - INTERVAL '2 hours')
     ORDER BY data_family, confirmed DESC, reading_ts DESC`,
    [families],
  )
  return result.rows || []
}

/**
 * Remove an unconfirmed reading whose TXID was never mined (e.g. mempool eviction).
 * Only deletes if `confirmed = false` to prevent accidental removal of confirmed data.
 */
export async function removeUnconfirmedReading(txid: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM overlay_explorer_readings WHERE txid = $1 AND confirmed = false`,
    [txid],
  )
  return (result.rowCount ?? 0) > 0
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Detect if a search string looks like a lat/lon coordinate pair.
 * Accepts formats like "47.14, 24.48", "47.14 24.48", "-33.87, 151.21"
 */
function parseCoordinateQuery(q: string): { lat: number; lon: number } | null {
  const cleaned = q.trim().replace(/°[NSEW]/gi, '')
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/)
  if (!match) return null
  const lat = parseFloat(match[1])
  const lon = parseFloat(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return { lat, lon }
}

const COORD_SEARCH_RADIUS_DEG = 0.5

function buildWhereClause(params: SearchParams): { whereSql: string; sqlParams: unknown[] } {
  const parts: string[] = []
  const sqlParams: unknown[] = []

  if (params.q?.trim()) {
    const coordQuery = parseCoordinateQuery(params.q.trim())
    if (coordQuery) {
      sqlParams.push(coordQuery.lat - COORD_SEARCH_RADIUS_DEG)
      parts.push(`lat >= $${sqlParams.length}`)
      sqlParams.push(coordQuery.lat + COORD_SEARCH_RADIUS_DEG)
      parts.push(`lat <= $${sqlParams.length}`)
      sqlParams.push(coordQuery.lon - COORD_SEARCH_RADIUS_DEG)
      parts.push(`lon >= $${sqlParams.length}`)
      sqlParams.push(coordQuery.lon + COORD_SEARCH_RADIUS_DEG)
      parts.push(`lon <= $${sqlParams.length}`)
    } else {
      // Filter on normalized_location (lowercased at ingest) so the GIN
      // trigram index oer_location_trgm_idx is used instead of a seq scan.
      sqlParams.push(`%${params.q.trim().toLowerCase()}%`)
      parts.push(`normalized_location ILIKE $${sqlParams.length}`)
    }
  }

  if (params.dataType) {
    const families = getDataFamilyFilterValues(params.dataType)
    if (families.length === 1) {
      sqlParams.push(families[0])
      parts.push(`data_family = $${sqlParams.length}`)
    } else if (families.length > 1) {
      sqlParams.push(families)
      parts.push(`data_family = ANY($${sqlParams.length})`)
    }
  }

  if (params.from) {
    sqlParams.push(new Date(params.from).toISOString())
    parts.push(`reading_ts >= $${sqlParams.length}`)
  }

  if (params.to) {
    sqlParams.push(new Date(params.to).toISOString())
    parts.push(`reading_ts <= $${sqlParams.length}`)
  }

  const whereSql = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''
  return { whereSql, sqlParams }
}

function overlayRowToStoredReading(row: any): StoredReading {
  const dataType = normaliseDataFamily(row.data_family) || row.data_family

  const metrics: Record<string, any> =
    row.metrics_preview && typeof row.metrics_preview === 'object'
      ? { ...row.metrics_preview }
      : typeof row.metrics_preview === 'string'
        ? JSON.parse(row.metrics_preview)
        : {}

  if (metrics.lat == null && row.lat != null) metrics.lat = row.lat
  if (metrics.lon == null && row.lon != null) metrics.lon = row.lon
  if (metrics.latitude == null && row.lat != null) metrics.latitude = row.lat
  if (metrics.longitude == null && row.lon != null) metrics.longitude = row.lon

  return {
    txid: row.txid,
    dataType,
    location: row.location,
    lat: row.lat != null ? Number(row.lat) : null,
    lon: row.lon != null ? Number(row.lon) : null,
    timestamp: new Date(row.reading_ts).getTime(),
    metrics,
    provider: row.provider_id,
    blockHeight: row.block_height ?? 0,
    blockTime: row.block_time ? new Date(row.block_time).getTime() : null,
  }
}
