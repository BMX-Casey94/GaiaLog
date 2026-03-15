/**
 * Explorer Read-Source & Write-Mode Router
 *
 * Single point of control for the explorer data path.  Governed by two
 * independent environment flags:
 *
 *   EXPLORER_READ_SOURCE   = legacy | shadow | overlay   (default: legacy)
 *   EXPLORER_WRITE_MODE    = legacy | dual   | overlay   (default: legacy)
 *
 * Read modes:
 *   legacy  – serve from supabase-explorer (current behaviour)
 *   shadow  – serve from supabase-explorer, query overlay in background,
 *             log mismatches for parity verification
 *   overlay – serve from overlay-explorer-service
 *
 * Write modes:
 *   legacy  – write to supabase-explorer only (current behaviour)
 *   dual    – write to both supabase-explorer AND overlay
 *   overlay – write to overlay only
 */

import {
  addReading as legacyAddReading,
  addReadingsBatch as legacyAddReadingsBatch,
  canAttemptExplorerWrite as legacyCanAttemptWrite,
  searchReadings as legacySearch,
  getAggregates as legacyAggregates,
  getLocationSuggestions as legacyLocations,
  getIndexStats as legacyIndexStats,
  getUniqueLocationCountFast as legacyLocationCount,
  type StoredReading,
  type SearchParams,
  type SearchResult,
  type LocationSuggestion,
} from './supabase-explorer'

import * as overlayService from './overlay-explorer-service'
import { upsertReading as overlayUpsert, upsertReadingsBatch as overlayUpsertBatch } from './overlay-explorer-repository'
import { toOverlayExplorerReading } from './explorer-decoder'

// ─── Configuration ───────────────────────────────────────────────────────────

export type ExplorerReadSource = 'legacy' | 'shadow' | 'overlay'
export type ExplorerWriteMode = 'legacy' | 'dual' | 'overlay'

const VALID_READ_SOURCES: ExplorerReadSource[] = ['legacy', 'shadow', 'overlay']
const VALID_WRITE_MODES: ExplorerWriteMode[] = ['legacy', 'dual', 'overlay']

let _cachedReadSource: ExplorerReadSource | null = null
let _cachedWriteMode: ExplorerWriteMode | null = null

export function getExplorerReadSource(): ExplorerReadSource {
  if (_cachedReadSource) return _cachedReadSource
  const raw = (process.env.EXPLORER_READ_SOURCE || 'legacy').trim().toLowerCase()
  _cachedReadSource = VALID_READ_SOURCES.includes(raw as ExplorerReadSource)
    ? (raw as ExplorerReadSource)
    : 'legacy'
  return _cachedReadSource
}

export function getExplorerWriteMode(): ExplorerWriteMode {
  if (_cachedWriteMode) return _cachedWriteMode
  const raw = (process.env.EXPLORER_WRITE_MODE || 'legacy').trim().toLowerCase()
  _cachedWriteMode = VALID_WRITE_MODES.includes(raw as ExplorerWriteMode)
    ? (raw as ExplorerWriteMode)
    : 'legacy'
  return _cachedWriteMode
}

// ─── Shadow Comparison Telemetry ─────────────────────────────────────────────

interface ShadowStats {
  comparisons: number
  mismatches: number
  overlayErrors: number
  lastMismatchAt: number | null
}

const _shadowStats: ShadowStats = {
  comparisons: 0,
  mismatches: 0,
  overlayErrors: 0,
  lastMismatchAt: null,
}

export function getShadowStats(): Readonly<ShadowStats> {
  return { ..._shadowStats }
}

const SHADOW_LOG_INTERVAL_MS = 60_000
let _lastShadowLog = 0

function logShadowMismatch(endpoint: string, legacyTotal: number, overlayTotal: number): void {
  _shadowStats.comparisons++
  if (legacyTotal !== overlayTotal) {
    _shadowStats.mismatches++
    _shadowStats.lastMismatchAt = Date.now()
  }

  const now = Date.now()
  if (now - _lastShadowLog > SHADOW_LOG_INTERVAL_MS) {
    if (_shadowStats.mismatches > 0 || _shadowStats.overlayErrors > 0) {
      console.warn(
        `[explorer-shadow] ${endpoint}: comparisons=${_shadowStats.comparisons} ` +
        `mismatches=${_shadowStats.mismatches} overlayErrors=${_shadowStats.overlayErrors}`,
      )
    }
    _lastShadowLog = now
  }
}

// ─── Write Router ────────────────────────────────────────────────────────────

export function canAttemptExplorerWrite(): boolean {
  const mode = getExplorerWriteMode()
  if (mode === 'overlay') return true
  return legacyCanAttemptWrite()
}

