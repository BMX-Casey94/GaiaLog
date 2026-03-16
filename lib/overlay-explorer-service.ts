/**
 * Overlay Explorer Service
 *
 * Cached read model that mirrors the interface of supabase-explorer.ts.
 * Delegates to overlay-explorer-repository.ts for raw queries and adds
 * in-process caching with deduplication of in-flight requests.
 *
 * All public functions match the signatures expected by the explorer API
 * routes so the read-source switcher can substitute them transparently.
 */

import * as repo from './overlay-explorer-repository'
import type { SearchParams, SearchResult, LocationSuggestion } from './supabase-explorer'

// ─── Cache Configuration ─────────────────────────────────────────────────────

const SEARCH_CACHE_TTL_MS = Math.max(1000, Number(process.env.EXPLORER_SEARCH_CACHE_TTL_MS || 15000))
const LOCATION_CACHE_TTL_MS = Math.max(1000, Number(process.env.EXPLORER_LOCATION_CACHE_TTL_MS || 60000))
const STATS_CACHE_TTL_MS = Math.max(5000, Number(process.env.EXPLORER_STATS_CACHE_TTL_MS || 30000))
const SEARCH_CACHE_MAX = Math.max(16, Number(process.env.EXPLORER_SEARCH_CACHE_MAX_ENTRIES || 128))
const LOCATION_CACHE_MAX = Math.max(16, Number(process.env.EXPLORER_LOCATION_CACHE_MAX_ENTRIES || 256))

// ─── Generic Cache Utilities ─────────────────────────────────────────────────

interface CacheEntry<T> { value: T; expiresAt: number }

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) { cache.delete(key); return null }
  return entry.value
}

function setCached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  max: number,
): void {
  const now = Date.now()
  for (const [k, v] of cache) { if (v.expiresAt <= now) cache.delete(k) }
  while (cache.size >= max) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
  cache.set(key, { value, expiresAt: now + ttlMs })
}

function dedup<T>(inFlight: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) return existing
  const p = fn().finally(() => { inFlight.delete(key) })
  inFlight.set(key, p)
  return p
}

// ─── Search Cache ────────────────────────────────────────────────────────────

const _searchCache = new Map<string, CacheEntry<SearchResult>>()
const _searchInflight = new Map<string, Promise<SearchResult>>()

function searchCacheKey(params: SearchParams): string {
  return JSON.stringify({
    q: (params.q || '').trim().toLowerCase(),
    dataType: params.dataType || '',
    from: params.from || null,
    to: params.to || null,
    page: params.page || 1,
    pageSize: params.pageSize || 50,
  })
}

export async function searchReadings(params: SearchParams): Promise<SearchResult> {
  const key = searchCacheKey(params)
  const cached = getCached(_searchCache, key)
  if (cached) return cached

  return dedup(_searchInflight, key, async () => {
    const result = await repo.searchReadings(params)
    setCached(_searchCache, key, result, SEARCH_CACHE_TTL_MS, SEARCH_CACHE_MAX)
    return result
  })
}

// ─── Location Suggestions Cache ──────────────────────────────────────────────

const _locCache = new Map<string, CacheEntry<LocationSuggestion[]>>()
const _locInflight = new Map<string, Promise<LocationSuggestion[]>>()

function locCacheKey(q: string, dataType?: string, limit?: number): string {
  return JSON.stringify({
    q: (q || '').trim().toLowerCase(),
    dataType: dataType || '',
    limit: limit || 20,
  })
}

export async function getLocationSuggestions(
  q: string,
  dataType?: string,
  limit: number = 20,
): Promise<LocationSuggestion[]> {
  const key = locCacheKey(q, dataType, limit)
  const cached = getCached(_locCache, key)
  if (cached) return cached

  return dedup(_locInflight, key, async () => {
    const result = await repo.getLocationSuggestions(q, dataType, limit)
    setCached(_locCache, key, result, LOCATION_CACHE_TTL_MS, LOCATION_CACHE_MAX)
    return result
  })
}

// ─── Aggregates Cache ────────────────────────────────────────────────────────

let _aggregateCache: CacheEntry<{
  totalReadings: number
  uniqueLocations: number
  dateRange: { min: number | null; max: number | null }
  byType: Record<string, number>
}> | null = null

