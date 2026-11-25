/**
 * Latest environmental reading per family for the public widget endpoints.
 *
 * The four `/api/{air-quality,advanced-metrics,water-levels,seismic}` routes used
 * to call the live collector on every request: `collectAirQualityData()` and
 * friends hit the upstream providers, inserted a row, and then attempted an
 * on-chain write. When a provider was slow, rate-limited, or unkeyed on the
 * serving process the collector returned `null`, and the route answered 502 Bad
 * Gateway. Worse, an anonymous GET could trigger a blockchain write whenever the
 * serving process ran with `GAIALOG_WORKER_PROCESS=1`.
 *
 * This module serves what the workers have already persisted. Two sources are
 * read in parallel and the newest usable candidate wins:
 *
 *   1. The legacy reading table (`air_quality_readings`, …) — dense and usually
 *      the freshest air, water and seismic data.
 *   2. The overlay explorer row (`overlay_explorer_readings`) — the canonical
 *      chained copy. It outlives legacy retention pruning, and for
 *      `advanced_metrics` it is the only source still being written.
 *
 * Neither read can hang: both are bounded by `queryWithDeadline`, the two are
 * fetched concurrently under one deadline budget, and each family is wrapped in
 * a stale-while-revalidate cache so a traffic spike costs at most one database
 * round-trip per TTL window.
 *
 * Nothing here invents data. A metric the source did not carry is returned as
 * `null` — never defaulted to `0` — so a caller cannot render "AQI 0, Good" for
 * a reading that simply had no AQI.
 */

import { queryWithDeadline } from './db'
import { ServerSwrCache, type SwrResult } from './server-swr-cache'

// ─── Tunables ────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number, min: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback
}

/**
 * Budget for a family refresh, covering both source reads because they run
 * concurrently. Kept well under the reverse proxy's timeout: the point of this
 * module is that these endpoints answer quickly and never 502.
 */
const REFRESH_BUDGET_MS = envInt('ENV_LATEST_REFRESH_BUDGET_MS', 4000, 250)
/** How long a resolved reading is served before a background refresh. */
const CACHE_TTL_MS = envInt('ENV_LATEST_CACHE_TTL_MS', 20_000, 1_000)

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReadingOrigin = 'legacy' | 'overlay'

export interface LatestAirQuality {
  origin: ReadingOrigin
  provider: string | null
  location: string | null
  lat: number | null
  lon: number | null
  collectedAt: string
  aqi: number | null
  pm25: number | null
  pm10: number | null
  co: number | null
  no2: number | null
  o3: number | null
  so2: number | null
  temperatureC: number | null
  humidityPct: number | null
  pressureMb: number | null
  windKph: number | null
  windDeg: number | null
}

export interface LatestAdvancedMetrics {
  origin: ReadingOrigin
  provider: string | null
  location: string | null
  lat: number | null
  lon: number | null
  collectedAt: string
  uvIndex: number | null
  soilMoisturePct: number | null
  wildfireRisk: number | null
  environmentalScore: number | null
  temperatureC: number | null
  humidityPct: number | null
  pressureMb: number | null
  windKph: number | null
  windDeg: number | null
}

export interface LatestWaterLevel {
  origin: ReadingOrigin
  provider: string | null
  stationCode: string | null
  location: string | null
  lat: number | null
  lon: number | null
  collectedAt: string
  levelM: number | null
  tideHeightM: number | null
  waveHeightM: number | null
  salinityPsu: number | null
  dissolvedOxygenMgL: number | null
  turbidityNtu: number | null
  currentSpeedMs: number | null
  currentDirectionDeg: number | null
  windKph: number | null
  windDeg: number | null
}

export interface LatestSeismic {
  origin: ReadingOrigin
  provider: string | null
  eventId: string | null
  location: string | null
  lat: number | null
  lon: number | null
  collectedAt: string
  magnitude: number | null
  depthKm: number | null
}

/** A mapped reading plus whether it carries the metric the endpoint reports. */
interface Candidate<T> {
  value: T
}

