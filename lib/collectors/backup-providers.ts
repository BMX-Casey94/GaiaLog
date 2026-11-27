import { brotliDecompressSync, gunzipSync, inflateSync } from 'zlib'
import type { AirQualityData } from '../data-collector'
import { budgetStore, cursorStore, dedupeStore, type BudgetLimits } from '../stores'

/**
 * Backup collectors for air quality and transport.
 *
 * OpenAQ is capped locally at 24 requests/minute and 800/hour, under the
 * published 60/minute and 2,000/hour ceilings. Each cycle fetches one page of
 * locations and the latest measurements for a rotating slice of those stations.
 * adsb.lol and Digitraffic are keyless and limited to one request per call.
 *
 * Readings are real provider payloads only. A missing key, a rate-limit
 * window, or a failed request returns an empty array.
 */

const MAX_BODY_BYTES = 25 * 1024 * 1024

const OPENAQ_LOCATIONS_URL = 'https://api.openaq.org/v3/locations?limit=25&page=1'
const OPENAQ_PAGE_SIZE = 25
const OPENAQ_MAX_LATEST_PER_CYCLE = 8
const OPENAQ_MAX_PER_MINUTE = 24
const OPENAQ_MAX_PER_HOUR = 800
const OPENAQ_MINUTE_MS = 60_000
const OPENAQ_HOUR_MS = 60 * OPENAQ_MINUTE_MS

const ADSB_MIN_INTERVAL_MS = 15_000
const DIGITRAFFIC_MIN_INTERVAL_MS = 30_000
const DIGITRAFFIC_LOOKBACK_MS = 5 * 60_000

const FEET_TO_METRES = 0.3048
const KNOTS_TO_MS = 0.514444

const AVIATION_HUBS = [
  { name: 'London Heathrow', lat: 51.47, lon: -0.45 },
  { name: 'New York JFK', lat: 40.64, lon: -73.78 },
  { name: 'Tokyo Haneda', lat: 35.55, lon: 139.78 },
  { name: 'Frankfurt', lat: 50.03, lon: 8.57 },
  { name: 'Singapore', lat: 1.36, lon: 103.99 },
] as const

type Pollutant = 'pm25' | 'pm10' | 'no2' | 'o3' | 'co' | 'so2'

const GAS_UG_PER_PPB: Record<'co' | 'no2' | 'o3' | 'so2', number> = {
  co: 28.01 / 24.45,
  no2: 46.0055 / 24.45,
  o3: 48 / 24.45,
  so2: 64.066 / 24.45,
}

const PM25_AQI: Array<[number, number, number, number]> = [
  [0, 12, 0, 50],
  [12.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 150.4, 151, 200],
  [150.5, 250.4, 201, 300],
  [250.5, 350.4, 301, 400],
  [350.5, 500.4, 401, 500],
]

const PM10_AQI: Array<[number, number, number, number]> = [
  [0, 54, 0, 50],
  [55, 154, 51, 100],
  [155, 254, 101, 150],
  [255, 354, 151, 200],
  [355, 424, 201, 300],
  [425, 504, 301, 400],
  [505, 604, 401, 500],
]

/**
 * Aircraft state aligned with the OpenSky transport reading.
 * Altitude is metres and ground speed is metres/second.
 * `squawk`, `registration`, and `aircraftType` are the adsb.lol `squawk`, `r`, and `t` fields.
 */
export interface AdsbLolState {
  timestamp: number
  source: string
  icao24: string
  callsign: string
  originCountry: string
  latitude: number
  longitude: number
  altitudeM: number
  velocityMs: number
  heading: number
  onGround: boolean
  squawk: string
  registration: string
  aircraftType: string
}

/**
 * Vessel position from the Digitraffic AIS locations feed.
 * `timestamp` is `properties.timestampExternal` (epoch milliseconds).
 * `speed` / `course` mirror `sog` / `cog` for the transport measurement map.
 * Speed is knots, as reported.
 */
