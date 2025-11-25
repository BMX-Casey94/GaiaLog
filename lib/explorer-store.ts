/**
 * Database-less Explorer Store
 * 
 * Uses a JSON file to store decoded GaiaLog transactions from JungleBus.
 * This provides fast location/date queries without requiring PostgreSQL.
 * 
 * The JSON file can be rebuilt from JungleBus at any time since the
 * blockchain is the source of truth.
 */

import fs from 'fs'
import path from 'path'

// Types
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

export interface ExplorerIndex {
  version: number
  lastBlock: number
  lastUpdated: number
  processedCount: number
  readings: StoredReading[]
}

export interface SearchParams {
  q?: string
  lat?: number
  lon?: number
  radiusKm?: number
  dataType?: string
  from?: number // timestamp
  to?: number // timestamp
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

// File paths
const DATA_DIR = process.env.EXPLORER_DATA_DIR || path.join(process.cwd(), 'data')
const INDEX_FILE = path.join(DATA_DIR, 'explorer-index.json')
const CURSOR_FILE = path.join(DATA_DIR, 'junglebus-cursor.json')

// In-memory cache
let indexCache: ExplorerIndex | null = null
let indexCacheTime = 0
const CACHE_TTL_MS = 60000 // Reload from disk every 60 seconds

/**
 * Ensure data directory exists
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

/**
 * Load the index from disk (with caching)
 */
export function loadIndex(): ExplorerIndex {
  const now = Date.now()
  
  // Return cached if fresh
  if (indexCache && (now - indexCacheTime) < CACHE_TTL_MS) {
    return indexCache
  }
  
  ensureDataDir()
  
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const data = fs.readFileSync(INDEX_FILE, 'utf-8')
      indexCache = JSON.parse(data)
      indexCacheTime = now
      return indexCache!
    } catch (e) {
      console.error('Failed to load explorer index:', e)
    }
  }
  
  // Return empty index
  indexCache = {
    version: 1,
    lastBlock: 0,
    lastUpdated: now,
    processedCount: 0,
    readings: [],
  }
  indexCacheTime = now
  return indexCache
}

/**
 * Save the index to disk
 */
export function saveIndex(index: ExplorerIndex): void {
  ensureDataDir()
  index.lastUpdated = Date.now()
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2))
  indexCache = index
  indexCacheTime = Date.now()
}

/**
 * Add a reading to the index (deduplicates by txid)
 */
export function addReading(reading: StoredReading): boolean {
  const index = loadIndex()
  
  // Check for duplicate
  if (index.readings.some(r => r.txid === reading.txid)) {
    return false
  }
  
  index.readings.push(reading)
  index.processedCount++
  
  if (reading.blockHeight > index.lastBlock) {
    index.lastBlock = reading.blockHeight
  }
  
  // Don't save on every add - caller should batch and save
  indexCache = index
  return true
}

/**
 * Add multiple readings and save (for batch operations)
 */
export function addReadingsBatch(readings: StoredReading[]): number {
  const index = loadIndex()
  const existingTxids = new Set(index.readings.map(r => r.txid))
  
  let added = 0
  for (const reading of readings) {
    if (!existingTxids.has(reading.txid)) {
      index.readings.push(reading)
      existingTxids.add(reading.txid)
      added++
      
      if (reading.blockHeight > index.lastBlock) {
        index.lastBlock = reading.blockHeight
      }
    }
  }
  
  if (added > 0) {
    index.processedCount += added
    saveIndex(index)
  }
  
  return added
}

/**
 * Search readings with filters
 */
export function searchReadings(params: SearchParams): SearchResult {
  const index = loadIndex()
  const page = params.page || 1
  const pageSize = Math.min(params.pageSize || 50, 500)
  
  // Filter readings
  let filtered = index.readings.filter(r => {
    // Location text search
    if (params.q && params.q.trim()) {
      const query = params.q.toLowerCase().trim()
      const location = (r.location || '').toLowerCase()
      if (!location.includes(query)) {
        return false
      }
    }
    
    // Radius search
    if (params.lat !== undefined && params.lon !== undefined && params.radiusKm && r.lat && r.lon) {
      const distance = haversineDistance(params.lat, params.lon, r.lat, r.lon)
      if (distance > params.radiusKm) {
        return false
      }
    }
    
    // Data type filter
    if (params.dataType && r.dataType !== params.dataType) {
      return false
    }
    
    // Date range
    if (params.from && r.timestamp < params.from) {
      return false
    }
    if (params.to && r.timestamp > params.to) {
      return false
    }
    
    return true
  })
  
  // Sort by timestamp descending
  filtered.sort((a, b) => b.timestamp - a.timestamp)
  
  const total = filtered.length
  const offset = (page - 1) * pageSize
  const items = filtered.slice(offset, offset + pageSize)
  
  return {
    items,
    total,
    page,
    pageSize,
    hasMore: offset + items.length < total,
  }
}