export async function getAggregates(params?: SearchParams): Promise<{
  totalReadings: number
  uniqueLocations: number
  dateRange: { min: number | null; max: number | null }
  byType: Record<string, number>
}> {
  const hasFilters = !!(params?.q || params?.dataType || params?.from || params?.to)

  if (!hasFilters && _aggregateCache && _aggregateCache.expiresAt > Date.now()) {
    return {
      ..._aggregateCache.value,
      byType: { ..._aggregateCache.value.byType },
      dateRange: { ..._aggregateCache.value.dateRange },
    }
  }

  const [stats, dateRange, uniqueLocations] = await Promise.all([
    repo.getStats(),
    repo.getDateRange(),
    repo.getUniqueLocationCount(),
  ])

  const result = {
    totalReadings: stats.totalReadings,
    uniqueLocations,
    dateRange,
    byType: stats.byType,
  }

  if (!hasFilters) {
    _aggregateCache = { value: result, expiresAt: Date.now() + STATS_CACHE_TTL_MS }
  }

  return result
}

// ─── Index Stats ─────────────────────────────────────────────────────────────

let _indexStatsCache: CacheEntry<{ totalReadings: number; lastBlock: number; lastUpdated: number }> | null = null

export async function getIndexStats(): Promise<{
  totalReadings: number
  lastBlock: number
  lastUpdated: number
}> {
  if (_indexStatsCache && _indexStatsCache.expiresAt > Date.now()) {
    return _indexStatsCache.value
  }
  const stats = await repo.getIndexStats()
  _indexStatsCache = { value: stats, expiresAt: Date.now() + STATS_CACHE_TTL_MS }
  return stats
}

// ─── Unique Location Count ───────────────────────────────────────────────────

let _locationCountCache: CacheEntry<number> | null = null

export async function getUniqueLocationCountFast(): Promise<number | null> {
  if (_locationCountCache && _locationCountCache.expiresAt > Date.now()) {
    return _locationCountCache.value
  }
  try {
    const count = await repo.getUniqueLocationCount()
    _locationCountCache = { value: count, expiresAt: Date.now() + STATS_CACHE_TTL_MS }
    return count
  } catch {
    return _locationCountCache?.value ?? null
  }
}

export function invalidateAggregateCache(): void {
  _aggregateCache = null
  _indexStatsCache = null
  _locationCountCache = null
}

// ─── Priority Alerts ─────────────────────────────────────────────────────────

const PRIORITY_ALERTS_CACHE_TTL_MS = Math.max(5000, Number(process.env.EXPLORER_PRIORITY_ALERTS_CACHE_TTL_MS || 30000))
let _priorityAlertsCache: CacheEntry<import('./overlay-explorer-repository').PriorityAlertRow[]> | null = null

export async function getPriorityAlerts(limit: number = 8): Promise<import('./overlay-explorer-repository').PriorityAlertRow[]> {
  if (_priorityAlertsCache && _priorityAlertsCache.expiresAt > Date.now()) {
    return _priorityAlertsCache.value
  }
  const alerts = await repo.getPriorityAlerts(limit)
  _priorityAlertsCache = { value: alerts, expiresAt: Date.now() + PRIORITY_ALERTS_CACHE_TTL_MS }
  return alerts
}

// ─── Latest Readings With Metrics ────────────────────────────────────────────

const LATEST_METRICS_CACHE_TTL_MS = Math.max(10000, Number(process.env.EXPLORER_LATEST_METRICS_CACHE_TTL_MS || 45000))
let _latestMetricsCache: CacheEntry<Awaited<ReturnType<typeof repo.getLatestReadingsWithMetrics>>> | null = null

export async function getLatestReadingsWithMetrics(
  families: string[],
): Promise<Awaited<ReturnType<typeof repo.getLatestReadingsWithMetrics>>> {
  if (_latestMetricsCache && _latestMetricsCache.expiresAt > Date.now()) {
    return _latestMetricsCache.value
  }
  const rows = await repo.getLatestReadingsWithMetrics(families)
  _latestMetricsCache = { value: rows, expiresAt: Date.now() + LATEST_METRICS_CACHE_TTL_MS }
  return rows
}