export interface DigitrafficAisVessel {
  timestamp: number
  source: string
  mmsi: string
  latitude: number
  longitude: number
  sog: number | null
  cog: number | null
  heading: number | null
  navStat: number | null
  speed: number | null
  course: number | null
}

type BackupRuntime = {
  budgets: Set<string>
  openaqHits: number[]
  adsbAt: number
  digitrafficAt: number
  openaqKeyWarned: boolean
  openaqBusy: boolean
  adsbBusy: boolean
  digitrafficBusy: boolean
}

function runtime(): BackupRuntime {
  const g = globalThis as { __GAIALOG_BACKUP_RUNTIME__?: BackupRuntime }
  if (!g.__GAIALOG_BACKUP_RUNTIME__) {
    g.__GAIALOG_BACKUP_RUNTIME__ = {
      budgets: new Set(),
      openaqHits: [],
      adsbAt: 0,
      digitrafficAt: 0,
      openaqKeyWarned: false,
      openaqBusy: false,
      adsbBusy: false,
      digitrafficBusy: false,
    }
  }
  return g.__GAIALOG_BACKUP_RUNTIME__
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function readPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(n) || n <= 0 || n > 1_000_000_000) return null
  return n
}

function validCoord(lat: number, lon: number): boolean {
  return Number.isFinite(lat)
    && Number.isFinite(lon)
    && lat >= -90
    && lat <= 90
    && lon >= -180
    && lon <= 180
    && !(lat === 0 && lon === 0)
}

function readLatLon(source: unknown): { lat: number; lon: number } | null {
  if (!isRecord(source)) return null
  const lat = typeof source.latitude === 'number'
    ? source.latitude
    : typeof source.lat === 'number'
      ? source.lat
      : NaN
  const lon = typeof source.longitude === 'number'
    ? source.longitude
    : typeof source.lon === 'number'
      ? source.lon
      : NaN
  return validCoord(lat, lon) ? { lat, lon } : null
}

function geoJsonPoint(feature: Record<string, unknown>): { lat: number; lon: number } | null {
  const geometry = isRecord(feature.geometry) ? feature.geometry : null
  const coordinates = geometry && Array.isArray(geometry.coordinates) ? geometry.coordinates : null
  if (coordinates && coordinates.length >= 2) {
    const lon = Number(coordinates[0])
    const lat = Number(coordinates[1])
    if (validCoord(lat, lon)) return { lat, lon }
  }
  return readLatLon(feature.properties)
}

function resolveLimit(limit: number | undefined, fallback: number, max: number): number | null {
  if (limit == null) return fallback
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback
  const n = Math.floor(limit)
  if (n <= 0) return null
  return Math.min(n, max)
}

async function readCursor(providerId: string, resourceKey: string, fallback = 0): Promise<number> {
  const raw = await cursorStore.get(providerId, resourceKey)
  if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) return fallback
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

async function ensureProviderBudget(providerId: string, limits: BudgetLimits): Promise<void> {
  const rt = runtime()
  if (rt.budgets.has(providerId)) return
  const remaining = await budgetStore.getRemaining(providerId)
  const alreadyConfigured = remaining.perSecondRemaining != null || remaining.perDayRemaining != null
  if (!alreadyConfigured) await budgetStore.configure(providerId, limits)
  rt.budgets.add(providerId)
}

function decodeBody(buffer: Buffer, encoding: string): string | null {
  if (buffer.length === 0 || buffer.length > MAX_BODY_BYTES) return null
  const enc = encoding.toLowerCase()
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
  const isZlib = buffer.length >= 2 && buffer[0] === 0x78 && (buffer[1] === 0x01 || buffer[1] === 0x9c || buffer[1] === 0xda)
  try {
    if (isGzip) return gunzipSync(buffer).toString('utf8')
    if (isZlib || (enc.includes('deflate') && buffer[0] !== 0x7b && buffer[0] !== 0x5b)) {
      return inflateSync(buffer).toString('utf8')
    }
    if (enc.includes('br') && buffer[0] !== 0x7b && buffer[0] !== 0x5b) {
      return brotliDecompressSync(buffer).toString('utf8')
    }
  } catch {
    return null
  }
  return buffer.toString('utf8')
}