/**
 * Get location suggestions for autocomplete
 */
export function getLocationSuggestions(
  searchText: string,
  dataType?: string,
  limit: number = 20
): LocationSuggestion[] {
  const index = loadIndex()
  
  // Build location stats
  const locationStats = new Map<string, {
    location: string
    dataType: string
    count: number
    lastTimestamp: number
    latSum: number
    lonSum: number
    coordCount: number
  }>()
  
  const query = searchText.toLowerCase().trim()
  
  for (const r of index.readings) {
    if (!r.location) continue
    
    // Filter by search text
    if (query && !r.location.toLowerCase().includes(query)) {
      continue
    }
    
    // Filter by data type
    if (dataType && r.dataType !== dataType) {
      continue
    }
    
    const key = `${r.location.toLowerCase()}|${r.dataType}`
    const existing = locationStats.get(key)
    
    if (existing) {
      existing.count++
      if (r.timestamp > existing.lastTimestamp) {
        existing.lastTimestamp = r.timestamp
      }
      if (r.lat && r.lon) {
        existing.latSum += r.lat
        existing.lonSum += r.lon
        existing.coordCount++
      }
    } else {
      locationStats.set(key, {
        location: r.location,
        dataType: r.dataType,
        count: 1,
        lastTimestamp: r.timestamp,
        latSum: r.lat || 0,
        lonSum: r.lon || 0,
        coordCount: r.lat && r.lon ? 1 : 0,
      })
    }
  }
  
  // Convert to array and sort by count
  const suggestions: LocationSuggestion[] = Array.from(locationStats.values())
    .map(s => ({
      location: s.location,
      dataType: s.dataType,
      readingCount: s.count,
      lastReading: s.lastTimestamp,
      avgLat: s.coordCount > 0 ? s.latSum / s.coordCount : null,
      avgLon: s.coordCount > 0 ? s.lonSum / s.coordCount : null,
    }))
    .sort((a, b) => b.readingCount - a.readingCount)
    .slice(0, limit)
  
  return suggestions
}

/**
 * Get aggregate statistics
 */
export function getAggregates(params?: SearchParams): {
  totalReadings: number
  uniqueLocations: number
  dateRange: { min: number | null; max: number | null }
  byType: Record<string, number>
} {
  const result = params ? searchReadings({ ...params, page: 1, pageSize: 999999 }) : { items: loadIndex().readings, total: 0 }
  const readings = result.items
  
  const locations = new Set<string>()
  const byType: Record<string, number> = {}
  let minDate: number | null = null
  let maxDate: number | null = null
  
  for (const r of readings) {
    if (r.location) locations.add(r.location.toLowerCase())
    
    byType[r.dataType] = (byType[r.dataType] || 0) + 1
    
    if (minDate === null || r.timestamp < minDate) minDate = r.timestamp
    if (maxDate === null || r.timestamp > maxDate) maxDate = r.timestamp
  }
  
  return {
    totalReadings: readings.length,
    uniqueLocations: locations.size,
    dateRange: { min: minDate, max: maxDate },
    byType,
  }
}

/**
 * Get index statistics
 */
export function getIndexStats(): {
  totalReadings: number
  lastBlock: number
  lastUpdated: number
  fileSizeBytes: number
} {
  const index = loadIndex()
  
  let fileSizeBytes = 0
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const stats = fs.statSync(INDEX_FILE)
      fileSizeBytes = stats.size
    }
  } catch {}
  
  return {
    totalReadings: index.readings.length,
    lastBlock: index.lastBlock,
    lastUpdated: index.lastUpdated,
    fileSizeBytes,
  }
}

// ============================================
// Cursor Management
// ============================================

export interface JunglebusCursor {
  subscriptionId: string
  lastBlock: number
  processedCount: number
  updatedAt: number
}

export function loadCursor(subscriptionId: string): JunglebusCursor | null {
  ensureDataDir()
  
  if (fs.existsSync(CURSOR_FILE)) {
    try {
      const data = fs.readFileSync(CURSOR_FILE, 'utf-8')
      const cursor = JSON.parse(data)
      if (cursor.subscriptionId === subscriptionId) {
        return cursor
      }
    } catch {}
  }
  
  return null
}

export function saveCursor(cursor: JunglebusCursor): void {
  ensureDataDir()
  cursor.updatedAt = Date.now()
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2))
}

// ============================================
// Helpers
// ============================================

/**
 * Calculate distance between two coordinates using Haversine formula
 */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371 // Earth's radius in km
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180)
}

/**
 * Clear the index (for testing/reset)
 */
export function clearIndex(): void {
  if (fs.existsSync(INDEX_FILE)) {
    fs.unlinkSync(INDEX_FILE)
  }
  indexCache = null
}

