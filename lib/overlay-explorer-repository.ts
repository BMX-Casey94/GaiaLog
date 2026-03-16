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
      sqlParams.push(`%${params.q.trim()}%`)
      parts.push(`location ILIKE $${sqlParams.length}`)
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