async function fetchJson(url: string, headers: Record<string, string>, provider: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      console.warn(`${provider} HTTP ${response.status} ${url}`)
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      console.warn(`${provider} response exceeded ${MAX_BODY_BYTES} bytes`)
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const text = decodeBody(buffer, response.headers.get('content-encoding') || '')
    if (!text) return null
    return JSON.parse(text) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`${provider} request failed: ${message}`)
    return null
  }
}

function interpolateAqi(concentration: number, table: Array<[number, number, number, number]>): number {
  if (concentration <= table[0][0]) return table[0][2]
  for (const [cLow, cHigh, aqiLow, aqiHigh] of table) {
    if (concentration <= cHigh) {
      const span = cHigh - cLow
      const ratio = span === 0 ? 0 : Math.max(0, (concentration - cLow) / span)
      return Math.round((aqiHigh - aqiLow) * ratio + aqiLow)
    }
  }
  return 500
}

function approximateAqiFromPm(pm25?: number, pm10?: number): number | undefined {
  if (pm25 !== undefined) return interpolateAqi(pm25, PM25_AQI)
  if (pm10 !== undefined) return interpolateAqi(pm10, PM10_AQI)
  return undefined
}

function pollutantKey(name: unknown): Pollutant | null {
  if (typeof name !== 'string') return null
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (n === 'pm25' || n === 'pm25ugm3') return 'pm25'
  if (n === 'pm10' || n === 'pm10ugm3') return 'pm10'
  if (n === 'no2') return 'no2'
  if (n === 'o3' || n === 'ozone') return 'o3'
  if (n === 'co') return 'co'
  if (n === 'so2') return 'so2'
  return null
}

function toMicrograms(pollutant: Pollutant, value: number, units: unknown): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 100_000) return null
  const unit = String(units || '').toLowerCase().replace(/\s+/g, '')
  if (!unit || unit.includes('µg/m') || unit.includes('μg/m') || unit.includes('ug/m')) return value
  if (unit.includes('mg/m')) return value * 1000
  if (pollutant === 'pm25' || pollutant === 'pm10') return null
  const perPpb = GAS_UG_PER_PPB[pollutant]
  if (unit.includes('ppb')) return value * perPpb
  if (unit.includes('ppm')) return value * perPpb * 1000
  return value
}

function readUtcMs(row: Record<string, unknown>): number {
  const datetime = isRecord(row.datetime) ? row.datetime.utc : undefined
  const period = isRecord(row.period) ? row.period : null
  const toUtc = period && isRecord(period.datetimeTo) ? period.datetimeTo.utc : undefined
  const fromUtc = period && isRecord(period.datetimeFrom) ? period.datetimeFrom.utc : undefined
  for (const candidate of [datetime, toUtc, fromUtc]) {
    if (typeof candidate !== 'string') continue
    const ms = Date.parse(candidate)
    if (Number.isFinite(ms)) return ms
  }
  return 0
}

function openaqLocationsUrl(page: number): string {
  if (page <= 1) return OPENAQ_LOCATIONS_URL
  return `https://api.openaq.org/v3/locations?limit=${OPENAQ_PAGE_SIZE}&page=${page}`
}

function openaqSlotsAvailable(now = Date.now()): number {
  const hits = runtime().openaqHits
  const hourAgo = now - OPENAQ_HOUR_MS
  while (hits.length > 0 && hits[0] < hourAgo) hits.shift()
  let inMinute = 0
  const minuteAgo = now - OPENAQ_MINUTE_MS
  for (let i = hits.length - 1; i >= 0; i--) {
    if (hits[i] < minuteAgo) break
    inMinute++
  }
  return Math.max(0, Math.min(OPENAQ_MAX_PER_MINUTE - inMinute, OPENAQ_MAX_PER_HOUR - hits.length))
}

