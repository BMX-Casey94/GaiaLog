/**
 * Supabase-backed Explorer Store
 *
 * Replaces the JSON-file explorer-store with a PostgreSQL-backed solution
 * using the `explorer_readings` table in Supabase.
 *
 * Designed for 1M+ records with millisecond query times, full-text
 * location search (pg_trgm), proper pagination, and batch inserts.
 *
 * The blockchain remains the source of truth – this is an index layer.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

// ─── Types (same interface as the old explorer-store) ────────────────────────

export interface StoredReading {
  txid: string
  dataType: string
  location: string | null
  lat: number | null
  lon: number | null
  timestamp: number
  metrics: Record<string, any>
  provider: string | null
  blockHeight: number
  blockTime: number | null
}

export interface SearchParams {
  q?: string
  lat?: number
  lon?: number
  radiusMiles?: number
  dataType?: string
  from?: number // timestamp ms
  to?: number   // timestamp ms
  page?: number
  pageSize?: number
}

export interface SearchResult {
  items: StoredReading[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export interface LocationSuggestion {
  location: string
  dataType: string
  readingCount: number
  lastReading: number
  avgLat: number | null
  avgLon: number | null
}

interface AggregateResult {
  totalReadings: number
  uniqueLocations: number
  dateRange: { min: number | null; max: number | null }
  byType: Record<string, number>
}

// ─── Singleton Supabase Client ───────────────────────────────────────────────

let _client: SupabaseClient | null = null
let _unfilteredAggregateCache: { value: AggregateResult; expiresAt: number } | null = null
const AGGREGATE_CACHE_TTL_MS = 30000
const AGGREGATE_SCAN_PAGE_SIZE = 1000
let _locationKeysTableAvailable: boolean | null = null
let _locationKeysRetryAfterMs = 0

function getClient(): SupabaseClient {
  if (_client) return _client

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY – ' +
      'cannot initialise Supabase explorer store'
    )
  }

  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  return _client
}

// ─── Write Operations ────────────────────────────────────────────────────────

/**
 * Insert a single reading (deduplicates on txid via UNIQUE constraint).
 * Returns true if inserted, false if duplicate.
 */
export async function addReading(reading: StoredReading): Promise<boolean> {
  const sb = getClient()

  const { error } = await sb.from('explorer_readings').upsert(
    {
      txid: reading.txid,
      data_type: reading.dataType,
      location: reading.location,
      lat: reading.lat,
      lon: reading.lon,
      timestamp: new Date(reading.timestamp).toISOString(),
      metrics: reading.metrics,
      provider: reading.provider,
      block_height: reading.blockHeight,
      block_time: reading.blockTime ? new Date(reading.blockTime).toISOString() : null,
    },
    { onConflict: 'txid', ignoreDuplicates: true }
  )

  if (error) {
    console.error('Explorer addReading error:', error.message)
    return false
  }
  _unfilteredAggregateCache = null
  return true
}

/**
 * Batch insert readings. Uses upsert with ignoreDuplicates.
 * Returns count of successfully inserted rows.
 */
export async function addReadingsBatch(readings: StoredReading[]): Promise<number> {
  if (readings.length === 0) return 0

  const sb = getClient()
  const BATCH_SIZE = 500 // Supabase REST limit per request

  let inserted = 0

  for (let i = 0; i < readings.length; i += BATCH_SIZE) {
    const batch = readings.slice(i, i + BATCH_SIZE).map(r => ({
      txid: r.txid,
      data_type: r.dataType,
      location: r.location,
      lat: r.lat,
      lon: r.lon,
      timestamp: new Date(r.timestamp).toISOString(),
      metrics: r.metrics,
      provider: r.provider,
      block_height: r.blockHeight,
      block_time: r.blockTime ? new Date(r.blockTime).toISOString() : null,
    }))

    const { error, count } = await sb
      .from('explorer_readings')
      .upsert(batch, { onConflict: 'txid', ignoreDuplicates: true, count: 'exact' })

    if (error) {
      console.error(`Explorer batch insert error (offset ${i}):`, error.message)
    } else {
      inserted += count ?? batch.length
    }
  }

  if (inserted > 0) {
    _unfilteredAggregateCache = null
  }

  return inserted
}

// ─── Read Operations ─────────────────────────────────────────────────────────

/**
 * Search readings with filters, pagination, and full-text location search.
 */
