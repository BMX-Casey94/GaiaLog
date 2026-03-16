/**
 * Reverse Geocoder Service
 *
 * Converts lat/lon coordinates into human-readable place names for the
 * explorer store, making air-quality (and other sensor-based) readings
 * searchable by city/region/country.
 *
 * Architecture:
 *   1. In-memory LRU cache (keyed by rounded coordinates) — instant
 *   2. Postgres lookup table (geocode_cache) — survives restarts
 *   3. External API call — only when both caches miss
 *
 * Provider priority (first configured key wins):
 *   - OpenCage  (OPENCAGE_API_KEY)
 *   - LocationIQ (LOCATIONIQ_API_KEY)
 *   - Nominatim  (no key, strict 1 req/s, User-Agent required — dev/fallback only)
 *
 * Coordinate rounding:  lat/lon are rounded to 2 decimal places (~1.1 km)
 * so nearby sensors share a single cached geocode result instead of each
 * triggering its own API call.
 */

import { cacheStore } from './stores'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GeocodedPlace {
  /** Display name, e.g. "Bistrița, Bistrița-Năsăud, Romania" */
  displayName: string
  /** City / town / village */
  city: string | null
  /** Admin region / county / state */
  region: string | null
  /** ISO 3166-1 alpha-2 country code */
  countryCode: string | null
  /** Full country name */
  country: string | null
}

// ─── Configuration ───────────────────────────────────────────────────────────

const COORD_PRECISION = 2
const MEMORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 h
const DB_CACHE_TTL_DAYS = 90
const API_TIMEOUT_MS = 8000
const MAX_DAILY_API_CALLS = Number(process.env.GEOCODE_MAX_DAILY_CALLS || 10000)
const ENABLED = process.env.GEOCODE_ENABLED !== 'false' // enabled by default

let _dailyCalls = 0
let _dailyResetDay = new Date().toISOString().slice(0, 10)

function resetDailyCounterIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10)
  if (today !== _dailyResetDay) {
    _dailyCalls = 0
    _dailyResetDay = today
  }
}

// ─── Coordinate helpers ──────────────────────────────────────────────────────

function roundCoord(v: number): number {
  return Math.round(v * 10 ** COORD_PRECISION) / 10 ** COORD_PRECISION
}

function cacheKey(lat: number, lon: number): string {
  return `geocode:${roundCoord(lat).toFixed(COORD_PRECISION)},${roundCoord(lon).toFixed(COORD_PRECISION)}`
}

// ─── Location string heuristics ──────────────────────────────────────────────

const COORD_LIKE_RE = /^\s*[\d.]+°[NSEW],?\s*[\d.]+°[NSEW]\s*$/i
const COUNTRY_CODE_COORD_RE = /^[A-Z]{2}\s*\([\d.°NSEW,\s]+\)\s*$/i
const GENERIC_SENSOR_RE = /^Sensor\s+\d+/i

/**
 * Returns true when the existing location string is missing, generic, or
 * purely coordinate-based — i.e. it would benefit from reverse geocoding.
 */