function recordOpenaqRequests(count: number, now = Date.now()): void {
  const hits = runtime().openaqHits
  for (let i = 0; i < count; i++) hits.push(now)
}

function sensorParameterMap(location: Record<string, unknown>): Map<number, { name: string; units: unknown }> {
  const map = new Map<number, { name: string; units: unknown }>()
  const sensors = Array.isArray(location.sensors) ? location.sensors : []
  for (const sensor of sensors) {
    if (!isRecord(sensor) || !isRecord(sensor.parameter)) continue
    const id = readPositiveInt(sensor.id)
    const name = sensor.parameter.name
    if (id == null || typeof name !== 'string') continue
    map.set(id, { name, units: sensor.parameter.units })
  }
  return map
}

function locationLabel(location: Record<string, unknown>, id: number): string {
  const country = isRecord(location.country) ? location.country : null
  const parts = [location.name, location.locality, country?.name || country?.code]
  const label = parts
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map(part => part.trim())
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(', ')
  return label || `OpenAQ ${id}`
}

function readingFromLatest(location: Record<string, unknown>, payload: unknown): AirQualityData | null {
  const id = readPositiveInt(location.id)
  if (id == null || !isRecord(payload) || !Array.isArray(payload.results)) return null
  const sensors = sensorParameterMap(location)
  const samples = new Map<Pollutant, { value: number; at: number }>()

  for (const row of payload.results) {
    if (!isRecord(row)) continue
    const sensorId = readPositiveInt(row.sensorsId ?? row.sensorId)
    const sensor = sensorId != null ? sensors.get(sensorId) : undefined
    const parameter = isRecord(row.parameter) ? row.parameter : null
    const key = pollutantKey(parameter?.name ?? sensor?.name)
    if (!key) continue
    const raw = typeof row.value === 'number' ? row.value : Number(row.value)
    const value = toMicrograms(key, raw, parameter?.units ?? sensor?.units)
    if (value == null) continue
    const at = readUtcMs(row)
    const previous = samples.get(key)
    if (!previous || at >= previous.at) samples.set(key, { value, at })
  }

  if (samples.size === 0) return null
  let latest = 0
  for (const sample of samples.values()) {
    if (sample.at > latest) latest = sample.at
  }
  if (latest <= 0) return null

  const pm25 = samples.get('pm25')?.value
  const pm10 = samples.get('pm10')?.value
  const coordinates = readLatLon(location.coordinates) || readLatLon(payload.results.find(isRecord)?.coordinates)
  const reading: AirQualityData = {
    aqi: approximateAqiFromPm(pm25, pm10) ?? 0,
    pm25: pm25 ?? 0,
    pm10: pm10 ?? 0,
    co: samples.get('co')?.value ?? 0,
    no2: samples.get('no2')?.value ?? 0,
    o3: samples.get('o3')?.value ?? 0,
    location: locationLabel(location, id),
    timestamp: new Date(latest).toISOString(),
    source: 'OpenAQ',
    coordinates: coordinates || undefined,
    station_id: String(id),
  }
  const so2 = samples.get('so2')?.value
  if (so2 !== undefined) reading.so2 = so2
  return reading
}