export async function searchReadings(params: SearchParams): Promise<SearchResult> {
  const sb = getClient()
  const page = params.page || 1
  const pageSize = Math.min(params.pageSize || 50, 500)
  const offset = (page - 1) * pageSize

  // Build query
  let query = sb
    .from('explorer_readings')
    .select('*', { count: 'exact' })

  // Location text search (uses pg_trgm gin index)
  if (params.q && params.q.trim()) {
    query = query.ilike('location', `%${params.q.trim()}%`)
  }

  // Data type filter
  if (params.dataType) {
    query = query.eq('data_type', params.dataType)
  }

  // Date range
  if (params.from) {
    query = query.gte('timestamp', new Date(params.from).toISOString())
  }
  if (params.to) {
    query = query.lte('timestamp', new Date(params.to).toISOString())
  }

  // Order and paginate
  query = query
    .order('timestamp', { ascending: false })
    .range(offset, offset + pageSize - 1)

  const { data, error, count } = await query

  if (error) {
    console.error('Explorer search error:', error.message)
    return { items: [], total: 0, page, pageSize, hasMore: false }
  }

  const total = count ?? 0
  const items: StoredReading[] = (data || []).map(rowToReading)

  return {
    items,
    total,
    page,
    pageSize,
    hasMore: offset + items.length < total,
  }
}

/**
 * Fast path for unique location count.
 *
 * Reads from a precomputed `explorer_location_keys` table maintained by a DB
 * trigger. Returns null if the table is unavailable.
 */
export async function getUniqueLocationCountFast(): Promise<number | null> {
  if (_locationKeysTableAvailable === false && Date.now() < _locationKeysRetryAfterMs) {
    return null
  }

  const sb = getClient()
  const { count, error } = await sb
    .from('explorer_location_keys')
    .select('normalized_location', { count: 'exact', head: true })

  if (error) {
    const message = String(error.message || '')
    const code = String((error as any).code || '')
    const missingRelation =
      code === '42P01' ||
      message.toLowerCase().includes('relation') && message.toLowerCase().includes('does not exist')

    if (missingRelation) {
      if (_locationKeysTableAvailable !== false) {
        console.warn(
          'Explorer location keys table is missing. Apply DB migration to enable fast location counts.'
        )
      }
      _locationKeysTableAvailable = false
      _locationKeysRetryAfterMs = Date.now() + 60000
      return null
    }

    console.error('Explorer unique location fast count error:', error.message)
    return null
  }

  _locationKeysTableAvailable = true
  return typeof count === 'number' ? count : 0
}

/**
 * Get location suggestions for autocomplete.
 * Uses a SQL RPC for grouped/aggregated results.
 */
export async function getLocationSuggestions(
  searchText: string,
  dataType?: string,
  limit: number = 20
): Promise<LocationSuggestion[]> {
  const sb = getClient()

  // Build a raw aggregation query via RPC or inline SQL
  // Since Supabase JS doesn't support GROUP BY natively, we use an RPC
  // Fallback: fetch distinct locations with ILIKE
  let query = sb
    .from('explorer_readings')
    .select('location, data_type, lat, lon, timestamp')
    .not('location', 'is', null)

  if (searchText && searchText.trim()) {
    query = query.ilike('location', `%${searchText.trim()}%`)
  }

  if (dataType) {
    query = query.eq('data_type', dataType)
  }

  // Fetch a reasonable sample to aggregate client-side
  // (For millions of rows, an RPC function would be better – but this
  //  is fast enough for autocomplete with the pg_trgm index filtering)
  query = query
    .order('timestamp', { ascending: false })
    .limit(5000)

  const { data, error } = await query

  if (error || !data) {
    console.error('Explorer locations error:', error?.message)
    return []
  }

  // Aggregate client-side
  const statsMap = new Map<string, {
    location: string
    dataType: string
    count: number
    lastTs: number
    latSum: number
    lonSum: number
    coordCount: number
  }>()

  for (const row of data) {
    const loc = row.location as string
    const dt = row.data_type as string
    const key = `${loc.toLowerCase()}|${dt}`

    const existing = statsMap.get(key)
    const ts = new Date(row.timestamp).getTime()

    if (existing) {
      existing.count++
      if (ts > existing.lastTs) existing.lastTs = ts
      if (row.lat != null && row.lon != null) {
        existing.latSum += row.lat
        existing.lonSum += row.lon
        existing.coordCount++
      }
    } else {
      statsMap.set(key, {
        location: loc,
        dataType: dt,
        count: 1,
        lastTs: ts,
        latSum: row.lat ?? 0,
        lonSum: row.lon ?? 0,
        coordCount: (row.lat != null && row.lon != null) ? 1 : 0,
      })
    }
  }

  return Array.from(statsMap.values())
    .map(s => ({
      location: s.location,
      dataType: s.dataType,
      readingCount: s.count,
      lastReading: s.lastTs,
      avgLat: s.coordCount > 0 ? s.latSum / s.coordCount : null,
      avgLon: s.coordCount > 0 ? s.lonSum / s.coordCount : null,
    }))
    .sort((a, b) => b.readingCount - a.readingCount)
    .slice(0, limit)
}

/**
 * Get aggregate statistics (total readings, unique locations, date range, by type).
 */
