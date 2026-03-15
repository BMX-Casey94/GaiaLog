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

  sqlParams.push(pageSize, offset)
  const limitIdx = sqlParams.length - 1
  const offsetIdx = sqlParams.length

  const result = await query<any>(
    `SELECT
       txid, data_family, location, lat, lon,
       reading_ts, provider_id, block_height, block_time,
       metrics_preview,
       COUNT(*) OVER()::bigint AS total_count
     FROM overlay_explorer_readings
     ${whereSql}
     ORDER BY reading_ts DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    sqlParams,
  )

  const rows = result.rows || []
  let total = rows.length > 0 ? Number(rows[0].total_count || 0) : 0

  if (rows.length === 0 && offset > 0) {
    const countResult = await query<{ total: string }>(
      `SELECT COUNT(*)::bigint AS total
       FROM overlay_explorer_readings
       ${whereSql}`,
      sqlParams.slice(0, sqlParams.length - 2),
    )
    total = Number(countResult.rows?.[0]?.total || 0)
  }

  const items: StoredReading[] = rows.map(overlayRowToStoredReading)

  return { items, total, page, pageSize, hasMore: offset + items.length < total }
}

export async function getLocationSuggestions(
  searchText: string,
  dataType?: string,
  limit: number = 20,
): Promise<LocationSuggestion[]> {
  const trimmed = searchText.trim()
  if (trimmed.length < 2) return []

  const sqlParams: unknown[] = [`%${trimmed.toLowerCase()}%`]
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
     WHERE normalized_location ILIKE $1
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

// ─── Internal Helpers ────────────────────────────────────────────────────────

function buildWhereClause(params: SearchParams): { whereSql: string; sqlParams: unknown[] } {
  const parts: string[] = []
  const sqlParams: unknown[] = []

  if (params.q?.trim()) {
    sqlParams.push(`%${params.q.trim()}%`)
    parts.push(`location ILIKE $${sqlParams.length}`)
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