async function collectOpenAqAirQualityUnsynced(limit?: number): Promise<AirQualityData[]> {
  const wanted = resolveLimit(limit, OPENAQ_MAX_LATEST_PER_CYCLE, OPENAQ_MAX_LATEST_PER_CYCLE)
  if (wanted == null) return []

  const apiKey = process.env.OPENAQ_API_KEY?.trim()
  if (!apiKey) {
    const rt = runtime()
    if (!rt.openaqKeyWarned) {
      rt.openaqKeyWarned = true
      console.warn('OpenAQ air quality skipped: OPENAQ_API_KEY is not set')
    }
    return []
  }

  await ensureProviderBudget('openaq', { perSecond: 10, perDay: 15_000 })
  if (openaqSlotsAvailable() < 1 || !(await budgetStore.consume('openaq', 1))) return []
  recordOpenaqRequests(1)

  const page = Math.max(1, await readCursor('openaq', 'page', 1))
  const payload = await fetchJson(openaqLocationsUrl(page), {
    Accept: 'application/json',
    'X-API-Key': apiKey,
    'User-Agent': 'GaiaLog/1.0',
  }, 'OpenAQ')

  const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results.filter(isRecord) : []
  if (results.length === 0) {
    if (page > 1) {
      await cursorStore.set('openaq', 1, 'page')
      await cursorStore.set('openaq', 0, 'station_index')
    }
    return []
  }

  let start = await readCursor('openaq', 'station_index', 0)
  if (start >= results.length) start = 0
  const room = Math.min(wanted, results.length - start, openaqSlotsAvailable())
  if (room < 1 || !(await budgetStore.consume('openaq', room))) return []
  recordOpenaqRequests(room)

  const selected = results.slice(start, start + room)
  const fetched = await Promise.all(selected.map(async (location) => {
    const id = readPositiveInt(location.id)
    if (id == null) return null
    const latest = await fetchJson(`https://api.openaq.org/v3/locations/${id}/latest`, {
      Accept: 'application/json',
      'X-API-Key': apiKey,
      'User-Agent': 'GaiaLog/1.0',
    }, 'OpenAQ')
    return latest ? readingFromLatest(location, latest) : null
  }))

  const nextIndex = start + selected.length
  let nextPage = page
  let storedIndex = nextIndex
  if (nextIndex >= results.length) {
    storedIndex = 0
    const found = isRecord(payload) && isRecord(payload.meta) ? Number(payload.meta.found) : NaN
    const maxPage = Number.isFinite(found) && found > 0 ? Math.max(1, Math.ceil(found / OPENAQ_PAGE_SIZE)) : page + 1
    nextPage = page >= maxPage || results.length < OPENAQ_PAGE_SIZE ? 1 : page + 1
  }
  await cursorStore.set('openaq', storedIndex, 'station_index')
  await cursorStore.set('openaq', nextPage, 'page')

  const out: AirQualityData[] = []
  for (const reading of fetched) {
    if (!reading) continue
    const key = `openaq:air:${reading.station_id}:${reading.timestamp}`
    if (await dedupeStore.add(key)) out.push(reading)
  }
  return out
}

export async function collectOpenAqAirQuality(limit?: number): Promise<AirQualityData[]> {
  const rt = runtime()
  if (rt.openaqBusy) return []
  rt.openaqBusy = true
  try {
    return await collectOpenAqAirQualityUnsynced(limit)
  } finally {
    rt.openaqBusy = false
  }
}

function readIcao(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim().toLowerCase()
  return /^~?[0-9a-f]{4,8}$/.test(hex) ? hex : null
}

function readCallsign(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 12)
}

function readToken(value: unknown, max: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const text = String(value).trim()
  return text ? text.slice(0, max) : ''
}

function readAltitude(alt: unknown): { altitudeM: number; onGround: boolean } {
  if (typeof alt === 'string' && alt.trim().toLowerCase() === 'ground') {
    return { altitudeM: 0, onGround: true }
  }
  const n = typeof alt === 'number' ? alt : typeof alt === 'string' ? Number(alt) : NaN
  if (!Number.isFinite(n) || n < -2000 || n > 100_000) return { altitudeM: 0, onGround: false }
  return { altitudeM: round2(n * FEET_TO_METRES), onGround: false }
}