// ─── Value coercion ──────────────────────────────────────────────────────────

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** First key that yields a finite number, so legacy columns and overlay preview keys share one path. */
function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toNumber(source[key])
    if (value != null) return value
  }
  return null
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ''))
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function metricsOf(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.metrics_preview
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Overlay previews store soil moisture as the raw 0–1 fraction the provider
 * reported; the legacy column stores a rounded percentage. Normalise both to a
 * percentage so the response is identical whichever source answered.
 */
function soilMoisturePercent(source: Record<string, unknown>): number | null {
  const pct = toNumber(source.soil_moisture_pct)
  if (pct != null) return pct
  const fraction = toNumber(source.soil_moisture)
  if (fraction == null) return null
  return fraction <= 1 ? fraction * 100 : fraction
}

// ─── Source reads ────────────────────────────────────────────────────────────

const LOG_INTERVAL_MS = 60_000
const lastWarnAt = new Map<string, number>()

function warnThrottled(label: string, error: unknown): void {
  const now = Date.now()
  const previous = lastWarnAt.get(label) ?? 0
  if (now - previous < LOG_INTERVAL_MS) return
  lastWarnAt.set(label, now)
  const message =
    error instanceof Error && error.message ? error.message : String(error ?? 'unknown error')
  console.warn(`[latest-environmental] ${label}: ${message}`)
}

async function readLegacy(
  sql: string,
  label: string,
): Promise<Record<string, unknown> | null> {
  const result = await queryWithDeadline<Record<string, unknown>>(sql, [], {
    timeoutMs: REFRESH_BUDGET_MS,
    label: `legacy ${label}`,
  })
  return result.rows?.[0] ?? null
}

async function readOverlay(family: string): Promise<Record<string, unknown> | null> {
  const result = await queryWithDeadline<Record<string, unknown>>(
    `SELECT provider_id, location, lat, lon, reading_ts, metrics_preview
       FROM overlay_explorer_readings
      WHERE data_family = $1
      ORDER BY reading_ts DESC
      LIMIT 1`,
    [family],
    { timeoutMs: REFRESH_BUDGET_MS, label: `overlay ${family}` },
  )
  return result.rows?.[0] ?? null
}

// The overlay's own retention preserves the newest row per family, and the
// (data_family, reading_ts DESC) index serves this lookup directly.
async function loadCandidates<T>(
  label: string,
  legacy: () => Promise<Candidate<T> | null>,
  overlay: () => Promise<Candidate<T> | null>,
): Promise<T[]> {
  const [legacyResult, overlayResult] = await Promise.allSettled([legacy(), overlay()])

  const candidates: T[] = []
  if (legacyResult.status === 'fulfilled' && legacyResult.value) {
    candidates.push(legacyResult.value.value)
  } else if (legacyResult.status === 'rejected') {
    warnThrottled(`legacy ${label}`, legacyResult.reason)
  }
  if (overlayResult.status === 'fulfilled' && overlayResult.value) {
    candidates.push(overlayResult.value.value)
  } else if (overlayResult.status === 'rejected') {
    warnThrottled(`overlay ${label}`, overlayResult.reason)
  }

  if (candidates.length === 0) {
    throw new Error(`No ${label} reading is available from the legacy tables or the overlay`)
  }
  return candidates
}

/**
 * Choose the newest candidate that actually carries the metric this endpoint
 * reports, falling back to the newest candidate of any kind.
 *
 * The preference filter exists because a row without its headline metric cannot
 * answer the endpoint honestly — an air-quality row with a null AQI would
 * otherwise be published as "AQI 0, Good". Preferring a slightly older row that
 * does carry the metric keeps the widget accurate without inventing values.
 *
 * The legacy queries already filter out rows missing the headline column, so in
 * practice this compares a complete legacy row against a possibly-sparse
 * overlay row and keeps whichever is newer.
 */
function pickNewest<T extends { collectedAt: string }>(
  candidates: T[],
  carriesPrimaryMetric: (value: T) => boolean,
): T {
  const preferred = candidates.filter(carriesPrimaryMetric)
  const pool = preferred.length > 0 ? preferred : candidates

  return pool.reduce((best, current) =>
    Date.parse(current.collectedAt) > Date.parse(best.collectedAt) ? current : best,
  )
}

// ─── Family mappers ──────────────────────────────────────────────────────────

function mapLegacyAirQuality(row: Record<string, unknown>): LatestAirQuality {
  return {
    origin: 'legacy',
    provider: pickString(row, ['provider', 'source']),
    location: pickString(row, ['city']),
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
    collectedAt: toIso(row.collected_at),
    aqi: toNumber(row.aqi),
    pm25: toNumber(row.pm25),
    pm10: toNumber(row.pm10),
    co: toNumber(row.co),
    no2: toNumber(row.no2),
    o3: toNumber(row.o3),
    so2: toNumber(row.so2),
    temperatureC: toNumber(row.temperature_c),
    humidityPct: toNumber(row.humidity_pct),
    pressureMb: toNumber(row.pressure_mb),
    windKph: toNumber(row.wind_kph),
    windDeg: toNumber(row.wind_deg),
  }
}

function mapOverlayAirQuality(row: Record<string, unknown>): LatestAirQuality {
  const m = metricsOf(row)
  return {
    origin: 'overlay',
    provider: pickString(row, ['provider_id']) ?? pickString(m, ['source']),
    location: pickString(row, ['location']),
    lat: toNumber(row.lat) ?? pickNumber(m, ['lat', 'latitude']),
    lon: toNumber(row.lon) ?? pickNumber(m, ['lon', 'longitude']),
    collectedAt: toIso(row.reading_ts),
    aqi: pickNumber(m, ['aqi', 'air_quality_index']),
    pm25: pickNumber(m, ['pm25', 'fine_particulate_matter_pm25']),
    pm10: pickNumber(m, ['pm10', 'coarse_particulate_matter_pm10']),
    co: pickNumber(m, ['co', 'carbon_monoxide']),
    no2: pickNumber(m, ['no2', 'nitrogen_dioxide']),
    o3: pickNumber(m, ['o3', 'ozone']),
    so2: pickNumber(m, ['so2', 'sulphur_dioxide', 'sulfur_dioxide']),
    temperatureC: pickNumber(m, ['temperature_c', 'air_temperature_c']),
    humidityPct: pickNumber(m, ['humidity_pct']),
    pressureMb: pickNumber(m, ['pressure_mb', 'pressure_hpa']),
    windKph: pickNumber(m, ['wind_kph']),
    windDeg: pickNumber(m, ['wind_deg']),
  }
}

function mapLegacyAdvanced(row: Record<string, unknown>): LatestAdvancedMetrics {
  return {
    origin: 'legacy',
    provider: pickString(row, ['provider', 'source']),
    location: pickString(row, ['city']),
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
    collectedAt: toIso(row.collected_at),
    uvIndex: toNumber(row.uv_index),
    soilMoisturePct: soilMoisturePercent(row),
    wildfireRisk: toNumber(row.wildfire_risk),
    environmentalScore: toNumber(row.environmental_score),
    temperatureC: toNumber(row.temperature_c),
    humidityPct: toNumber(row.humidity_pct),
    pressureMb: toNumber(row.pressure_mb),
    windKph: toNumber(row.wind_kph),
    windDeg: toNumber(row.wind_deg),
  }
}

function mapOverlayAdvanced(row: Record<string, unknown>): LatestAdvancedMetrics {
  const m = metricsOf(row)
  return {
    origin: 'overlay',
    provider: pickString(row, ['provider_id']) ?? pickString(m, ['source']),
    location: pickString(row, ['location']),
    lat: toNumber(row.lat) ?? pickNumber(m, ['lat', 'latitude']),
    lon: toNumber(row.lon) ?? pickNumber(m, ['lon', 'longitude']),
    collectedAt: toIso(row.reading_ts),
    uvIndex: pickNumber(m, ['uv_index']),
    soilMoisturePct: soilMoisturePercent(m),
    wildfireRisk: pickNumber(m, ['wildfire_risk']),
    environmentalScore: pickNumber(m, ['environmental_quality_score', 'environmental_score']),
    temperatureC: pickNumber(m, ['temperature_c', 'air_temperature_c']),
    humidityPct: pickNumber(m, ['humidity_pct']),
    pressureMb: pickNumber(m, ['pressure_mb', 'pressure_hpa']),
    windKph: pickNumber(m, ['wind_kph']),
    windDeg: pickNumber(m, ['wind_deg']),
  }
}

function mapLegacyWater(row: Record<string, unknown>): LatestWaterLevel {
  return {
    origin: 'legacy',
    provider: pickString(row, ['provider', 'source']),
    stationCode: pickString(row, ['station_code']),
    location: pickString(row, ['location']),
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
    collectedAt: toIso(row.collected_at),
    levelM: toNumber(row.level_m),
    tideHeightM: toNumber(row.tide_height_m),
    waveHeightM: toNumber(row.wave_height_m),
    salinityPsu: toNumber(row.salinity_psu),
    dissolvedOxygenMgL: toNumber(row.dissolved_oxygen_mg_l),
    turbidityNtu: toNumber(row.turbidity_ntu),
    currentSpeedMs: toNumber(row.current_speed_ms),
    currentDirectionDeg: toNumber(row.current_direction_deg),
    windKph: toNumber(row.wind_kph),
    windDeg: toNumber(row.wind_deg),
  }
}

function mapOverlayWater(row: Record<string, unknown>): LatestWaterLevel {
  const m = metricsOf(row)
  return {
    origin: 'overlay',
    provider: pickString(row, ['provider_id']) ?? pickString(m, ['source']),
    stationCode: pickString(m, ['station_id', 'station_code']),
    location: pickString(row, ['location']),
    lat: toNumber(row.lat) ?? pickNumber(m, ['lat', 'latitude']),
    lon: toNumber(row.lon) ?? pickNumber(m, ['lon', 'longitude']),
    collectedAt: toIso(row.reading_ts),
    levelM: pickNumber(m, ['level_m', 'sea_level', 'river_level', 'river_level_m', 'level']),
    tideHeightM: pickNumber(m, ['tide_height_m', 'tide_height']),
    waveHeightM: pickNumber(m, ['wave_height_m']),
    salinityPsu: pickNumber(m, ['salinity_psu']),
    dissolvedOxygenMgL: pickNumber(m, ['dissolved_oxygen_mg_l']),
    turbidityNtu: pickNumber(m, ['turbidity_ntu']),
    currentSpeedMs: pickNumber(m, ['current_speed_ms']),
    currentDirectionDeg: pickNumber(m, ['current_direction_deg']),
    windKph: pickNumber(m, ['wind_kph']),
    windDeg: pickNumber(m, ['wind_deg']),
  }
}

function mapLegacySeismic(row: Record<string, unknown>): LatestSeismic {
  return {
    origin: 'legacy',
    provider: pickString(row, ['provider', 'source']),
    eventId: pickString(row, ['event_id']),
    location: pickString(row, ['location']),
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
    collectedAt: toIso(row.collected_at),
    magnitude: toNumber(row.magnitude),
    depthKm: toNumber(row.depth_km),
  }
}

function mapOverlaySeismic(row: Record<string, unknown>): LatestSeismic {
  const m = metricsOf(row)
  return {
    origin: 'overlay',
    provider: pickString(row, ['provider_id']) ?? pickString(m, ['source']),
    eventId: pickString(m, ['event_id', 'id']),
    location: pickString(row, ['location']),
    lat: toNumber(row.lat) ?? pickNumber(m, ['lat', 'latitude']),
    lon: toNumber(row.lon) ?? pickNumber(m, ['lon', 'longitude']),
    collectedAt: toIso(row.reading_ts),
    magnitude: pickNumber(m, ['magnitude', 'magnitude_value']),
    depthKm: pickNumber(m, ['depth_km', 'depth']),
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

const airQualityCache = new ServerSwrCache<LatestAirQuality>(CACHE_TTL_MS, 'air-quality')
const advancedMetricsCache = new ServerSwrCache<LatestAdvancedMetrics>(
  CACHE_TTL_MS,
  'advanced-metrics',
)
const waterLevelCache = new ServerSwrCache<LatestWaterLevel>(CACHE_TTL_MS, 'water-levels')
const seismicCache = new ServerSwrCache<LatestSeismic>(CACHE_TTL_MS, 'seismic')

export async function getLatestAirQuality(): Promise<SwrResult<LatestAirQuality>> {
  return airQualityCache.get(async () =>
    pickNewest(
      await loadCandidates<LatestAirQuality>(
        'air quality',
        async () => {
          const row = await readLegacy(
            `SELECT provider, city, lat, lon, aqi, pm25, pm10, co, no2, o3, so2,
                    temperature_c, humidity_pct, pressure_mb, wind_kph, wind_deg,
                    collected_at
               FROM air_quality_readings
              WHERE aqi IS NOT NULL
              ORDER BY collected_at DESC
              LIMIT 1`,
            'air quality',
          )
          if (!row) return null
          const value = mapLegacyAirQuality(row)
          return { value }
        },
        async () => {
          const row = await readOverlay('air_quality')
          if (!row) return null
          const value = mapOverlayAirQuality(row)
          return { value }
        },
      ),
      (value) => value.aqi != null,
    ),
  )
}

export async function getLatestAdvancedMetrics(): Promise<SwrResult<LatestAdvancedMetrics>> {
  return advancedMetricsCache.get(async () =>
    pickNewest(
      await loadCandidates<LatestAdvancedMetrics>(
        'advanced metrics',
        async () => {
          const row = await readLegacy(
            `SELECT provider, city, lat, lon, uv_index, soil_moisture_pct, wildfire_risk,
                    environmental_score, temperature_c, humidity_pct, pressure_mb,
                    wind_kph, wind_deg, collected_at
               FROM advanced_metrics_readings
              ORDER BY collected_at DESC
              LIMIT 1`,
            'advanced metrics',
          )
          if (!row) return null
          const value = mapLegacyAdvanced(row)
          return { value }
        },
        async () => {
          const row = await readOverlay('advanced_metrics')
          if (!row) return null
          const value = mapOverlayAdvanced(row)
          return { value }
        },
      ),
      // Advanced metrics are a group, not a single headline number. A reading
      // carrying any of the derived weather metrics is usable; one carrying
      // nothing at all is not.
      (value) =>
        value.uvIndex != null ||
        value.soilMoisturePct != null ||
        value.temperatureC != null ||
        value.humidityPct != null ||
        value.pressureMb != null,
    ),
  )
}

export async function getLatestWaterLevel(): Promise<SwrResult<LatestWaterLevel>> {
  return waterLevelCache.get(async () =>
    pickNewest(
      await loadCandidates<LatestWaterLevel>(
        'water level',
        async () => {
          const row = await readLegacy(
            `SELECT provider, station_code, location, lat, lon, level_m, tide_height_m,
                    wave_height_m, salinity_psu, dissolved_oxygen_mg_l, turbidity_ntu,
                    current_speed_ms, current_direction_deg, wind_kph, wind_deg,
                    collected_at
               FROM water_level_readings
              WHERE level_m IS NOT NULL
              ORDER BY collected_at DESC
              LIMIT 1`,
            'water level',
          )
          if (!row) return null
          const value = mapLegacyWater(row)
          return { value }
        },
        async () => {
          const row = await readOverlay('water_levels')
          if (!row) return null
          const value = mapOverlayWater(row)
          return { value }
        },
      ),
      (value) => value.levelM != null,
    ),
  )
}

export async function getLatestSeismic(): Promise<SwrResult<LatestSeismic>> {
  return seismicCache.get(async () =>
    pickNewest(
      await loadCandidates<LatestSeismic>(
        'seismic',
        async () => {
          const row = await readLegacy(
            `SELECT provider, event_id, location, magnitude, depth_km, lat, lon, collected_at
               FROM seismic_readings
              WHERE magnitude IS NOT NULL
              ORDER BY collected_at DESC
              LIMIT 1`,
            'seismic',
          )
          if (!row) return null
          const value = mapLegacySeismic(row)
          return { value }
        },
        async () => {
          const row = await readOverlay('seismic_activity')
          if (!row) return null
          const value = mapOverlaySeismic(row)
          return { value }
        },
      ),
      (value) => value.magnitude != null,
    ),
  )
}