export function locationNeedsGeocoding(location: string | null | undefined): boolean {
  if (!location || !location.trim()) return true
  const s = location.trim()
  if (COORD_LIKE_RE.test(s)) return true
  if (COUNTRY_CODE_COORD_RE.test(s)) return true
  if (GENERIC_SENSOR_RE.test(s)) return true
  if (s.toLowerCase() === 'unknown') return true
  return false
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Reverse-geocode a coordinate pair to a human-readable place name.
 * Returns null if geocoding is disabled, the budget is exhausted, or
 * all providers fail.  Never throws — failures are swallowed so the
 * ingest pipeline is never blocked.
 */
export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<GeocodedPlace | null> {
  if (!ENABLED) return null
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  const key = cacheKey(lat, lon)

  // 1. In-memory cache
  const mem = await cacheStore.get<GeocodedPlace>(key)
  if (mem) return mem

  // 2. Postgres cache
  try {
    const dbResult = await queryDbCache(lat, lon)
    if (dbResult) {
      await cacheStore.set(key, dbResult, MEMORY_CACHE_TTL_MS)
      return dbResult
    }
  } catch {
    // DB unavailable — fall through to API
  }

  // 3. External API
  resetDailyCounterIfNeeded()
  if (_dailyCalls >= MAX_DAILY_API_CALLS) return null

  const place = await callProvider(lat, lon)
  if (!place) return null

  _dailyCalls++

  // Persist to both caches
  await cacheStore.set(key, place, MEMORY_CACHE_TTL_MS)
  void persistToDb(lat, lon, place).catch(() => {})

  return place
}

/**
 * Build a searchable, display-friendly location string from a geocoded place.
 * Examples: "Bistrița, Romania" or "Munich, Bavaria, Germany"
 */
export function buildDisplayLocation(place: GeocodedPlace): string {
  const parts: string[] = []
  if (place.city) parts.push(place.city)
  if (place.region && place.region !== place.city) parts.push(place.region)
  if (place.country) parts.push(place.country)
  return parts.length > 0 ? parts.join(', ') : place.displayName
}

// ─── Provider Dispatch ───────────────────────────────────────────────────────

async function callProvider(lat: number, lon: number): Promise<GeocodedPlace | null> {
  const rLat = roundCoord(lat)
  const rLon = roundCoord(lon)

  try {
    if (process.env.OPENCAGE_API_KEY) return await fetchOpenCage(rLat, rLon)
    if (process.env.LOCATIONIQ_API_KEY) return await fetchLocationIQ(rLat, rLon)
    return await fetchNominatim(rLat, rLon)
  } catch (err) {
    console.warn('[reverse-geocoder] provider error:', err instanceof Error ? err.message : err)
    return null
  }
}

// ─── OpenCage ────────────────────────────────────────────────────────────────

async function fetchOpenCage(lat: number, lon: number): Promise<GeocodedPlace | null> {
  const url = `https://api.opencagedata.com/geocode/v1/json?q=${lat}+${lon}&key=${process.env.OPENCAGE_API_KEY}&language=en&no_annotations=1&limit=1`
  const res = await fetchWithTimeout(url)
  if (!res.ok) return null
  const data = await res.json()
  const r = data?.results?.[0]
  if (!r) return null
  const c = r.components || {}
  return {
    displayName: r.formatted || '',
    city: c.city || c.town || c.village || c.hamlet || c.municipality || null,
    region: c.state || c.county || c.state_district || null,
    countryCode: c.country_code?.toUpperCase() || null,
    country: c.country || null,
  }
}

// ─── LocationIQ ──────────────────────────────────────────────────────────────

async function fetchLocationIQ(lat: number, lon: number): Promise<GeocodedPlace | null> {
  const url = `https://us1.locationiq.com/v1/reverse?key=${process.env.LOCATIONIQ_API_KEY}&lat=${lat}&lon=${lon}&format=json&accept-language=en`
  const res = await fetchWithTimeout(url)
  if (!res.ok) return null
  const data = await res.json()
  const a = data?.address || {}
  return {
    displayName: data?.display_name || '',
    city: a.city || a.town || a.village || a.hamlet || a.municipality || null,
    region: a.state || a.county || a.state_district || null,
    countryCode: a.country_code?.toUpperCase() || null,
    country: a.country || null,
  }
}

// ─── Nominatim (fallback) ────────────────────────────────────────────────────

let _lastNominatimCall = 0
const NOMINATIM_MIN_INTERVAL_MS = 1100

async function fetchNominatim(lat: number, lon: number): Promise<GeocodedPlace | null> {
  const now = Date.now()
  const wait = NOMINATIM_MIN_INTERVAL_MS - (now - _lastNominatimCall)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _lastNominatimCall = Date.now()

  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=en&zoom=10`
  const res = await fetchWithTimeout(url, { 'User-Agent': 'GaiaLog/1.0 (https://gaialog.io)' })
  if (!res.ok) return null
  const data = await res.json()
  const a = data?.address || {}
  return {
    displayName: data?.display_name || '',
    city: a.city || a.town || a.village || a.hamlet || a.municipality || null,
    region: a.state || a.county || a.state_district || null,
    countryCode: a.country_code?.toUpperCase() || null,
    country: a.country || null,
  }
}

// ─── Postgres Cache ──────────────────────────────────────────────────────────

async function queryDbCache(lat: number, lon: number): Promise<GeocodedPlace | null> {
  const { query: dbQuery } = await import('./db')
  const rLat = roundCoord(lat)
  const rLon = roundCoord(lon)
  const result = await dbQuery<{
    display_name: string
    city: string | null
    region: string | null
    country_code: string | null
    country: string | null
  }>(
    `SELECT display_name, city, region, country_code, country
     FROM geocode_cache
     WHERE rounded_lat = $1 AND rounded_lon = $2
       AND expires_at > NOW()
     LIMIT 1`,
    [rLat, rLon],
  )
  const row = result.rows?.[0]
  if (!row) return null
  return {
    displayName: row.display_name,
    city: row.city,
    region: row.region,
    countryCode: row.country_code,
    country: row.country,
  }
}

async function persistToDb(lat: number, lon: number, place: GeocodedPlace): Promise<void> {
  const { query: dbQuery } = await import('./db')
  const rLat = roundCoord(lat)
  const rLon = roundCoord(lon)
  await dbQuery(
    `INSERT INTO geocode_cache
       (rounded_lat, rounded_lon, display_name, city, region, country_code, country, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '${DB_CACHE_TTL_DAYS} days')
     ON CONFLICT (rounded_lat, rounded_lon) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       city = EXCLUDED.city,
       region = EXCLUDED.region,
       country_code = EXCLUDED.country_code,
       country = EXCLUDED.country,
       expires_at = EXCLUDED.expires_at`,
    [rLat, rLon, place.displayName, place.city, place.region, place.countryCode, place.country],
  )
}

// ─── Utility ─────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, extraHeaders?: Record<string, string>): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...extraHeaders },
    })
  } finally {
    clearTimeout(timer)
  }
}