function readVelocityMs(gs: unknown): number {
  const n = typeof gs === 'number' ? gs : typeof gs === 'string' ? Number(gs) : NaN
  if (!Number.isFinite(n) || n < 0 || n > 2000) return 0
  return round2(n * KNOTS_TO_MS)
}

function readTrack(track: unknown): number {
  const n = typeof track === 'number' ? track : typeof track === 'string' ? Number(track) : NaN
  if (!Number.isFinite(n)) return 0
  return round2(((n % 360) + 360) % 360)
}

function aircraftFromAc(row: unknown, observedAt: number): AdsbLolState | null {
  if (!isRecord(row)) return null
  const icao24 = readIcao(row.hex)
  const latitude = typeof row.lat === 'number' ? row.lat : NaN
  const longitude = typeof row.lon === 'number' ? row.lon : NaN
  if (!icao24 || !validCoord(latitude, longitude)) return null

  const seenPos = typeof row.seen_pos === 'number' && Number.isFinite(row.seen_pos) ? row.seen_pos : 0
  if (seenPos < 0 || seenPos > 3600) return null
  const timestamp = observedAt - Math.round(seenPos * 1000)
  if (!Number.isFinite(timestamp) || timestamp < observedAt - 24 * 60 * 60 * 1000 || timestamp > observedAt + 10 * 60 * 1000) {
    return null
  }

  const altitude = readAltitude(row.alt_baro)
  return {
    timestamp,
    source: 'adsb.lol',
    icao24,
    callsign: readCallsign(row.flight),
    originCountry: '',
    latitude,
    longitude,
    altitudeM: altitude.altitudeM,
    velocityMs: readVelocityMs(row.gs),
    heading: readTrack(row.track),
    onGround: altitude.onGround,
    squawk: readToken(row.squawk, 8),
    registration: readToken(row.r, 16),
    aircraftType: readToken(row.t, 16),
  }
}

async function collectAdsbLolStatesUnsynced(limit?: number): Promise<AdsbLolState[]> {
  const wanted = resolveLimit(limit, 1000, 2000)
  if (wanted == null) return []

  const rt = runtime()
  const now = Date.now()
  if (now - rt.adsbAt < ADSB_MIN_INTERVAL_MS) return []

  await ensureProviderBudget('adsb_lol', { perSecond: 1, perDay: 4000 })
  if (!(await budgetStore.consume('adsb_lol', 1))) return []
  rt.adsbAt = now

  const hubCount = AVIATION_HUBS.length
  const hubIndex = (await readCursor('adsb_lol', 'hub_index', 0)) % hubCount
  const hub = AVIATION_HUBS[hubIndex]
  const payload = await fetchJson(
    `https://api.adsb.lol/v2/point/${hub.lat}/${hub.lon}/100`,
    { Accept: 'application/json', 'User-Agent': 'GaiaLog/1.0' },
    'adsb.lol',
  )
  if (!isRecord(payload)) return []

  await cursorStore.set('adsb_lol', (hubIndex + 1) % hubCount, 'hub_index')

  const observedAt = typeof payload.now === 'number' && payload.now > 1e12 ? payload.now : Date.now()
  const aircraft = (Array.isArray(payload.ac) ? payload.ac : [])
    .map(row => aircraftFromAc(row, observedAt))
    .filter((row): row is AdsbLolState => row != null)
    .sort((a, b) => a.icao24.localeCompare(b.icao24))

  if (aircraft.length === 0) return []

  const resourceKey = `hub:${hubIndex}`
  const start = (await readCursor('adsb_lol', resourceKey, 0)) % aircraft.length
  const out: AdsbLolState[] = []
  let examined = 0
  for (let i = 0; i < aircraft.length && out.length < wanted; i++) {
    const item = aircraft[(start + i) % aircraft.length]
    examined++
    const key = `adsb:${item.icao24}:${Math.floor(item.timestamp / 60000)}`
    if (await dedupeStore.add(key)) out.push(item)
  }
  await cursorStore.set('adsb_lol', (start + examined) % aircraft.length, resourceKey)
  return out
}