export async function addReading(
  reading: StoredReading,
  extra?: { providerId?: string | null; datasetId?: string | null },
): Promise<boolean> {
  const mode = getExplorerWriteMode()

  if (mode === 'legacy') {
    return legacyAddReading(reading)
  }

  if (mode === 'overlay') {
    try {
      const overlayReading = toOverlayExplorerReading(reading, extra)
      return await overlayUpsert(overlayReading)
    } catch (err) {
      console.warn('[explorer-write] overlay upsert failed:', err instanceof Error ? err.message : err)
      return false
    }
  }

  // dual mode
  const overlayReading = toOverlayExplorerReading(reading, extra)

  const [legacyResult, overlayResult] = await Promise.allSettled([
    legacyAddReading(reading),
    overlayUpsert(overlayReading),
  ])

  if (overlayResult.status === 'rejected') {
    console.warn('[explorer-write] overlay dual-write failed:', overlayResult.reason)
  }

  return legacyResult.status === 'fulfilled' ? legacyResult.value : false
}

export async function addReadingsBatch(
  readings: StoredReading[],
  extra?: { providerId?: string | null; datasetId?: string | null },
): Promise<number> {
  if (readings.length === 0) return 0

  const mode = getExplorerWriteMode()

  if (mode === 'legacy') {
    return legacyAddReadingsBatch(readings)
  }

  const overlayReadings = readings.map(r => toOverlayExplorerReading(r, extra))

  if (mode === 'overlay') {
    try {
      return await overlayUpsertBatch(overlayReadings)
    } catch (err) {
      console.warn('[explorer-write] overlay batch upsert failed:', err instanceof Error ? err.message : err)
      return 0
    }
  }

  // dual mode
  const [legacyResult, overlayResult] = await Promise.allSettled([
    legacyAddReadingsBatch(readings),
    overlayUpsertBatch(overlayReadings),
  ])

  if (overlayResult.status === 'rejected') {
    console.warn('[explorer-write] overlay dual-write batch failed:', overlayResult.reason)
  }

  return legacyResult.status === 'fulfilled' ? legacyResult.value : 0
}

// ─── Read Router ─────────────────────────────────────────────────────────────

export async function searchReadings(params: SearchParams): Promise<SearchResult> {
  const source = getExplorerReadSource()

  if (source === 'overlay') {
    return overlayService.searchReadings(params)
  }

  const legacyResult = await legacySearch(params)

  if (source === 'shadow') {
    void (async () => {
      try {
        const overlayResult = await overlayService.searchReadings(params)
        logShadowMismatch('search', legacyResult.total, overlayResult.total)
      } catch (err) {
        _shadowStats.overlayErrors++
        console.warn('[explorer-shadow] search overlay error:', err instanceof Error ? err.message : err)
      }
    })()
  }

  return legacyResult
}

export async function getAggregates(params?: SearchParams): Promise<{
  totalReadings: number
  uniqueLocations: number
  dateRange: { min: number | null; max: number | null }
  byType: Record<string, number>
}> {
  const source = getExplorerReadSource()

  if (source === 'overlay') {
    return overlayService.getAggregates(params)
  }

  const legacyResult = await legacyAggregates(params)

  if (source === 'shadow') {
    void (async () => {
      try {
        const overlayResult = await overlayService.getAggregates(params)
        logShadowMismatch('aggregates', legacyResult.totalReadings, overlayResult.totalReadings)
      } catch (err) {
        _shadowStats.overlayErrors++
      }
    })()
  }

  return legacyResult
}

export async function getLocationSuggestions(
  q: string,
  dataType?: string,
  limit: number = 20,
): Promise<LocationSuggestion[]> {
  const source = getExplorerReadSource()

  if (source === 'overlay') {
    return overlayService.getLocationSuggestions(q, dataType, limit)
  }

  const legacyResult = await legacyLocations(q, dataType, limit)

  if (source === 'shadow') {
    void (async () => {
      try {
        const overlayResult = await overlayService.getLocationSuggestions(q, dataType, limit)
        logShadowMismatch('locations', legacyResult.length, overlayResult.length)
      } catch (err) {
        _shadowStats.overlayErrors++
      }
    })()
  }

  return legacyResult
}

export async function getIndexStats(): Promise<{
  totalReadings: number
  lastBlock: number
  lastUpdated: number
}> {
  const source = getExplorerReadSource()

  if (source === 'overlay') {
    return overlayService.getIndexStats()
  }

  return legacyIndexStats()
}

export async function getUniqueLocationCountFast(): Promise<number | null> {
  const source = getExplorerReadSource()

  if (source === 'overlay') {
    return overlayService.getUniqueLocationCountFast()
  }

  return legacyLocationCount()
}

// Re-export types for convenience
export type { StoredReading, SearchParams, SearchResult, LocationSuggestion }