export async function getAggregates(params?: SearchParams): Promise<{
  totalReadings: number
  uniqueLocations: number
  dateRange: { min: number | null; max: number | null }
  byType: Record<string, number>
}> {
  const hasFilters = !!(params?.q || params?.dataType || params?.from || params?.to)

  // Keep hot unfiltered hero stats fast and stable across quick refreshes.
  if (!hasFilters && _unfilteredAggregateCache && _unfilteredAggregateCache.expiresAt > Date.now()) {
    return {
      ..._unfilteredAggregateCache.value,
      byType: { ..._unfilteredAggregateCache.value.byType },
      dateRange: { ..._unfilteredAggregateCache.value.dateRange },
    }
  }

  const aggregates = await computeAggregatesDeterministic(params)

  if (!hasFilters) {
    _unfilteredAggregateCache = {
      value: aggregates,
      expiresAt: Date.now() + AGGREGATE_CACHE_TTL_MS,
    }
  }

  return aggregates
}

async function computeAggregatesDeterministic(params?: SearchParams): Promise<AggregateResult> {
  const sb = getClient()

  // Get an exact total using the same filters.
  let countQuery = sb
    .from('explorer_readings')
    .select('txid', { count: 'exact', head: true })
  countQuery = applySearchFilters(countQuery, params)

  const { count: totalCount, error: countError } = await countQuery
  if (countError) {
    throw new Error(`Failed to count explorer aggregates: ${countError.message}`)
  }

  const locations = new Set<string>()
  const byType: Record<string, number> = {}
  let min: number | null = null
  let max: number | null = null

  let lastTxid: string | null = null
  let guard = 0

  while (true) {
    let query = sb
      .from('explorer_readings')
      .select('txid, data_type, location, timestamp')
      .order('txid', { ascending: true })
      .limit(AGGREGATE_SCAN_PAGE_SIZE)

    query = applySearchFilters(query, params)

    if (lastTxid) {
      query = query.gt('txid', lastTxid)
    }

    const { data, error } = await query

    if (error) {
      throw new Error(`Failed to scan explorer aggregates: ${error.message}`)
    }

    if (!data || data.length === 0) {
      break
    }

    for (const row of data) {
      const dataType = typeof row.data_type === 'string' ? row.data_type : ''
      if (dataType) {
        byType[dataType] = (byType[dataType] || 0) + 1
      }

      const normalizedLocation = normaliseLocationKey(row.location)
      if (normalizedLocation) {
        locations.add(normalizedLocation)
      }

      const ts = new Date(row.timestamp as string).getTime()
      if (Number.isFinite(ts)) {
        if (min === null || ts < min) min = ts
        if (max === null || ts > max) max = ts
      }
    }

    lastTxid = String(data[data.length - 1].txid)
    if (data.length < AGGREGATE_SCAN_PAGE_SIZE) {
      break
    }

    // Safety guard to avoid endless loops if the cursor column is malformed.
    guard += 1
    if (guard > 100000) {
      throw new Error('Explorer aggregate scan exceeded safety limit')
    }
  }

  return {
    totalReadings: totalCount ?? 0,
    uniqueLocations: locations.size,
    dateRange: { min, max },
    byType,
  }
}

function applySearchFilters(query: any, params?: SearchParams): any {
  if (!params) return query

  if (params.q && params.q.trim()) {
    query = query.ilike('location', `%${params.q.trim()}%`)
  }

  if (params.dataType) {
    query = query.eq('data_type', params.dataType)
  }

  if (params.from) {
    query = query.gte('timestamp', new Date(params.from).toISOString())
  }

  if (params.to) {
    query = query.lte('timestamp', new Date(params.to).toISOString())
  }

  return query
}

function normaliseLocationKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalised = value.trim().toLowerCase()
  return normalised.length > 0 ? normalised : null
}

/**
 * Get index-level statistics.
 */
export async function getIndexStats(): Promise<{
  totalReadings: number
  lastBlock: number
  lastUpdated: number
}> {
  const sb = getClient()

  const { count } = await sb
    .from('explorer_readings')
    .select('*', { count: 'exact', head: true })

  const { data: lastBlockRow } = await sb
    .from('explorer_readings')
    .select('block_height, created_at')
    .order('block_height', { ascending: false })
    .limit(1)
    .single()

  return {
    totalReadings: count ?? 0,
    lastBlock: lastBlockRow?.block_height ?? 0,
    lastUpdated: lastBlockRow ? new Date(lastBlockRow.created_at).getTime() : Date.now(),
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a Supabase row to our StoredReading interface */
function rowToReading(row: any): StoredReading {
  return {
    txid: row.txid,
    dataType: row.data_type,
    location: row.location,
    lat: row.lat,
    lon: row.lon,
    timestamp: new Date(row.timestamp).getTime(),
    metrics: row.metrics || {},
    provider: row.provider,
    blockHeight: row.block_height,
    blockTime: row.block_time ? new Date(row.block_time).getTime() : null,
  }
}