export async function collectAdsbLolStates(limit?: number): Promise<AdsbLolState[]> {
  const rt = runtime()
  if (rt.adsbBusy) return []
  rt.adsbBusy = true
  try {
    return await collectAdsbLolStatesUnsynced(limit)
  } finally {
    rt.adsbBusy = false
  }
}

function readMmsi(value: unknown): string | null {
  const raw = typeof value === 'number' && Number.isFinite(value)
    ? String(Math.trunc(value))
    : typeof value === 'string'
      ? value.trim()
      : ''
  return /^[1-9][0-9]{6,8}$/.test(raw) ? raw : null
}

function readEpochMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 1e12 || n > 1e14) return null
  return n
}

function readKnots(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0 || n > 102) return null
  return round2(n)
}

function readCourse(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0 || n >= 360) return null
  return round2(n)
}

function readVesselHeading(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(n) || n < 0 || n >= 360) return null
  return n
}

function readNavStat(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(n) || n < 0 || n > 15) return null
  return n
}

function vesselFromFeature(feature: unknown, now: number): DigitrafficAisVessel | null {
  if (!isRecord(feature)) return null
  const props = isRecord(feature.properties) ? feature.properties : null
  if (!props) return null
  const mmsi = readMmsi(props.mmsi)
  const position = geoJsonPoint(feature)
  // timestampExternal is epoch milliseconds. properties.timestamp is only the second-of-minute.
  const timestamp = readEpochMs(props.timestampExternal)
  if (!mmsi || !position || timestamp == null) return null
  if (timestamp < now - 24 * 60 * 60 * 1000 || timestamp > now + 10 * 60 * 1000) return null

  const sog = readKnots(props.sog)
  const cog = readCourse(props.cog)
  return {
    timestamp,
    source: 'Digitraffic AIS',
    mmsi,
    latitude: position.lat,
    longitude: position.lon,
    sog,
    cog,
    heading: readVesselHeading(props.heading),
    navStat: readNavStat(props.navStat),
    speed: sog,
    course: cog,
  }
}

async function collectDigitrafficAisVesselsUnsynced(limit?: number): Promise<DigitrafficAisVessel[]> {
  const wanted = resolveLimit(limit, 2000, 5000)
  if (wanted == null) return []

  const rt = runtime()
  const now = Date.now()
  if (now - rt.digitrafficAt < DIGITRAFFIC_MIN_INTERVAL_MS) return []

  await ensureProviderBudget('digitraffic', { perSecond: 1, perDay: 2880 })
  if (!(await budgetStore.consume('digitraffic', 1))) return []
  rt.digitrafficAt = now

  const from = now - DIGITRAFFIC_LOOKBACK_MS
  const payload = await fetchJson(
    `https://meri.digitraffic.fi/api/ais/v1/locations?from=${from}`,
    {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'Digitraffic-User': 'GaiaLog/1.0',
    },
    'Digitraffic',
  )
  if (!isRecord(payload) || !Array.isArray(payload.features)) return []

  const vessels = payload.features
    .map(feature => vesselFromFeature(feature, now))
    .filter((row): row is DigitrafficAisVessel => row != null)
    .sort((a, b) => b.timestamp - a.timestamp)

  const out: DigitrafficAisVessel[] = []
  for (const item of vessels) {
    if (out.length >= wanted) break
    const key = `digitraffic:ais:${item.mmsi}:${item.timestamp}`
    if (await dedupeStore.add(key)) out.push(item)
  }
  return out
}

export async function collectDigitrafficAisVessels(limit?: number): Promise<DigitrafficAisVessel[]> {
  const rt = runtime()
  if (rt.digitrafficBusy) return []
  rt.digitrafficBusy = true
  try {
    return await collectDigitrafficAisVesselsUnsynced(limit)
  } finally {
    rt.digitrafficBusy = false
  }
}
