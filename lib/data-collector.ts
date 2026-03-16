import { blockchainService } from './blockchain'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  insertAirQuality,
  insertWaterLevel,
  insertSeismic,
  insertAdvanced,
  calculateSourceHash,
  upsertTxLog,
  readCursor,
  writeCursor,
} from './repositories'
import { fetchJsonWithRetry, fetchTextWithRetry } from './provider-fetch'
import { fetchOwmJsonWithRotation, hasOwmApiKeys } from './owm'
import { budgetStore, cursorStore, dedupeStore, cacheStore } from './stores'

export interface AirQualityData {
  aqi: number
  pm25: number
  pm10: number
  co: number
  no2: number
  o3: number
  so2?: number
  // Environmental conditions (optional when available)
  temperature?: number
  humidity?: number
  pressure?: number
  windSpeed?: number
  windDirection?: number
  location: string
  timestamp: string
  source: string
  coordinates?: { lat: number; lon: number }
  station_id?: string
}

export interface WaterLevelData {
  river_level?: number
  sea_level?: number
  location: string
  timestamp: string
  source: string
  station_id?: string
  // Optional enrichments when provider supports them
  tide_height?: number
  water_temperature_c?: number
  wave_height_m?: number
  wave_height_is_nearby?: boolean
  wave_nearby_distance_km?: number
  wave_nearby_station?: string
  salinity_psu?: number
  ph?: number
  dissolved_oxygen_mg_l?: number
  turbidity_ntu?: number
  current_speed_ms?: number
  current_direction_deg?: number
  wind_speed_kph?: number
  wind_direction_deg?: number
  gust_kph?: number
  wave_period_s?: number
  average_wave_period_s?: number
  mean_wave_direction_deg?: number
  pressure_hpa?: number
  pressure_tendency_hpa?: number
  air_temperature_c?: number
  dew_point_c?: number
  visibility_nmi?: number
  coordinates?: { lat: number; lon: number }
}

export interface SeismicData {
  magnitude: number
  depth: number
  location: string
  coordinates: { lat: number; lon: number }
  timestamp: string
  source: string
  event_id?: string
}

export interface AdvancedMetricsData {
  uv_index: number
  soil_moisture: number
  wildfire_risk: number
  environmental_quality_score: number
  location: string
  timestamp: string
  source: string
  coordinates?: { lat: number; lon: number }
  // Optional climate fields (if provider supplies them)
  temperature_c?: number
  humidity_pct?: number
  pressure_mb?: number
  wind_kph?: number
  wind_deg?: number
}

function parseNumericValue(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed === 'MM') return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function normaliseProviderTimestamp(raw: string | undefined | null): string {
  if (!raw) return new Date().toISOString()
  const trimmed = raw.trim()
  if (!trimmed) return new Date().toISOString()
  if (trimmed.endsWith('Z')) return new Date(trimmed).toISOString()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return new Date(trimmed.replace(' ', 'T') + 'Z').toISOString()
  }
  const parsed = new Date(trimmed)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString()
}

function parseSensorCommunityValues(values: any[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const entry of Array.isArray(values) ? values : []) {
    const key = String(entry?.value_type || '').trim()
    const value = parseNumericValue(entry?.value)
    if (!key || value === undefined) continue
    out[key] = value
  }
  return out
}

function interpolateAqi(concentration: number, table: Array<[number, number, number, number]>): number {
  for (const [cLow, cHigh, aqiLow, aqiHigh] of table) {
    if (concentration >= cLow && concentration <= cHigh) {
      return Math.round(((aqiHigh - aqiLow) / (cHigh - cLow)) * (concentration - cLow) + aqiLow)
    }
  }
  return Math.round(Math.min(500, Math.max(0, concentration)))
}

function approximateAqiFromPm(pm25?: number, pm10?: number): number | undefined {
  if (pm25 !== undefined) {
    return interpolateAqi(pm25, [
      [0, 12, 0, 50],
      [12.1, 35.4, 51, 100],
      [35.5, 55.4, 101, 150],
      [55.5, 150.4, 151, 200],
      [150.5, 250.4, 201, 300],
      [250.5, 350.4, 301, 400],
      [350.5, 500.4, 401, 500],
    ])
  }
  if (pm10 !== undefined) {
    return interpolateAqi(pm10, [
      [0, 54, 0, 50],
      [55, 154, 51, 100],
      [155, 254, 101, 150],
      [255, 354, 151, 200],
      [355, 424, 201, 300],
      [425, 504, 301, 400],
      [505, 604, 401, 500],
    ])
  }
  return undefined
}

function buildRotatingSlice<T>(items: T[], startIndex: number, limit: number): T[] {
  if (items.length === 0 || limit <= 0) return []
  const slice: T[] = []
  const total = items.length
  for (let offset = 0; offset < Math.min(limit, total); offset++) {
    slice.push(items[(startIndex + offset) % total])
  }
  return slice
}

function isTruthyEnv(value: string | undefined, fallback: boolean = false): boolean {
  if (value == null || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function parseCsvSet(value: string | undefined): Set<string> {
  return new Set(
    String(value || '')
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean),
  )
}

const NOAA_COOPS_DEFAULT_PRODUCTS = ['water_level', 'water_temperature', 'wind'] as const

function getNoaaCoopsProducts(): Set<string> {
  const configured = parseCsvSet(process.env.NOAA_COOPS_PRODUCTS)
  if (configured.size === 0) {
    return new Set(NOAA_COOPS_DEFAULT_PRODUCTS)
  }
  configured.add('water_level')
  return configured
}

async function collectNoaaWaterLevelForStation(station: any, products: Set<string>): Promise<WaterLevelData | null> {
  try {
    try {
      const plat = Number((station as any).lat)
      const plon = Number((station as any).lon ?? (station as any).lng)
      if (Number.isFinite(plat) && Number.isFinite(plon)) {
        const { getNearestOwmCountry } = await import('./repositories')
        const { isCountryAllowed } = await import('./country-controls')
        const cc = await getNearestOwmCountry(plat, plon)
        if (!isCountryAllowed('noaa' as any, cc)) return null
      }
    } catch {}

    const stationId = station.id
    const stationLatN = Number((station as any).lat)
    const stationLonN = Number((station as any).lng ?? (station as any).lon)
    const stationLat: number | undefined = Number.isFinite(stationLatN) ? stationLatN : undefined
    const stationLon: number | undefined = Number.isFinite(stationLonN) ? stationLonN : undefined

    const begin = new Date().toISOString().slice(0, 10)
    const end = begin
    const base = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${stationId}&time_zone=gmt&units=metric&format=json`
    const fetchProduct = (suffix: string, retries: number = 1) =>
      fetchJsonWithRetry<any>(`${base}${suffix}`, { retries, providerId: 'noaa' }).catch(() => null)

    const [
      waterData,
      tempData,
      windData,
      tidePred,
      salinityData,
      doData,
      turbidityData,
      currentsData,
    ] = await Promise.all([
      fetchProduct(`&product=water_level&datum=MLLW&begin_date=${begin}&end_date=${end}`, 2),
      products.has('water_temperature')
        ? fetchProduct(`&product=water_temperature&begin_date=${begin}&end_date=${end}`)
        : Promise.resolve(null),
      products.has('wind')
        ? fetchProduct(`&product=wind&begin_date=${begin}&end_date=${end}`)
        : Promise.resolve(null),
      products.has('predictions')
        ? fetchProduct(`&product=predictions&interval=h&datum=MLLW&begin_date=${begin}&end_date=${end}`)
        : Promise.resolve(null),
      products.has('salinity')
        ? fetchProduct(`&product=salinity&begin_date=${begin}&end_date=${end}`)
        : Promise.resolve(null),
      products.has('dissolved_oxygen')
        ? fetchProduct(`&product=dissolved_oxygen&begin_date=${begin}&end_date=${end}`)
        : Promise.resolve(null),
      products.has('turbidity')
        ? fetchProduct(`&product=turbidity&begin_date=${begin}&end_date=${end}`)
        : Promise.resolve(null),
      products.has('currents')
        ? fetchProduct(`&product=currents&bin=1&begin_date=${begin}&end_date=${end}`)
        : Promise.resolve(null),
    ])

    const latest = (arr?: any[]) => (Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null)
    const wl = latest(waterData?.data)
    if (!wl) return null

    const waterLevelValue = parseFloat(wl.v) || 0
    const wt = latest(tempData?.data)
    const wind = latest(windData?.data)
    const pred = latest(tidePred?.predictions)
    const sal = latest(salinityData?.data)
    const disox = latest(doData?.data)
    const turb = latest(turbidityData?.data)

    const item: WaterLevelData = {
      river_level: waterLevelValue,
      sea_level: waterLevelValue,
      location: station.name,
      timestamp: (wl.t ? new Date(wl.t).toISOString() : new Date().toISOString()),
      source: 'NOAA Tides & Currents',
      station_id: stationId,
      coordinates: (stationLat != null && stationLon != null) ? { lat: stationLat, lon: stationLon } : undefined,
      tide_height: pred ? parseFloat(pred.v) : undefined,
      water_temperature_c: wt ? parseFloat(wt.v) : undefined,
      salinity_psu: sal ? parseFloat(sal.v) : undefined,
      dissolved_oxygen_mg_l: disox ? parseFloat(disox.v) : undefined,
      turbidity_ntu: turb ? parseFloat(turb.v) : undefined,
      wind_speed_kph: wind && wind.s ? Math.round((parseFloat(wind.s) || 0) * 3.6) : undefined,
      wind_direction_deg: wind && wind.d ? parseFloat(wind.d) : undefined,
      current_speed_ms: currentsData?.data?.length ? parseFloat(currentsData.data[currentsData.data.length - 1]?.s) || undefined : undefined,
      current_direction_deg: currentsData?.data?.length ? parseFloat(currentsData.data[currentsData.data.length - 1]?.d) || undefined : undefined,
    }

    const key = `noaa:water:${item.station_id}:${item.timestamp}`
    return (await dedupeStore.add(key)) ? item : null
  } catch {
    return null
  }
}

// Enhanced data collection service with worldwide coverage
export class DataCollector {
  private apiKeys = {
    waqi: process.env.WAQI_API_KEY,
    weatherapi: process.env.WEATHERAPI_KEY
  }

  // Primary: WAQI API, Fallback: WeatherAPI (basic air quality)
  async collectAirQualityData(location: string = 'London'): Promise<AirQualityData | null> {
    try {
      // Try WAQI first (better air quality data)
      if (this.apiKeys.waqi) {
        const waqiData = await this.fetchWAQIData(location)
        if (waqiData) {
          const hash = await this.persistAirQuality(waqiData)
          await this.writeToBlockchain('air_quality', waqiData, hash)
          return waqiData
        }
      }

      // Fallback to WeatherAPI (basic air quality)
      if (this.apiKeys.weatherapi) {
        const waData = await this.fetchWeatherAPIAirQuality(location)
        if (waData) {
          const hash = await this.persistAirQuality(waData)
          await this.writeToBlockchain('air_quality', waData, hash)
          return waData
        }
      }

      console.warn('No air quality API keys available')
      return null

    } catch (error) {
      console.error('Error collecting air quality data:', error)
      return null
    }
  }

  private async fetchWAQIData(location: string): Promise<AirQualityData | null> {
    try {
      const response = await fetch(
        `https://api.waqi.info/feed/${location}/?token=${this.apiKeys.waqi}`
      )

      if (!response.ok) {
        throw new Error(`WAQI API error: ${response.statusText}`)
      }

      const data = await response.json()
      
      if (data.status !== 'ok') {
        throw new Error(`WAQI API returned error: ${data.data}`)
      }

      const aqGeo = Array.isArray(data?.data?.city?.geo) ? data.data.city.geo : undefined
      const aqLat = aqGeo && aqGeo.length >= 2 ? Number(aqGeo[0]) : NaN
      const aqLon = aqGeo && aqGeo.length >= 2 ? Number(aqGeo[1]) : NaN
      return {
        aqi: data.data.aqi,
        pm25: data.data.iaqi?.pm25?.v || 0,
        pm10: data.data.iaqi?.pm10?.v || 0,
        co: data.data.iaqi?.co?.v || 0,
        no2: data.data.iaqi?.no2?.v || 0,
        o3: data.data.iaqi?.o3?.v || 0,
        so2: data.data.iaqi?.so2?.v || 0,
        temperature: data.data.iaqi?.t?.v || data.data.iaqi?.temp?.v || 0,
        humidity: data.data.iaqi?.h?.v || 0,
        pressure: data.data.iaqi?.p?.v || 0,
        windSpeed: data.data.iaqi?.w?.v || 0,
        windDirection: 0,
        location: data.data.city.name,
        timestamp: data.data.time.iso,
        source: 'WAQI',
        coordinates: Number.isFinite(aqLat) && Number.isFinite(aqLon) ? { lat: aqLat, lon: aqLon } : undefined
      }

    } catch (error) {
      console.error('WAQI API error:', error)
      return null
    }
  }

  private async fetchWeatherAPIAirQuality(location: string): Promise<AirQualityData | null> {
    try {
      const url = `https://api.weatherapi.com/v1/current.json?key=${this.apiKeys.weatherapi}&q=${encodeURIComponent(location)}&aqi=yes`
      const cacheKey = `weatherapi:aq:${location.toLowerCase()}`
      const lastModifiedKey = `weatherapi:aq:lastmod:${location.toLowerCase()}`
      let data = await cacheStore.get<any>(cacheKey)
      if (!data) {
        data = await fetchJsonWithRetry<any>(url, { retries: 2, lastModifiedKey, providerId: 'weatherapi' })
        await cacheStore.set(cacheKey, data, 60 * 60 * 1000)
      }

      // WeatherAPI provides basic air quality data
      return {
        aqi: data.current.air_quality?.['us-epa-index'] || 0,
        pm25: data.current.air_quality?.['pm2_5'] || 0,
        pm10: data.current.air_quality?.['pm10'] || 0,
        co: data.current.air_quality?.['co'] || 0,
        no2: data.current.air_quality?.['no2'] || 0,
        o3: data.current.air_quality?.['o3'] || 0,
        temperature: data.current?.temp_c ?? 0,
        humidity: data.current?.humidity ?? 0,
        pressure: data.current?.pressure_mb ?? 0,
        windSpeed: data.current?.wind_kph ?? 0,
        windDirection: data.current?.wind_degree ?? 0,
        location: data.location?.name || location,
        timestamp: (typeof data?.current?.last_updated === 'string' && data.current?.last_updated)
          ? new Date(data.current.last_updated).toISOString()
          : new Date().toISOString(),
        source: 'WeatherAPI.com',
        coordinates: (typeof data?.location?.lat === 'number' && typeof data?.location?.lon === 'number')
          ? { lat: data.location.lat, lon: data.location.lon }
          : undefined
      }

    } catch (error) {
      console.error('WeatherAPI air quality error:', error)
      return null
    }
  }

  // Primary: NOAA Tides & Currents (no API key needed)
  async collectWaterLevelData(location: string = 'global'): Promise<WaterLevelData | null> {
    try {
      const noaaData = await this.fetchNOAAWaterData(location)
      if (noaaData) {
        const hash = await this.persistWater(noaaData)
        await this.writeToBlockchain('water_levels', noaaData, hash)
        return noaaData
      }

      return null

    } catch (error) {
      console.error('Error collecting water level data:', error)
      return null
    }
  }

  private async fetchNOAAWaterData(location: string): Promise<WaterLevelData | null> {
    try {
      // Get list of stations
      const stationsData = await fetchJsonWithRetry<any>(
        'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels',
        { retries: 2, providerId: 'noaa', etagKey: 'noaa:stations:waterlevels' }
      )
      
      // Find a station near the location (simplified - in production, use geocoding)
      const station = stationsData.stations[0] // Use first available station for demo
      
      if (!station) return null

      // Get water level data for the station
      const stationId = station.id
      const stationLatN = Number((station as any).lat)
      const stationLonN = Number((station as any).lng ?? (station as any).lon)
      const stationLat: number | undefined = Number.isFinite(stationLatN) ? stationLatN : undefined
      const stationLon: number | undefined = Number.isFinite(stationLonN) ? stationLonN : undefined

      // Country toggle enforcement for NOAA based on nearest OWM country
      try {
        if (stationLat != null && stationLon != null) {
          const { getNearestOwmCountry } = await import('./repositories')
          const { isCountryAllowed } = await import('./country-controls')
          const cc = await getNearestOwmCountry(stationLat, stationLon)
          if (!isCountryAllowed('noaa' as any, cc)) return null
        }
      } catch {}

      // Build base URLs
      const base = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${stationId}&time_zone=gmt&units=metric&format=json`
      const begin = this.getDateString(-1)
      const end = this.getDateString(0)

      // Fetch core water level plus optional products in parallel
      const [waterData, tempData, windData, tidePred, salinityData, doData, turbidityData, currentsData] = await Promise.all([
        fetchJsonWithRetry<any>(`${base}&product=water_level&datum=MLLW&begin_date=${begin}&end_date=${end}`, { retries: 2, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=water_temperature&begin_date=${begin}&end_date=${end}`, { retries: 2, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=wind&begin_date=${begin}&end_date=${end}`, { retries: 2, providerId: 'noaa' }).catch(() => null),
        // Tide predictions (hourly)
        fetchJsonWithRetry<any>(`${base}&product=predictions&interval=h&datum=MLLW&begin_date=${begin}&end_date=${end}`, { retries: 2, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=salinity&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=dissolved_oxygen&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=turbidity&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
        // Currents may require bin; try bin=1
        fetchJsonWithRetry<any>(`${base}&product=currents&bin=1&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
      ])

      const latest = (arr?: any[]) => (Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null)

      const wl = latest(waterData?.data)
      if (!wl) return null

      const water_level_val = parseFloat(wl.v) || 0

      // Optional extractions
      const wt = latest(tempData?.data)
      const wind = latest(windData?.data)
      // predictions array has objects {t: timestamp, v: value}
      const pred = latest(tidePred?.predictions)
      const sal = latest(salinityData?.data)
      const disox = latest(doData?.data)
      const turb = latest(turbidityData?.data)

      const out: WaterLevelData = {
        river_level: water_level_val,
        sea_level: water_level_val,
          location: station.name,
          timestamp: new Date().toISOString(),
          source: 'NOAA Tides & Currents',
        station_id: stationId,
        coordinates: (stationLat != null && stationLon != null) ? { lat: stationLat, lon: stationLon } : undefined,
        tide_height: pred ? parseFloat(pred.v) : undefined,
        water_temperature_c: wt ? parseFloat(wt.v) : undefined,
        // Wave height not available on CO-OPS; leave undefined
        salinity_psu: sal ? parseFloat(sal.v) : undefined,
        dissolved_oxygen_mg_l: disox ? parseFloat(disox.v) : undefined,
        turbidity_ntu: turb ? parseFloat(turb.v) : undefined,
        wind_speed_kph: wind && wind.s ? Math.round((parseFloat(wind.s) || 0) * 3.6) : undefined,
        wind_direction_deg: wind && wind.d ? parseFloat(wind.d) : undefined,
        current_speed_ms: currentsData?.data?.length ? parseFloat(currentsData.data[currentsData.data.length - 1]?.s) || undefined : undefined,
        current_direction_deg: currentsData?.data?.length ? parseFloat(currentsData.data[currentsData.data.length - 1]?.d) || undefined : undefined,
      }

      // Enrich with NDBC wave height (WVHT, metres) if station coordinates available
      if (stationLat != null && stationLon != null) {
        const wave = await this.fetchNDBCWaveHeightNear(stationLat, stationLon)
        if (wave && typeof wave.value === 'number' && !Number.isNaN(wave.value)) {
          out.wave_height_m = wave.value
          out.wave_height_is_nearby = true
          out.wave_nearby_distance_km = wave.distance_km
          out.wave_nearby_station = wave.station_id
        }
      }

      return out

      return null

    } catch (error) {
      console.error('NOAA API error:', error)
      return null
    }
  }

  private async fetchNDBCWaveHeightNear(lat: number, lon: number): Promise<{ value: number | undefined; distance_km: number | undefined; station_id?: string } | undefined> {
    try {
      const res = await fetch('https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt')
      if (!res.ok) return undefined
      const text = await res.text()
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.startsWith('#'))
      if (lines.length < 2) return undefined
      // Header is first non-comment line
      const header = lines[0].trim().split(/\s+/)
      const idx = {
        station: header.indexOf('STN') >= 0 ? header.indexOf('STN') : header.indexOf('Station'),
        lat: header.indexOf('LAT'),
        lon: header.indexOf('LON'),
        wvht: header.indexOf('WVHT'),
      }
      if (idx.lat < 0 || idx.lon < 0 || idx.wvht < 0) return undefined

      let bestDist = Number.POSITIVE_INFINITY
      let bestWave: number | undefined
      let bestStation: string | undefined

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/)
        if (parts.length <= Math.max(idx.lon, idx.wvht)) continue
        const plat = parseFloat(parts[idx.lat])
        const plon = parseFloat(parts[idx.lon])
        if (Number.isNaN(plat) || Number.isNaN(plon)) continue
        const d = this.haversineKm(lat, lon, plat, plon)
        if (d < bestDist) {
          const wv = parts[idx.wvht]
          const val = wv && wv !== 'MM' ? parseFloat(wv) : NaN
          bestDist = d
          bestWave = Number.isNaN(val) ? undefined : val
          bestStation = idx.station >= 0 ? parts[idx.station] : undefined
        }
      }
      return { value: bestWave, distance_km: Number.isFinite(bestDist) ? bestDist : undefined, station_id: bestStation }
    } catch {
      return undefined
    }
  }

  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (x: number) => (x * Math.PI) / 180
    const R = 6371 // km
    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  // Primary: USGS Earthquake API (no API key needed)
  async collectSeismicData(location: string = 'global'): Promise<SeismicData | null> {
    try {
      const seismicData = await this.fetchUSGSSeismicData()
      if (seismicData) {
        const hash = await this.persistSeismic(seismicData)
        await this.writeToBlockchain('seismic_activity', seismicData, hash)
        return seismicData
      }

      return null

    } catch (error) {
      console.error('Error collecting seismic data:', error)
      return null
    }
  }

  private async fetchUSGSSeismicData(): Promise<SeismicData | null> {
    try {
      // Get earthquakes from the last 24 hours, magnitude 2.5+
      const endTime = new Date().toISOString()
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      
      const response = await fetch(
        `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${startTime}&endtime=${endTime}&minmagnitude=2.5&orderby=time`
      )

      if (!response.ok) {
        throw new Error(`USGS API error: ${response.statusText}`)
      }

      const data = await response.json()
      
      if (data.features && data.features.length > 0) {
        const latestEarthquake = data.features[0]
        const properties = latestEarthquake.properties
        const geometry = latestEarthquake.geometry
        
        return {
          magnitude: properties.mag,
          depth: typeof geometry.coordinates?.[2] === 'number' ? geometry.coordinates[2] : 0,
          location: properties.place,
          coordinates: {
            lat: geometry.coordinates[1],
            lon: geometry.coordinates[0]
          },
          timestamp: new Date(properties.time).toISOString(),
          source: 'USGS Earthquake API',
          event_id: latestEarthquake.id
        }
      }

      return null

    } catch (error) {
      console.error('USGS API error:', error)
      return null
    }
  }

  // Primary: WeatherAPI.com (we have this key!)
  async collectAdvancedMetricsData(location: string = 'London'): Promise<AdvancedMetricsData | null> {
    try {
      if (this.apiKeys.weatherapi) {
        const waData = await this.fetchWeatherAPIData(location)
        if (waData) {
          const hash = await this.persistAdvanced(waData)
          await this.writeToBlockchain('advanced_metrics', waData, hash)
          return waData
        }
      }

      // Fallback: derive metrics from OWM current weather if available
      if (hasOwmApiKeys()) {
        const owmData = await this.fetchOWMDerivedMetrics(location)
        if (owmData) {
          const hash = await this.persistAdvanced(owmData)
          await this.writeToBlockchain('advanced_metrics', owmData, hash)
          return owmData
        }
      }

      console.warn('No weather API keys available')
      return null

    } catch (error) {
      console.error('Error collecting advanced metrics data:', error)
      return null
    }
  }

  private async fetchWeatherAPIData(location: string): Promise<AdvancedMetricsData | null> {
    try {
      const url = `https://api.weatherapi.com/v1/current.json?key=${this.apiKeys.weatherapi}&q=${encodeURIComponent(location)}&aqi=no`
      const cacheKey = `weatherapi:adv:${location.toLowerCase()}`
      const lastModifiedKey = `weatherapi:adv:lastmod:${location.toLowerCase()}`
      let data = await cacheStore.get<any>(cacheKey)
      if (!data) {
        data = await fetchJsonWithRetry<any>(url, { retries: 2, lastModifiedKey, providerId: 'weatherapi' })
        await cacheStore.set(cacheKey, data, 60 * 60 * 1000)
      }

      const uvIndex: number = data.current?.uv || 0
      const humidity: number = data.current?.humidity ?? 0 // percent
      const windKph: number = data.current?.wind_kph ?? 0

      // Derive proxies (no external simulated sources):
      // - Soil moisture proxy from relative humidity (0-1)
      const soilMoisture = Math.max(0, Math.min(1, humidity / 100))
      // - Wildfire risk proxy: higher with UV and wind, lower with humidity
      const wildfireRiskRaw = uvIndex + windKph / 10 - humidity / 20
      const wildfireRisk = Math.max(1, Math.min(10, Math.round(wildfireRiskRaw)))

      const environmentalQualityScore = this.calculateEnvironmentalQualityScore(
        uvIndex,
        soilMoisture,
        wildfireRisk
      )

      return {
        uv_index: uvIndex,
        soil_moisture: soilMoisture,
        wildfire_risk: wildfireRisk,
        environmental_quality_score: environmentalQualityScore,
        location: data.location?.name || location,
        timestamp: (typeof data?.current?.last_updated === 'string' && data.current?.last_updated)
          ? new Date(data.current.last_updated).toISOString()
          : new Date().toISOString(),
        source: 'WeatherAPI-derived metrics',
        temperature_c: data.current?.temp_c ?? undefined,
        humidity_pct: data.current?.humidity ?? undefined,
        pressure_mb: data.current?.pressure_mb ?? undefined,
        wind_kph: data.current?.wind_kph ?? undefined,
        wind_deg: data.current?.wind_degree ?? undefined,
        coordinates: (typeof data?.location?.lat === 'number' && typeof data?.location?.lon === 'number')
          ? { lat: data.location.lat, lon: data.location.lon }
          : undefined
      }

    } catch (error) {
      console.error('WeatherAPI error:', error)
      return null
    }
  }

  // --- persistence helpers ---
  private async persistAirQuality(aq: AirQualityData): Promise<string> {
    const obj = { type: 'air_quality', aq }
    const source_hash = Buffer.from(JSON.stringify(obj)).toString('base64').slice(0, 64)
    try {
      await insertAirQuality({
        provider: aq.source,
        station_code: null,
        city: aq.location,
        lat: aq.coordinates?.lat ?? null,
        lon: aq.coordinates?.lon ?? null,
        aqi: aq.aqi,
        pm25: aq.pm25,
        pm10: aq.pm10,
        co: aq.co,
        no2: aq.no2,
        o3: aq.o3,
        so2: aq.so2 ?? null,
        temperature_c: (aq as any).temperature ?? null,
        humidity_pct: (aq as any).humidity ?? null,
        pressure_mb: (aq as any).pressure ?? null,
        wind_kph: (aq as any).windSpeed ?? null,
        wind_deg: (aq as any).windDirection ?? null,
        source: aq.source,
        source_hash,
        collected_at: new Date(aq.timestamp),
      })
    } catch (e) {
      console.warn('DB persist (air_quality) failed; continuing without persistence:', (e as any)?.message || e)
    }
    return source_hash
  }

  private async persistWater(w: WaterLevelData): Promise<string> {
    const obj = { type: 'water_levels', w }
    const source_hash = Buffer.from(JSON.stringify(obj)).toString('base64').slice(0, 64)
    try {
      await insertWaterLevel({
        provider: w.source,
        station_code: w.station_id ?? null,
        location: w.location ?? null,
        lat: w.coordinates?.lat ?? null,
        lon: w.coordinates?.lon ?? null,
        level_m: w.sea_level,
        tide_height_m: w.tide_height ?? null,
        wave_height_m: w.wave_height_m ?? null,
        salinity_psu: w.salinity_psu ?? null,
        dissolved_oxygen_mg_l: w.dissolved_oxygen_mg_l ?? null,
        turbidity_ntu: w.turbidity_ntu ?? null,
        current_speed_ms: w.current_speed_ms ?? null,
        current_direction_deg: w.current_direction_deg ?? null,
        wind_kph: w.wind_speed_kph ?? null,
        wind_deg: w.wind_direction_deg ?? null,
        source: w.source,
        source_hash,
        collected_at: new Date(w.timestamp),
      })
    } catch (e) {
      console.warn('DB persist (water_levels) failed; continuing without persistence:', (e as any)?.message || e)
    }
    return source_hash
  }

  private async persistSeismic(s: SeismicData): Promise<string> {
    const obj = { type: 'seismic', s }
    const source_hash = Buffer.from(JSON.stringify(obj)).toString('base64').slice(0, 64)
    try {
      await insertSeismic({
        provider: s.source,
        event_id: s.event_id ?? null,
        location: s.location,
        magnitude: s.magnitude,
        depth_km: s.depth,
        lat: s.coordinates.lat,
        lon: s.coordinates.lon,
        source_hash,
        collected_at: new Date(s.timestamp),
      })
    } catch (e) {
      console.warn('DB persist (seismic) failed; continuing without persistence:', (e as any)?.message || e)
    }
    return source_hash
  }

  private async persistAdvanced(a: AdvancedMetricsData): Promise<string> {
    const obj = { type: 'advanced', a }
    const source_hash = Buffer.from(JSON.stringify(obj)).toString('base64').slice(0, 64)
    try {
      await insertAdvanced({
        provider: a.source,
        city: a.location,
        lat: a.coordinates?.lat ?? null,
        lon: a.coordinates?.lon ?? null,
        uv_index: a.uv_index,
        soil_moisture_pct: Math.round((a.soil_moisture ?? 0) * 100),
        wildfire_risk: a.wildfire_risk,
        environmental_score: a.environmental_quality_score,
        temperature_c: a.temperature_c ?? null,
        humidity_pct: a.humidity_pct ?? null,
        pressure_mb: a.pressure_mb ?? null,
        wind_kph: a.wind_kph ?? null,
        wind_deg: a.wind_deg ?? null,
        source_hash,
        collected_at: new Date(a.timestamp),
      })
    } catch (e) {
      console.warn('DB persist (advanced_metrics) failed; continuing without persistence:', (e as any)?.message || e)
    }
    return source_hash
  }

  private async fetchOWMDerivedMetrics(location: string): Promise<AdvancedMetricsData | null> {
    try {
      // Geocode city to coords (cache 24h since geocoding is stable)
      const geoKey = `owm:geo:${location.toLowerCase()}`
      let first = await cacheStore.get<any>(geoKey)
      if (!first) {
        const geo = await fetchOwmJsonWithRotation<any>(
          (apiKey) => `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${apiKey}`,
          { retries: 2, providerId: 'owm' },
        )
        first = Array.isArray(geo) ? geo[0] : null
        if (first) await cacheStore.set(geoKey, first, 24 * 60 * 60 * 1000)
      }
      if (!first?.lat || !first?.lon) return null

      // One Call 3.0 current data (cache for 15 minutes)
      const ocKey = `owm:onecall:${first.lat.toFixed(3)},${first.lon.toFixed(3)}`
      let oneCall = await cacheStore.get<any>(ocKey)
      if (!oneCall) {
        oneCall = await fetchOwmJsonWithRotation<any>(
          (apiKey) => `https://api.openweathermap.org/data/3.0/onecall?lat=${first.lat}&lon=${first.lon}&exclude=minutely,hourly,daily,alerts&units=metric&appid=${apiKey}`,
          { retries: 2, providerId: 'owm' },
        )
        await cacheStore.set(ocKey, oneCall, 15 * 60 * 1000)
      }

      const curr = oneCall?.current || {}
      const humidity: number = curr.humidity ?? 0
      const windKph: number = curr.wind_speed != null ? Number(curr.wind_speed) * 3.6 : 0 // m/s -> km/h
      const uvIndex: number = curr.uvi ?? 0

      // Derive proxies (consistent with WeatherAPI path)
      const soilMoisture = Math.max(0, Math.min(1, humidity / 100))
      const wildfireRiskRaw = uvIndex + windKph / 10 - humidity / 20
      const wildfireRisk = Math.max(1, Math.min(10, Math.round(wildfireRiskRaw)))
      const eqs = this.calculateEnvironmentalQualityScore(uvIndex, soilMoisture, wildfireRisk)

      const ts = typeof curr.dt === 'number' ? new Date(curr.dt * 1000).toISOString() : new Date().toISOString()

      return {
        uv_index: uvIndex,
        soil_moisture: soilMoisture,
        wildfire_risk: wildfireRisk,
        environmental_quality_score: eqs,
        location: location,
        timestamp: ts,
        source: 'OWM-derived metrics',
      }
    } catch (error) {
      console.error('OWM derived metrics error:', error)
      return null
    }
  }

  private calculateEnvironmentalQualityScore(uvIndex: number, soilMoisture: number, wildfireRisk: number): number {
    // Calculate a composite environmental quality score (0-100, where 100 is excellent)
    let score = 100

    // UV Index penalty (0-11 scale, higher is worse)
    if (uvIndex > 8) score -= 20 // High UV
    else if (uvIndex > 6) score -= 10 // Moderate UV
    else if (uvIndex > 3) score -= 5 // Low UV

    // Soil moisture penalty (0-1 scale, lower is worse)
    if (soilMoisture < 0.3) score -= 15 // Very dry
    else if (soilMoisture < 0.5) score -= 8 // Dry
    else if (soilMoisture > 0.9) score -= 5 // Very wet

    // Wildfire risk penalty (0-10 scale, higher is worse)
    if (wildfireRisk > 7) score -= 25 // Extreme risk
    else if (wildfireRisk > 5) score -= 15 // High risk
    else if (wildfireRisk > 3) score -= 8 // Moderate risk

    return Math.max(0, Math.min(100, score))
  }

  private async writeToBlockchain(stream: string, data: any, sourceHash?: string): Promise<void> {
    try {
      // Gate writes when invoked from Next.js API routes (non-worker process)
      if (typeof process !== 'undefined' && process.env.GAIALOG_WORKER_PROCESS !== '1') {
        console.warn('⚠️ Non-worker context detected; skipping on-chain write')
        return
      }
      let payloadToWrite: any = data
      // WAQI archival gate: until explicit approval, avoid storing raw WAQI data on-chain
      if (data && data.source === 'WAQI' && process.env.WAQI_ARCHIVAL_APPROVED !== 'true') {
        const sourceString = JSON.stringify({ stream, data })
        const sourceHash = Buffer.from(sourceString).toString('base64').substring(0, 32)
        // Include key numeric metrics but omit raw nested payload; remove attribution/notice
        payloadToWrite = {
          source: 'WAQI',
          location: data.location,
          timestamp: data.timestamp,
          aqi: data.aqi,
          pm25: data.pm25,
          pm10: data.pm10,
          co: data.co,
          no2: data.no2,
          o3: data.o3,
        }
      }

      const collectedAt = new Date(data?.timestamp || Date.now())
      const txid = await blockchainService.writeToChain({
        stream,
        timestamp: Date.now(),
        payload: payloadToWrite
      })
      try {
        await upsertTxLog({
          txid: txid || `local_${Date.now()}`,
          type: stream,
          provider: String(data?.source || 'unknown'),
          collected_at: collectedAt,
          status: txid && txid !== 'blockchain-not-configured' ? 'pending' as const : 'failed' as const,
          onchain_at: null,
          fee_sats: null,
          wallet_index: null,
          retries: null,
          error: txid === 'blockchain-not-configured' ? 'Blockchain not configured' : null,
        })
        // Link txid back to the reading row using source_hash
        if (txid && txid !== 'blockchain-not-configured' && sourceHash) {
          try {
            const s = stream
            if (s === 'air_quality') {
              const { setAirQualityTxId } = await import('./repositories')
              await setAirQualityTxId(sourceHash, txid)
            } else if (s === 'water_levels') {
              const { setWaterLevelTxId } = await import('./repositories')
              await setWaterLevelTxId(sourceHash, txid)
            } else if (s === 'seismic_activity') {
              const { setSeismicTxId } = await import('./repositories')
              await setSeismicTxId(sourceHash, txid)
            } else if (s === 'advanced_metrics') {
              const { setAdvancedTxId } = await import('./repositories')
              await setAdvancedTxId(sourceHash, txid)
            }
          } catch (linkErr) {
            console.warn('txid link error:', linkErr)
          }
        }
      } catch (e) {
        if (process.env.DEBUG_DB_WRITES === '1') {
          try { console.error('tx_log upsert error:', e) } catch {}
        }
      }
      console.log(`✅ Successfully wrote ${stream} data to blockchain`)
    } catch (error) {
      console.error(`❌ Failed to write ${stream} data to blockchain:`, error)
      try {
        await upsertTxLog({
          txid: `error_${Date.now()}`,
          type: stream,
          provider: String(data?.source || 'unknown'),
          collected_at: new Date(data?.timestamp || Date.now()),
          status: 'failed',
          onchain_at: null,
          fee_sats: null,
          wallet_index: null,
          retries: 1,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      } catch (e) {
        if (process.env.DEBUG_DB_WRITES === '1') {
          try { console.error('tx_log upsert (failure) error:', e) } catch {}
        }
      }
    }
  }

  private getDateString(daysOffset: number): string {
    const date = new Date()
    date.setDate(date.getDate() + daysOffset)
    return date.toISOString().split('T')[0]
  }

  async collectAllData(): Promise<{
    airQuality: AirQualityData | null
    waterLevels: WaterLevelData | null
    seismic: SeismicData | null
    advancedMetrics: AdvancedMetricsData | null
  }> {
    console.log('🔄 Starting worldwide environmental data collection...')
    
    const [airQuality, waterLevels, seismic, advancedMetrics] = await Promise.allSettled([
      this.collectAirQualityData(),
      this.collectWaterLevelData(),
      this.collectSeismicData(),
      this.collectAdvancedMetricsData()
    ])

    const result = {
      airQuality: airQuality.status === 'fulfilled' ? airQuality.value : null,
      waterLevels: waterLevels.status === 'fulfilled' ? waterLevels.value : null,
      seismic: seismic.status === 'fulfilled' ? seismic.value : null,
      advancedMetrics: advancedMetrics.status === 'fulfilled' ? advancedMetrics.value : null
    }

    console.log('✅ Worldwide data collection completed')
    return result
  }
}

// Export singleton instance
export const dataCollector = new DataCollector()

// -----------------------
// Batch collection helpers
// -----------------------

export async function collectAirQualityDataBatch(cities: string[], useWAQI: boolean = false): Promise<AirQualityData[]> {
  const results: AirQualityData[] = []
  for (const city of cities) {
    try {
      if (useWAQI && process.env.WAQI_API_KEY) {
        if (!(await budgetStore.canConsume('waqi'))) continue
        const data = await fetchJsonWithRetry<any>(
          `https://api.waqi.info/feed/${encodeURIComponent(city)}/?token=${process.env.WAQI_API_KEY}`,
          { retries: 2 }
        )
        if (data?.status === 'ok') {
          const item: AirQualityData = {
            aqi: data.data.aqi,
            pm25: data.data.iaqi?.pm25?.['v'] || 0,
            pm10: data.data.iaqi?.pm10?.['v'] || 0,
            co: data.data.iaqi?.co?.['v'] || 0,
            no2: data.data.iaqi?.no2?.['v'] || 0,
            o3: data.data.iaqi?.o3?.['v'] || 0,
            location: data.data.city?.name || city,
            timestamp: data.data.time?.iso || new Date().toISOString(),
            source: 'WAQI',
          }
          const key = `waqi:air:${item.location}:${item.timestamp}`
          if (await dedupeStore.add(key)) {
            results.push(item)
            await budgetStore.consume('waqi')
          }
          continue
        }
      }
      if (process.env.WEATHERAPI_KEY) {
        if (!(await budgetStore.canConsume('weatherapi'))) continue
        const wa = await fetchJsonWithRetry<any>(
          `https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHERAPI_KEY}&q=${encodeURIComponent(city)}&aqi=yes`,
          { retries: 2 }
        )
        const item: AirQualityData = {
          aqi: wa?.current?.air_quality?.['us-epa-index'] || 0,
          pm25: wa?.current?.air_quality?.['pm2_5'] || 0,
          pm10: wa?.current?.air_quality?.['pm10'] || 0,
          co: wa?.current?.air_quality?.['co'] || 0,
          no2: wa?.current?.air_quality?.['no2'] || 0,
          o3: wa?.current?.air_quality?.['o3'] || 0,
          location: wa?.location?.name || city,
          timestamp: new Date().toISOString(),
          source: 'WeatherAPI.com',
          coordinates: (typeof wa?.location?.lat === 'number' && typeof wa?.location?.lon === 'number') ? { lat: wa.location.lat, lon: wa.location.lon } : undefined,
        }
        // Country toggle enforcement for WeatherAPI by nearest OWM country
        try {
          if (item.coordinates) {
            const { getNearestOwmCountry } = await import('./repositories')
            const { isCountryAllowed } = await import('./country-controls')
            const cc = await getNearestOwmCountry(item.coordinates.lat, item.coordinates.lon)
            if (!isCountryAllowed('weatherapi' as any, cc)) { await new Promise(r=>setTimeout(r,200)); continue }
          }
        } catch {}
        const key = `weatherapi:air:${item.location}:${item.timestamp}`
        if (await dedupeStore.add(key)) {
          results.push(item)
          await budgetStore.consume('weatherapi')
        }
      }
      await new Promise(r => setTimeout(r, 200))
    } catch {
      continue
    }
  }
  return results
}

// Locally cached NOAA station list – the metadata endpoint rarely changes,
// so we keep the last successful response and reuse it on HTTP 304.
let _noaaStationCache: any[] | null = null

// Freshness watermarks: track last-seen provider timestamp per station so
// snapshot feeds can skip records that haven't changed since the previous cycle.
const _ndbcWatermarks = new Map<string, string>()
const _sensorCommunityWatermarks = new Map<string, string>()

export async function collectWaterLevelDataBatch(limit: number = 25, sweepBudgetMs: number = 0): Promise<WaterLevelData[]> {
  const out: WaterLevelData[] = []
  const stations = await fetchJsonWithRetry<any>(
    'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels',
    { retries: 2, etagKey: 'noaa:stations:waterlevels', providerId: 'noaa' }
  )

  // When NOAA returns 304 Not Modified, reuse the locally cached station list
  // instead of treating it as empty (which previously stopped all collection).
  if ((stations as any)?.__notModified) {
    if (!_noaaStationCache || _noaaStationCache.length === 0) {
      console.warn('NOAA station list returned 304 but no local cache available – skipping this cycle')
      return out
    }
  } else {
    const fresh = stations?.stations || []
    if (fresh.length > 0) {
      _noaaStationCache = fresh
    }
  }

  const list = _noaaStationCache || []
  const total = list.length
  if (total === 0) {
    console.warn('NOAA: Station list is empty - nothing to collect')
    return out
  }

  const products = getNoaaCoopsProducts()
  const concurrency = Math.max(1, Number(process.env.NOAA_STATION_CONCURRENCY || 4))
  const sweepStart = Date.now()
  const effectiveBudget = sweepBudgetMs > 0 ? sweepBudgetMs : Infinity
  let totalProcessed = 0
  let sweepPages = 0
  let cursorWrapped = false

  while (!cursorWrapped && (Date.now() - sweepStart) < effectiveBudget) {
    const cursor = await readCursor('noaa', null, 'station_index')
    const selectedStations = buildRotatingSlice(list, cursor, Math.min(limit, total))
    if (selectedStations.length === 0) break
    const nextCursor = (cursor + selectedStations.length) % total
    cursorWrapped = nextCursor <= cursor && sweepPages > 0
    await writeCursor('noaa', null, 'station_index', nextCursor)

    if (sweepPages === 0) {
      console.log(
        `NOAA: Processing stations (${total} total, products=${Array.from(products).join(',')}, concurrency=${concurrency}, sweep=${sweepBudgetMs > 0 ? 'on' : 'off'})...`
      )
    }

    const batchStart = Date.now()
    for (let offset = 0; offset < selectedStations.length; offset += concurrency) {
      const slice = selectedStations.slice(offset, offset + concurrency)
      const results = await Promise.all(slice.map(station => collectNoaaWaterLevelForStation(station, products)))
      for (const item of results) {
        if (item) out.push(item)
      }
    }
    totalProcessed += selectedStations.length
    sweepPages++

    if (sweepBudgetMs <= 0) break
    if (cursorWrapped) break
  }

  const totalElapsed = ((Date.now() - sweepStart) / 1000).toFixed(1)
  console.log(`NOAA: Batch complete - ${out.length} readings from ${totalProcessed} stations (${sweepPages} pages) in ${totalElapsed}s${cursorWrapped ? ' [full cycle]' : ''}`)
  return out
}

export async function collectSeismicDataBatch(hours: number = 6, minMag: number = 2.5, maxResults?: number): Promise<SeismicData[]> {
  const endTime = new Date().toISOString()
  const startTime = new Date(Date.now() - hours * 3600 * 1000).toISOString()
  // Note: USGS FDSN event API does not use API keys; do not append
  let url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${startTime}&endtime=${endTime}&minmagnitude=${minMag}&orderby=time`
  if (typeof maxResults === 'number' && maxResults > 0) {
    url += `&limit=${maxResults}`
  }
  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'usgs' })
  const features = data?.features || []
  const out: SeismicData[] = []
  for (const f of features) {
    const item: SeismicData = {
      magnitude: f.properties?.mag,
      depth: f.properties?.depth,
      location: f.properties?.place,
      coordinates: { lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0] },
      timestamp: new Date(f.properties?.time).toISOString(),
      source: 'USGS Earthquake API',
      event_id: f.id,
    }
    // Country toggle enforcement for USGS by nearest OWM country
    try {
      const { getNearestOwmCountry } = await import('./repositories')
      const { isCountryAllowed } = await import('./country-controls')
      const cc = await getNearestOwmCountry(item.coordinates.lat, item.coordinates.lon)
      if (!isCountryAllowed('usgs' as any, cc)) continue
    } catch {}
    const key = `usgs:seis:${item.event_id}`
    if (await dedupeStore.add(key)) out.push(item)
  }
  return out
}

export async function collectSensorCommunityDataBatch(limit: number = 5000, sweepAll: boolean = false): Promise<AirQualityData[]> {
  const cacheKey = 'sensor_community:snapshot'
  const cursorKey = 'sensor_community'
  const endpoint = process.env.SENSOR_COMMUNITY_URL || 'https://data.sensor.community/static/v2/data.dust.min.json'

  let snapshot = await fetchJsonWithRetry<any[]>(endpoint, {
    retries: 2,
    providerId: 'sensor_community',
    etagKey: cacheKey,
  })

  if ((snapshot as any)?.__notModified) {
    snapshot = (await cacheStore.get<any[]>(cacheKey)) || []
  } else if (Array.isArray(snapshot)) {
    await cacheStore.set(cacheKey, snapshot, 10 * 60 * 1000)
  }

  const records = Array.isArray(snapshot) ? snapshot : []
  if (records.length === 0) return []

  const sorted = [...records].sort((a, b) => {
    const left = Number(a?.sensor?.id || 0)
    const right = Number(b?.sensor?.id || 0)
    return left - right
  })

  const total = sorted.length
  const useFullSnapshot = sweepAll || isTruthyEnv(process.env.SENSOR_COMMUNITY_USE_FULL_SNAPSHOT, false)
  const cursor = await readCursor('sensor_community', null, 'snapshot_index')
  const selected = useFullSnapshot || limit >= total
    ? sorted
    : buildRotatingSlice(sorted, Number.isFinite(cursor) ? cursor : 0, limit)
  if (!(useFullSnapshot || limit >= total)) {
    await writeCursor('sensor_community', null, 'snapshot_index', ((cursor || 0) + selected.length) % total)
  }

  const out: AirQualityData[] = []
  for (const record of selected) {
    const values = parseSensorCommunityValues(record?.sensordatavalues || [])
    const pm10 = values.P1 ?? values.pm10
    const pm25 = values.P2 ?? values.pm25
    if (pm10 === undefined && pm25 === undefined) continue

    const coordinates = (record?.location?.latitude != null && record?.location?.longitude != null)
      ? {
          lat: Number(record.location.latitude),
          lon: Number(record.location.longitude),
        }
      : undefined
    if (coordinates && (!Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lon))) {
      continue
    }

    const sensorId = record?.sensor?.id != null ? String(record.sensor.id) : String(record?.id || 'unknown')
    const timestamp = normaliseProviderTimestamp(record?.timestamp)

    const lastSeen = _sensorCommunityWatermarks.get(sensorId)
    if (lastSeen === timestamp) continue
    _sensorCommunityWatermarks.set(sensorId, timestamp)

    const key = `sensor_community:${sensorId}:${timestamp}`
    if (!(await dedupeStore.add(key))) continue

    const country = record?.location?.country ? String(record.location.country).trim() : ''
    let locationName = ''
    if (coordinates) {
      const latDir = coordinates.lat >= 0 ? 'N' : 'S'
      const lonDir = coordinates.lon >= 0 ? 'E' : 'W'
      const latStr = Math.abs(coordinates.lat).toFixed(2)
      const lonStr = Math.abs(coordinates.lon).toFixed(2)
      locationName = country
        ? `${country} (${latStr}°${latDir}, ${lonStr}°${lonDir})`
        : `${latStr}°${latDir}, ${lonStr}°${lonDir}`
    } else {
      locationName = country || `Sensor ${sensorId}`
    }
    out.push({
      aqi: approximateAqiFromPm(pm25, pm10) ?? 0,
      pm25: pm25 ?? 0,
      pm10: pm10 ?? 0,
      co: 0,
      no2: 0,
      o3: 0,
      temperature: values.temperature ?? values.temperature_c,
      humidity: values.humidity ?? values.humidity_pct,
      pressure: values.pressure_at_sealevel ?? values.pressure,
      location: locationName,
      timestamp,
      source: 'Sensor.Community',
      coordinates,
      station_id: sensorId,
    })
  }

  return out
}

export async function collectNdbcLatestObservations(limit: number = 1000, sweepAll: boolean = false): Promise<WaterLevelData[]> {
  const endpoint = process.env.NDBC_LATEST_OBS_URL || 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt'
  const raw = await fetchTextWithRetry(endpoint, {
    retries: 2,
    providerId: 'noaa_ndbc',
    headers: { 'User-Agent': 'GaiaLog/1.0' },
  })

  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))

  if (lines.length === 0) return []

  const useFullSnapshot = sweepAll || isTruthyEnv(process.env.NDBC_USE_FULL_SNAPSHOT, false)
  const cursor = await readCursor('noaa_ndbc', null, 'obs_index')
  const selected = useFullSnapshot || limit >= lines.length
    ? lines
    : buildRotatingSlice(lines, Number.isFinite(cursor) ? cursor : 0, limit)
  if (!(useFullSnapshot || limit >= lines.length)) {
    await writeCursor('noaa_ndbc', null, 'obs_index', ((cursor || 0) + selected.length) % lines.length)
  }

  const out: WaterLevelData[] = []
  for (const line of selected) {
    const parts = line.split(/\s+/)
    if (parts.length < 18) continue

    const [
      stationId,
      latRaw,
      lonRaw,
      yearRaw,
      monthRaw,
      dayRaw,
      hourRaw,
      minuteRaw,
      windDirRaw,
      windSpeedRaw,
      gustRaw,
      waveHeightRaw,
      dominantPeriodRaw,
      averagePeriodRaw,
      meanWaveDirectionRaw,
      pressureRaw,
      pressureTrendRaw,
      airTempRaw,
      waterTempRaw,
      dewPointRaw,
      visibilityRaw,
      tideRaw,
    ] = parts

    const year = Number(yearRaw)
    const month = Number(monthRaw)
    const day = Number(dayRaw)
    const hour = Number(hourRaw)
    const minute = Number(minuteRaw)
    if (![year, month, day, hour, minute].every(value => Number.isFinite(value))) continue

    const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString()

    const lastSeen = _ndbcWatermarks.get(stationId)
    if (lastSeen === timestamp) continue
    _ndbcWatermarks.set(stationId, timestamp)

    const key = `noaa_ndbc:${stationId}:${timestamp}`
    if (!(await dedupeStore.add(key))) continue

    const lat = parseNumericValue(latRaw)
    const lon = parseNumericValue(lonRaw)
    const tideFeet = parseNumericValue(tideRaw)
    const tideMetres = tideFeet !== undefined ? Number((tideFeet * 0.3048).toFixed(3)) : undefined
    const waveHeight = parseNumericValue(waveHeightRaw)

    out.push({
      river_level: tideMetres,
      sea_level: tideMetres,
      location: stationId,
      timestamp,
      source: 'NOAA NDBC',
      station_id: stationId,
      coordinates: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
      wave_height_m: waveHeight,
      tide_height: tideMetres,
      water_temperature_c: parseNumericValue(waterTempRaw),
      air_temperature_c: parseNumericValue(airTempRaw),
      dew_point_c: parseNumericValue(dewPointRaw),
      visibility_nmi: parseNumericValue(visibilityRaw),
      pressure_hpa: parseNumericValue(pressureRaw),
      pressure_tendency_hpa: parseNumericValue(pressureTrendRaw),
      wind_speed_kph: (() => {
        const windSpeed = parseNumericValue(windSpeedRaw)
        return windSpeed !== undefined ? Number((windSpeed * 3.6).toFixed(2)) : undefined
      })(),
      gust_kph: (() => {
        const gust = parseNumericValue(gustRaw)
        return gust !== undefined ? Number((gust * 3.6).toFixed(2)) : undefined
      })(),
      wind_direction_deg: parseNumericValue(windDirRaw),
      wave_period_s: parseNumericValue(dominantPeriodRaw),
      average_wave_period_s: parseNumericValue(averagePeriodRaw),
      mean_wave_direction_deg: parseNumericValue(meanWaveDirectionRaw),
      dissolved_oxygen_mg_l: undefined,
      salinity_psu: undefined,
      turbidity_ntu: undefined,
      ph: undefined,
      wave_height_is_nearby: false,
      wave_nearby_distance_km: undefined,
      wave_nearby_station: undefined,
    })
  }

  return out
}

export async function collectEMSCLatestEvents(minutesBack: number = 15, limit: number = 500): Promise<SeismicData[]> {
  const end = new Date()
  const start = new Date(end.getTime() - minutesBack * 60 * 1000)
  const url = `https://www.seismicportal.eu/fdsnws/event/1/query?format=json&starttime=${start.toISOString()}&endtime=${end.toISOString()}&limit=${limit}&orderby=time`
  const data = await fetchJsonWithRetry<any>(url, {
    retries: 2,
    providerId: 'emsc',
    jsonFallbackValue: { features: [] },
  })
  const features = Array.isArray(data?.features) ? data.features : []
  const out: SeismicData[] = []

  for (const feature of features) {
    const properties = feature?.properties || {}
    const coordinates = feature?.geometry?.coordinates || []
    const eventId = String(properties?.unid || feature?.id || '')
    if (!eventId) continue
    const key = `emsc:seis:${eventId}`
    if (!(await dedupeStore.add(key))) continue
    out.push({
      magnitude: Number(properties?.mag ?? 0),
      depth: Number(properties?.depth ?? 0),
      location: String(properties?.flynn_region || properties?.place || 'Unknown region'),
      coordinates: {
        lat: Number(properties?.lat ?? coordinates?.[1] ?? 0),
        lon: Number(properties?.lon ?? coordinates?.[0] ?? 0),
      },
      timestamp: normaliseProviderTimestamp(properties?.time),
      source: 'EMSC',
      event_id: eventId,
    })
  }

  return out
}

export async function collectGeoNetLatestEvents(minutesBack: number = 60, limit: number = 500): Promise<SeismicData[]> {
  const url = `https://api.geonet.org.nz/quake?MMI=-1`
  const data = await fetchJsonWithRetry<any>(url, {
    retries: 2,
    providerId: 'geonet',
    headers: { Accept: 'application/json' },
  })
  const features = Array.isArray(data?.features) ? data.features : []
  const cutoff = Date.now() - minutesBack * 60 * 1000
  const out: SeismicData[] = []

  for (const feature of features) {
    const properties = feature?.properties || {}
    const coordinates = feature?.geometry?.coordinates || []
    const eventId = String(properties?.publicID || feature?.id || '')
    if (!eventId) continue
    const ts = Date.parse(properties?.time)
    if (!Number.isFinite(ts) || ts < cutoff) continue
    const key = `geonet:seis:${eventId}`
    if (!(await dedupeStore.add(key))) continue
    out.push({
      magnitude: Number(properties?.magnitude ?? 0),
      depth: Number(properties?.depth ?? coordinates?.[2] ?? 0),
      location: String(properties?.locality || 'New Zealand'),
      coordinates: {
        lat: Number(coordinates?.[1] ?? 0),
        lon: Number(coordinates?.[0] ?? 0),
      },
      timestamp: new Date(ts).toISOString(),
      source: 'GeoNet NZ',
      event_id: eventId,
    })
    if (out.length >= limit) break
  }

  return out
}

// -----------------------
// WAQI station crawl + rotating batches
// -----------------------

type WaqiStation = { uid: number; lat: number; lon: number; aqi?: number | string; name?: string }

function generateGlobalTiles(step: number = 10): Array<{ lat1: number; lon1: number; lat2: number; lon2: number }> {
  const tiles: Array<{ lat1: number; lon1: number; lat2: number; lon2: number }> = []
  for (let lat = -80; lat < 80; lat += step) {
    for (let lon = -180; lon < 180; lon += step) {
      tiles.push({ lat1: lat, lon1: lon, lat2: lat + step, lon2: lon + step })
    }
  }
  return tiles
}

const WAQI_INDEX_FILE = path.join(os.tmpdir(), 'gaialog_waqi_station_index.json')

async function loadWaqiIndexFromDisk(): Promise<WaqiStation[]> {
  try {
    if (fs.existsSync(WAQI_INDEX_FILE)) {
      const raw = fs.readFileSync(WAQI_INDEX_FILE, 'utf8')
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr : []
    }
  } catch {}
  return []
}

async function saveWaqiIndexToDisk(stations: WaqiStation[]): Promise<void> {
  try {
    fs.writeFileSync(WAQI_INDEX_FILE, JSON.stringify(stations))
  } catch {}
}

const WAQI_TILES_PER_CYCLE = Math.max(1, Number(process.env.WAQI_TILES_PER_CYCLE || 10))

export async function ensureWaqiStationIndex(maxTilesToScan: number = WAQI_TILES_PER_CYCLE): Promise<void> {
  const token = process.env.WAQI_API_KEY
  if (!token) return
  const cacheKey = 'waqi:stationIndex'
  let index = await cacheStore.get<WaqiStation[]>(cacheKey)
  // Merge with persisted index from disk to survive restarts
  try {
    const disk = await loadWaqiIndexFromDisk()
    if (Array.isArray(disk) && disk.length) {
      const existing = new Set((index || []).map(s => s.uid))
      for (const s of disk) {
        if (!existing.has(s.uid)) {
          index = (index || []).concat([s])
        }
      }
    }
  } catch {}
  const tiles = generateGlobalTiles(10)
  let tileIdx = (await cursorStore.get('waqi', 'tileIdx')) as number | null
  if (!Array.isArray(index)) index = []
  const seen = new Set(index.map(s => s.uid))
  let scanned = 0
  let i = typeof tileIdx === 'number' ? tileIdx : 0
  while (scanned < maxTilesToScan && i < tiles.length) {
    const t = tiles[i]
    try {
      if (!(await budgetStore.canConsume('waqi'))) break
      const url = `https://api.waqi.info/map/bounds/?token=${token}&latlng=${t.lat1},${t.lon1},${t.lat2},${t.lon2}`
      const etagKey = `waqi:bounds:${t.lat1},${t.lon1},${t.lat2},${t.lon2}`
      const data = await fetchJsonWithRetry<any>(url, { retries: 1, etagKey, providerId: 'waqi' })
      if ((data as any)?.__notModified) {
        // No changes for this tile; advance and move on
        scanned++
        i++
        await budgetStore.consume('waqi')
        continue
      }
      const stations = Array.isArray(data?.data) ? data.data : []
      for (const s of stations) {
        const uid = s?.uid
        if (typeof uid === 'number' && !seen.has(uid)) {
          index.push({ uid, lat: s.lat, lon: s.lon, aqi: s.aqi, name: s.station?.name })
          seen.add(uid)
          // Persist to stations table with provider='waqi' and derived country
          try {
            const { getNearestOwmCountry, upsertStation } = await import('./repositories')
            const cc = await getNearestOwmCountry(Number(s.lat), Number(s.lon))
            await upsertStation({
              provider: 'waqi',
              station_code: String(uid),
              name: s.station?.name || null,
              city: s.station?.name || null,
              country: cc || null,
              lat: typeof s.lat === 'number' ? s.lat : null,
              lon: typeof s.lon === 'number' ? s.lon : null,
              metadata: null,
            })
          } catch {}
        }
      }
      await budgetStore.consume('waqi')
    } catch {
      // ignore tile fetch errors
    }
    scanned++
    i++
  }
  await cacheStore.set(cacheKey, index, 60 * 60 * 1000)
  await cursorStore.set('waqi', i % tiles.length, 'tileIdx')
  await saveWaqiIndexToDisk(index)
}

export async function collectWAQIStationsBatch(limit: number = 100): Promise<AirQualityData[]> {
  const out: AirQualityData[] = []
  const token = process.env.WAQI_API_KEY
  if (!token) return out
  await ensureWaqiStationIndex(WAQI_TILES_PER_CYCLE)
  const stations = (await cacheStore.get<WaqiStation[]>('waqi:stationIndex')) || []
  if (stations.length === 0) return out
  let idx = (await cursorStore.get('waqi', 'stationIdx')) as number | null
  let i = typeof idx === 'number' ? idx : 0
  let taken = 0
  while (taken < limit && taken < stations.length) {
    const s: WaqiStation = stations[i % stations.length] as any
    i++
    try {
      if (!(await budgetStore.canConsume('waqi'))) break
      const url = `https://api.waqi.info/feed/@${s.uid}/?token=${token}`
      const etagKey = `waqi:feed:@${s.uid}`
      const data = await fetchJsonWithRetry<any>(url, { retries: 1, etagKey, providerId: 'waqi' })
      if ((data as any)?.__notModified) {
        taken++
        await budgetStore.consume('waqi')
        continue
      }
      if (data?.status === 'ok') {
        const d = data.data
        const item: AirQualityData = {
          aqi: d.aqi,
          pm25: d.iaqi?.pm25?.['v'] || 0,
          pm10: d.iaqi?.pm10?.['v'] || 0,
          co: d.iaqi?.co?.['v'] || 0,
          no2: d.iaqi?.no2?.['v'] || 0,
          o3: d.iaqi?.o3?.['v'] || 0,
          so2: d.iaqi?.so2?.['v'] || 0,
          location: d.city?.name || s.name || `@${s.uid}`,
          timestamp: d.time?.iso || new Date().toISOString(),
          source: 'WAQI',
          coordinates: (typeof s.lat === 'number' && typeof s.lon === 'number') ? { lat: s.lat, lon: s.lon } : undefined,
          // Attach station id for downstream persistence
          ...(s?.uid ? { station_id: s.uid as any } : {}),
          // Optional environmental fields when present
          temperature: d.iaqi?.t?.['v'] ?? d.iaqi?.temp?.['v'],
          humidity: d.iaqi?.h?.['v'],
          pressure: d.iaqi?.p?.['v'],
        }
        // Country filter hook: derive WAQI country via nearest OWM country when coords exist
        try {
          if (item.coordinates) {
            const { getNearestOwmCountry } = await import('./repositories')
            const cc = await getNearestOwmCountry(item.coordinates.lat, item.coordinates.lon)
            const { isCountryAllowed } = await import('./country-controls')
            if (!isCountryAllowed('waqi' as any, cc)) {
              i++
              continue
            }
          }
        } catch {}
        const key = `waqi:air:${item.location}:${item.timestamp}`
        if (await dedupeStore.add(key)) out.push(item)
        await budgetStore.consume('waqi')
        taken++
      }
      await new Promise(r => setTimeout(r, 50))
    } catch {
      // skip station on failure
    }
  }
  await cursorStore.set('waqi', i % stations.length, 'stationIdx')
  return out
}

// ─── NOAA Space Weather (DSCOVR RTSW) ───────────────────────────────────────

export interface SpaceWeatherReading {
  timestamp: number
  source: string
  bx_gsm: number | null
  by_gsm: number | null
  bz_gsm: number | null
  bt: number | null
  speed: number | null
  density: number | null
  temperature: number | null
}

const _swWatermarks = new Map<string, number>()

export async function collectSpaceWeatherData(): Promise<SpaceWeatherReading[]> {
  const magUrl = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json'
  const windUrl = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json'

  const [magData, windData] = await Promise.all([
    fetchJsonWithRetry<any[]>(magUrl, { retries: 2, providerId: 'noaa_space_weather' }),
    fetchJsonWithRetry<any[]>(windUrl, { retries: 2, providerId: 'noaa_space_weather' }),
  ])

  const windByTime = new Map<string, any>()
  for (const w of (windData ?? [])) {
    if (w.time_tag) windByTime.set(w.time_tag, w)
  }

  const lastSeen = _swWatermarks.get('rtsw') ?? 0
  let maxTs = lastSeen
  const out: SpaceWeatherReading[] = []

  for (const m of (magData ?? [])) {
    if (!m.time_tag) continue
    const ts = new Date(m.time_tag).getTime()
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const w = windByTime.get(m.time_tag)
    const key = `sw:rtsw:${m.time_tag}`
    if (await dedupeStore.add(key)) {
      out.push({
        timestamp: ts,
        source: 'NOAA Space Weather',
        bx_gsm: parseFloat(m.bx_gsm) || null,
        by_gsm: parseFloat(m.by_gsm) || null,
        bz_gsm: parseFloat(m.bz_gsm) || null,
        bt: parseFloat(m.bt) || null,
        speed: w ? parseFloat(w.speed) || null : null,
        density: w ? parseFloat(w.density) || null : null,
        temperature: w ? parseFloat(w.temperature) || null : null,
      })
    }
  }
  if (maxTs > lastSeen) _swWatermarks.set('rtsw', maxTs)
  return out
}

// ─── USGS Geomagnetism ──────────────────────────────────────────────────────

export interface GeomagReading {
  timestamp: number
  source: string
  observatory: string
  latitude: number
  longitude: number
  elements: Record<string, number | null>
}

const GEOMAG_OBSERVATORIES = [
  { code: 'BOU', name: 'Boulder', lat: 40.137, lon: -105.237 },
  { code: 'BRW', name: 'Barrow', lat: 71.322, lon: -156.623 },
  { code: 'BSL', name: 'Stennis', lat: 30.350, lon: -89.637 },
  { code: 'CMO', name: 'College', lat: 64.874, lon: -147.860 },
  { code: 'DED', name: 'Deadhorse', lat: 70.356, lon: -148.793 },
  { code: 'FRD', name: 'Fredericksburg', lat: 38.205, lon: -77.373 },
  { code: 'FRN', name: 'Fresno', lat: 37.091, lon: -119.719 },
  { code: 'GUA', name: 'Guam', lat: 13.588, lon: 144.867 },
  { code: 'HON', name: 'Honolulu', lat: 21.316, lon: -158.000 },
  { code: 'NEW', name: 'Newport', lat: 48.265, lon: -117.123 },
  { code: 'SHU', name: 'Shumagin', lat: 55.348, lon: -160.465 },
  { code: 'SIT', name: 'Sitka', lat: 57.058, lon: -135.327 },
  { code: 'SJG', name: 'San Juan', lat: 18.113, lon: -66.150 },
  { code: 'TUC', name: 'Tucson', lat: 32.174, lon: -110.734 },
]

const _geomagWatermarks = new Map<string, number>()

export async function collectGeomagnetismData(): Promise<GeomagReading[]> {
  const now = new Date()
  const end = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const start = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const out: GeomagReading[] = []

  for (const obs of GEOMAG_OBSERVATORIES) {
    try {
      const url = `https://geomag.usgs.gov/ws/data/?id=${obs.code}&starttime=${start}&endtime=${end}&type=variation&elements=X,Y,Z,F&format=json&sampling_period=60`
      const data = await fetchJsonWithRetry<any>(url, { retries: 1, providerId: 'usgs_geomagnetism' })

      const values = data?.values
      if (!Array.isArray(values) || values.length === 0) continue

      const lastSeen = _geomagWatermarks.get(obs.code) ?? 0
      let maxTs = lastSeen
      const elementIds = (data.id || 'X,Y,Z,F').split(',')

      for (const v of values) {
        if (!v.t) continue
        const ts = new Date(v.t).getTime()
        if (isNaN(ts) || ts <= lastSeen) continue
        if (ts > maxTs) maxTs = ts

        const elements: Record<string, number | null> = {}
        const vals = Array.isArray(v.v) ? v.v : []
        for (let i = 0; i < elementIds.length; i++) {
          elements[elementIds[i].trim()] = vals[i] != null ? vals[i] : null
        }

        const key = `geomag:${obs.code}:${v.t}`
        if (await dedupeStore.add(key)) {
          out.push({
            timestamp: ts,
            source: 'USGS Geomagnetism',
            observatory: `${obs.code} (${obs.name})`,
            latitude: obs.lat,
            longitude: obs.lon,
            elements,
          })
        }
      }
      if (maxTs > lastSeen) _geomagWatermarks.set(obs.code, maxTs)
    } catch {
      // skip observatory on failure, continue with next
    }
  }
  return out
}

// ─── USGS Volcanoes ─────────────────────────────────────────────────────────

export interface VolcanoAlert {
  timestamp: number
  source: string
  volcanoName: string
  volcanoId: string
  latitude: number
  longitude: number
  alertLevel: string
  colorCode: string
  observatoryCode: string
}

const _volcanoWatermark = { ts: 0 }

export async function collectVolcanoAlerts(): Promise<VolcanoAlert[]> {
  const url = 'https://volcanoes.usgs.gov/vsc/api/volcanoApi/vhpstatus'
  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'usgs_volcanoes' })

  const items = Array.isArray(data) ? data : []
  const lastSeen = _volcanoWatermark.ts
  let maxTs = lastSeen
  const out: VolcanoAlert[] = []

  for (const item of items) {
    const vName = item?.vName ?? item?.volcano_name ?? item?.volcanoName ?? 'Unknown'
    const vnum = item?.vnum ?? item?.volcano_number ?? ''
    const dateStr = item?.alertDate ?? item?.colorDate ?? item?.vhp_update_datetime ?? item?.update_datetime ?? ''
    const ts = dateStr ? new Date(dateStr).getTime() : Date.now()
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const lat = Number(item?.lat ?? item?.latitude ?? 0)
    const lon = Number(item?.long ?? item?.longitude ?? 0)

    const key = `volcano:${vnum || vName}:${dateStr || ts}`
    if (await dedupeStore.add(key)) {
      out.push({
        timestamp: ts,
        source: 'USGS Volcanoes',
        volcanoName: vName,
        volcanoId: String(vnum),
        latitude: lat,
        longitude: lon,
        alertLevel: item?.alertLevel ?? item?.alert_level ?? 'UNASSIGNED',
        colorCode: item?.colorCode ?? item?.color_code ?? 'UNASSIGNED',
        observatoryCode: item?.obs ?? item?.obs_code ?? item?.observatory ?? '',
      })
    }
  }
  if (maxTs > lastSeen) _volcanoWatermark.ts = maxTs
  return out
}

// ─── IGRA v2 Upper Atmosphere Soundings ─────────────────────────────────────

export interface UpperAtmosphereReading {
  timestamp: number
  source: string
  stationId: string
  latitude: number
  longitude: number
  numLevels: number
  surfacePressure: number | null
  surfaceTemperature: number | null
  surfaceDewpoint: number | null
}

const _igraWatermark = { ts: 0 }

export async function collectUpperAtmosphereData(): Promise<UpperAtmosphereReading[]> {
  const now = new Date()
  const end = now.toISOString().slice(0, 10)
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const url = `https://www.ncei.noaa.gov/access/services/data/v1?dataset=igra2&stations=USM00072451,USM00072520,USM00072293,USM00072649,USM00072764,USM00072265,USM00072469,USM00072558,USM00072357,USM00072776&startDate=${start}&endDate=${end}&format=json`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'igra2', timeoutMs: 30000 })

  const records = Array.isArray(data) ? data : (data?.data ?? [])
  const lastSeen = _igraWatermark.ts
  let maxTs = lastSeen
  const out: UpperAtmosphereReading[] = []

  const grouped = new Map<string, any[]>()
  for (const rec of records) {
    const gKey = `${rec.station || rec.STATION}:${rec.date || rec.DATE}`
    if (!grouped.has(gKey)) grouped.set(gKey, [])
    grouped.get(gKey)!.push(rec)
  }

  for (const [gKey, levels] of grouped) {
    const first = levels[0]
    const dateStr = first.date || first.DATE || ''
    const ts = dateStr ? new Date(dateStr).getTime() : Date.now()
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const stationId = first.station || first.STATION || gKey.split(':')[0]
    const lat = parseFloat(first.latitude || first.LATITUDE) || 0
    const lon = parseFloat(first.longitude || first.LONGITUDE) || 0

    const surface = levels.find((l: any) => {
      const p = parseFloat(l.pressure || l.PRESSURE)
      return p > 900
    }) || first

    const key = `igra:${stationId}:${dateStr}`
    if (await dedupeStore.add(key)) {
      out.push({
        timestamp: ts,
        source: 'IGRA v2',
        stationId,
        latitude: lat,
        longitude: lon,
        numLevels: levels.length,
        surfacePressure: parseFloat(surface.pressure || surface.PRESSURE) || null,
        surfaceTemperature: parseFloat(surface.temperature || surface.TEMPERATURE) || null,
        surfaceDewpoint: parseFloat(surface.dewpoint || surface.DEWPOINT) || null,
      })
    }
  }
  if (maxTs > lastSeen) _igraWatermark.ts = maxTs
  return out
}

// ─── openSenseMap Boxes ──────────────────────────────────────────────────────

export interface OpenSenseMapReading {
  timestamp: number
  source: string
  boxId: string
  boxName: string
  latitude: number
  longitude: number
  temperature?: number | null
  humidity?: number | null
  pressure?: number | null
  pm25?: number | null
  pm10?: number | null
  uvIntensity?: number | null
  illuminance?: number | null
}

const _osmWatermark = { ts: 0 }

export async function collectOpenSenseMapData(limit: number = 500): Promise<OpenSenseMapReading[]> {
  const url = 'https://api.opensensemap.org/boxes?minimal=true&limit=1000&date=lastMeasurement'
  const boxes = await fetchJsonWithRetry<any[]>(url, { retries: 2, providerId: 'opensensemap', timeoutMs: 30000 })

  if (!Array.isArray(boxes)) return []
  const lastSeen = _osmWatermark.ts
  let maxTs = lastSeen
  const out: OpenSenseMapReading[] = []

  for (const box of boxes) {
    if (out.length >= limit) break
    if (!box?._id || !box?.currentLocation?.coordinates) continue

    const updated = box.lastMeasurementAt || box.updatedAt
    const ts = updated ? new Date(updated).getTime() : Date.now()
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const [lon, lat] = box.currentLocation.coordinates
    const key = `osm:${box._id}:${updated}`
    if (!(await dedupeStore.add(key))) continue

    const sensors: Record<string, number | null> = {}
    if (Array.isArray(box.sensors)) {
      for (const s of box.sensors) {
        const title = String(s?.title || '').toLowerCase()
        const val = parseNumericValue(s?.lastMeasurement?.value)
        if (val === undefined) continue
        if (title.includes('temperatur')) sensors.temperature = val
        else if (title.includes('feucht') || title.includes('humid')) sensors.humidity = val
        else if (title.includes('druck') || title.includes('press')) sensors.pressure = val
        else if (title.includes('pm2')) sensors.pm25 = val
        else if (title.includes('pm10')) sensors.pm10 = val
        else if (title.includes('uv')) sensors.uvIntensity = val
        else if (title.includes('lux') || title.includes('beleucht') || title.includes('illumin')) sensors.illuminance = val
      }
    }

    out.push({
      timestamp: ts,
      source: 'openSenseMap',
      boxId: box._id,
      boxName: box.name || box._id,
      latitude: lat,
      longitude: lon,
      temperature: sensors.temperature ?? null,
      humidity: sensors.humidity ?? null,
      pressure: sensors.pressure ?? null,
      pm25: sensors.pm25 ?? null,
      pm10: sensors.pm10 ?? null,
      uvIntensity: sensors.uvIntensity ?? null,
      illuminance: sensors.illuminance ?? null,
    })
  }
  if (maxTs > lastSeen) _osmWatermark.ts = maxTs
  return out
}

// ─── INTERMAGNET Geomagnetic Observatories ───────────────────────────────────

export interface IntermagnetReading {
  timestamp: number
  source: string
  observatory: string
  latitude: number
  longitude: number
  x: number | null
  y: number | null
  z: number | null
  f: number | null
}

const _intermagnetWatermark = { ts: 0 }

export async function collectIntermagnetData(): Promise<IntermagnetReading[]> {
  const now = new Date()
  const stop = now.toISOString().replace(/\.\d+Z$/, 'Z')
  const startDate = new Date(now.getTime() - 2 * 60 * 60 * 1000)
  const start = startDate.toISOString().replace(/\.\d+Z$/, 'Z')

  const capabilitiesUrl = 'https://imag-data.bgs.ac.uk/GIN_V1/hapi/catalog'
  let datasets: any[] = []
  try {
    const catalog = await fetchJsonWithRetry<any>(capabilitiesUrl, { retries: 2, providerId: 'intermagnet', timeoutMs: 20000 })
    datasets = Array.isArray(catalog?.catalog) ? catalog.catalog : []
  } catch { return [] }

  const observatories = datasets.slice(0, 30)
  const lastSeen = _intermagnetWatermark.ts
  let maxTs = lastSeen
  const out: IntermagnetReading[] = []

  for (const ds of observatories) {
    const id = ds?.id
    if (!id) continue
    try {
      const dataUrl = `https://imag-data.bgs.ac.uk/GIN_V1/hapi/data?id=${encodeURIComponent(id)}&time.min=${start}&time.max=${stop}&format=json`
      const resp = await fetchJsonWithRetry<any>(dataUrl, { retries: 1, providerId: 'intermagnet', timeoutMs: 15000 })
      const records = Array.isArray(resp?.data) ? resp.data : []
      if (records.length === 0) continue
      const last = records[records.length - 1]
      const tsStr = Array.isArray(last) ? last[0] : last?.Time || last?.timestamp
      const ts = tsStr ? new Date(tsStr).getTime() : Date.now()
      if (isNaN(ts) || ts <= lastSeen) continue
      if (ts > maxTs) maxTs = ts

      const key = `intermagnet:${id}:${tsStr}`
      if (!(await dedupeStore.add(key))) continue

      const vals = Array.isArray(last) ? last : [last?.Time, last?.X, last?.Y, last?.Z, last?.F]
      out.push({
        timestamp: ts,
        source: 'INTERMAGNET',
        observatory: id,
        latitude: resp?.parameters?.[0]?.latitude ?? 0,
        longitude: resp?.parameters?.[0]?.longitude ?? 0,
        x: parseNumericValue(vals[1]) ?? null,
        y: parseNumericValue(vals[2]) ?? null,
        z: parseNumericValue(vals[3]) ?? null,
        f: parseNumericValue(vals[4]) ?? null,
      })
    } catch { /* skip failed observatory */ }
  }
  if (maxTs > lastSeen) _intermagnetWatermark.ts = maxTs
  return out
}

// ─── IRIS EarthScope Seismic Events ──────────────────────────────────────────

export interface IrisSeismicEvent {
  timestamp: number
  source: string
  eventId: string
  magnitude: number
  depth: number
  location: string
  latitude: number
  longitude: number
}

const _irisWatermark = { ts: 0 }

export async function collectIrisEvents(minutesBack: number = 60, limit: number = 500): Promise<IrisSeismicEvent[]> {
  const now = new Date()
  const start = new Date(now.getTime() - minutesBack * 60 * 1000)
  const url = `https://service.iris.edu/fdsnws/event/1/query?format=geojson&starttime=${start.toISOString()}&endtime=${now.toISOString()}&minmagnitude=2&limit=${limit}&orderby=time-asc`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'iris', timeoutMs: 20000 })
  const features = Array.isArray(data?.features) ? data.features : []

  const lastSeen = _irisWatermark.ts
  let maxTs = lastSeen
  const out: IrisSeismicEvent[] = []

  for (const f of features) {
    const props = f?.properties
    const coords = f?.geometry?.coordinates
    if (!props || !coords) continue

    const ts = props.time ? new Date(props.time).getTime() : Date.now()
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const eventId = f.id || props.eventid || props.publicid || ''
    const key = `iris:${eventId}`
    if (!(await dedupeStore.add(key))) continue

    out.push({
      timestamp: ts,
      source: 'IRIS EarthScope',
      eventId,
      magnitude: parseFloat(props.mag) || 0,
      depth: parseFloat(coords[2]) || 0,
      location: props.place || props.description || 'Unknown',
      latitude: coords[1] || 0,
      longitude: coords[0] || 0,
    })
  }
  if (maxTs > lastSeen) _irisWatermark.ts = maxTs
  return out
}

// ─── NASA POWER Surface Meteorology ──────────────────────────────────────────

export interface NasaPowerReading {
  timestamp: number
  source: string
  latitude: number
  longitude: number
  temperature2m?: number | null
  relativeHumidity2m?: number | null
  windSpeed10m?: number | null
  precipitation?: number | null
  solarIrradiance?: number | null
  surfacePressure?: number | null
}

export async function collectNasaPowerData(points?: Array<{ lat: number; lon: number }>): Promise<NasaPowerReading[]> {
  const defaultPoints = [
    { lat: 51.5, lon: -0.1 },
    { lat: 40.7, lon: -74.0 },
    { lat: 35.7, lon: 139.7 },
    { lat: -33.9, lon: 18.4 },
    { lat: -23.5, lon: -46.6 },
  ]
  const targets = points || defaultPoints
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const dateStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '')
  const out: NasaPowerReading[] = []

  for (const pt of targets) {
    try {
      const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M,RH2M,WS10M,PRECTOTCORR,ALLSKY_SFC_SW_DWN,PS&community=RE&longitude=${pt.lon}&latitude=${pt.lat}&start=${dateStr}&end=${dateStr}&format=JSON`
      const data = await fetchJsonWithRetry<any>(url, { retries: 1, providerId: 'nasa_power', timeoutMs: 30000 })
      const params = data?.properties?.parameter
      if (!params) continue

      const key = `nasapower:${pt.lat}:${pt.lon}:${dateStr}`
      if (!(await dedupeStore.add(key))) continue

      const val = (obj: any) => {
        if (!obj) return null
        const vals = Object.values(obj) as number[]
        const last = vals[vals.length - 1]
        return last != null && last !== -999 ? last : null
      }

      out.push({
        timestamp: yesterday.getTime(),
        source: 'NASA POWER',
        latitude: pt.lat,
        longitude: pt.lon,
        temperature2m: val(params.T2M),
        relativeHumidity2m: val(params.RH2M),
        windSpeed10m: val(params.WS10M),
        precipitation: val(params.PRECTOTCORR),
        solarIrradiance: val(params.ALLSKY_SFC_SW_DWN),
        surfacePressure: val(params.PS),
      })
    } catch { /* skip failed point */ }
  }
  return out
}

// ─── Copernicus CAMS Atmospheric Composition ─────────────────────────────────

export interface CamsReading {
  timestamp: number
  source: string
  latitude: number
  longitude: number
  pm25?: number | null
  pm10?: number | null
  ozone?: number | null
  no2?: number | null
  so2?: number | null
  co?: number | null
}

export async function collectCamsData(): Promise<CamsReading[]> {
  const apiKey = process.env.COPERNICUS_CAMS_API_KEY
  if (!apiKey) return []

  const points = [
    { lat: 51.5, lon: -0.1, name: 'London' },
    { lat: 48.9, lon: 2.3, name: 'Paris' },
    { lat: 52.5, lon: 13.4, name: 'Berlin' },
    { lat: 40.4, lon: -3.7, name: 'Madrid' },
    { lat: 41.9, lon: 12.5, name: 'Rome' },
  ]
  const out: CamsReading[] = []

  for (const pt of points) {
    try {
      const url = `https://ads.atmosphere.copernicus.eu/api/v2/resources/cams-europe-air-quality-forecasts?type=forecast&variable=particulate_matter_2.5um,particulate_matter_10um,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide&latitude=${pt.lat}&longitude=${pt.lon}&format=json`
      const data = await fetchJsonWithRetry<any>(url, {
        retries: 1,
        providerId: 'copernicus_cams',
        timeoutMs: 30000,
        headers: { 'Authorization': `Bearer ${apiKey}` },
      })

      const vals = data?.values || data?.data || data
      if (!vals) continue

      const key = `cams:${pt.lat}:${pt.lon}:${new Date().toISOString().slice(0, 13)}`
      if (!(await dedupeStore.add(key))) continue

      out.push({
        timestamp: Date.now(),
        source: 'Copernicus CAMS',
        latitude: pt.lat,
        longitude: pt.lon,
        pm25: parseNumericValue(vals.pm2_5 ?? vals.particulate_matter_2p5um) ?? null,
        pm10: parseNumericValue(vals.pm10 ?? vals.particulate_matter_10um) ?? null,
        ozone: parseNumericValue(vals.ozone ?? vals.o3) ?? null,
        no2: parseNumericValue(vals.nitrogen_dioxide ?? vals.no2) ?? null,
        so2: parseNumericValue(vals.sulphur_dioxide ?? vals.so2) ?? null,
        co: parseNumericValue(vals.carbon_monoxide ?? vals.co) ?? null,
      })
    } catch { /* skip failed point */ }
  }
  return out
}

// ─── USGS Water Services ─────────────────────────────────────────────────────

export interface UsgsWaterReading {
  timestamp: number
  source: string
  siteId: string
  siteName: string
  latitude: number
  longitude: number
  dischargeCfs?: number | null
  gageHeightFt?: number | null
  waterTemperatureC?: number | null
  dissolvedOxygenMgL?: number | null
  specificConductance?: number | null
  ph?: number | null
  turbidityNtu?: number | null
}

const _usgsWaterWm = { ts: 0 }

export async function collectUsgsWaterData(limit: number = 500): Promise<UsgsWaterReading[]> {
  const paramCodes = '00060,00065,00010,00300,00095,00400,63680'
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&parameterCd=${paramCodes}&siteStatus=active&period=PT2H`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'usgs_water', timeoutMs: 30000 })
  const timeSeries = data?.value?.timeSeries
  if (!Array.isArray(timeSeries)) return []

  const lastSeen = _usgsWaterWm.ts
  let maxTs = lastSeen
  const siteMap = new Map<string, UsgsWaterReading>()

  for (const ts of timeSeries) {
    const siteCode = ts?.sourceInfo?.siteCode?.[0]?.value
    if (!siteCode) continue
    const siteName = ts?.sourceInfo?.siteName || siteCode
    const lat = parseFloat(ts?.sourceInfo?.geoLocation?.geogLocation?.latitude) || 0
    const lon = parseFloat(ts?.sourceInfo?.geoLocation?.geogLocation?.longitude) || 0
    const paramCode = ts?.variable?.variableCode?.[0]?.value
    const values = ts?.values?.[0]?.value
    if (!Array.isArray(values) || values.length === 0) continue

    const latest = values[values.length - 1]
    const tsMs = latest?.dateTime ? new Date(latest.dateTime).getTime() : Date.now()
    if (isNaN(tsMs) || tsMs <= lastSeen) continue
    if (tsMs > maxTs) maxTs = tsMs

    if (!siteMap.has(siteCode)) {
      siteMap.set(siteCode, {
        timestamp: tsMs,
        source: 'USGS Water Services',
        siteId: siteCode,
        siteName,
        latitude: lat,
        longitude: lon,
      })
    }
    const reading = siteMap.get(siteCode)!
    if (tsMs > reading.timestamp) reading.timestamp = tsMs
    const val = parseNumericValue(latest.value)
    if (val == null) continue

    if (paramCode === '00060') reading.dischargeCfs = val
    else if (paramCode === '00065') reading.gageHeightFt = val
    else if (paramCode === '00010') reading.waterTemperatureC = val
    else if (paramCode === '00300') reading.dissolvedOxygenMgL = val
    else if (paramCode === '00095') reading.specificConductance = val
    else if (paramCode === '00400') reading.ph = val
    else if (paramCode === '63680') reading.turbidityNtu = val
  }

  const out: UsgsWaterReading[] = []
  for (const reading of siteMap.values()) {
    if (out.length >= limit) break
    const key = `usgswater:${reading.siteId}:${reading.timestamp}`
    if (!(await dedupeStore.add(key))) continue
    out.push(reading)
  }
  if (maxTs > lastSeen) _usgsWaterWm.ts = maxTs
  return out
}

// ─── UK Environment Agency Flood Monitoring ──────────────────────────────────

export interface UkEaFloodWarning {
  timestamp: number
  source: string
  warningId: string
  description: string
  severityLevel: number
  floodArea: string
  county: string
  latitude: number
  longitude: number
  isRaised: boolean
  message: string
}

export interface UkEaFloodReading {
  timestamp: number
  source: string
  stationRef: string
  stationName: string
  latitude: number
  longitude: number
  riverLevelM?: number | null
  isRising?: boolean | null
  typicalRangeHigh?: number | null
  typicalRangeLow?: number | null
}

const _ukEaWm = { ts: 0 }

export async function collectUkEaFloodWarnings(): Promise<UkEaFloodWarning[]> {
  const url = 'https://environment.data.gov.uk/flood-monitoring/id/floods?_limit=200'
  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'uk_ea_flood', timeoutMs: 20000 })
  const items = Array.isArray(data?.items) ? data.items : []
  const out: UkEaFloodWarning[] = []

  for (const item of items) {
    const id = item?.floodAreaID || item?.['@id'] || ''
    const raised = item?.timeRaised || item?.timeMessageChanged
    const ts = raised ? new Date(raised).getTime() : Date.now()
    if (isNaN(ts)) continue

    const key = `ukea:warn:${id}:${raised}`
    if (!(await dedupeStore.add(key))) continue

    out.push({
      timestamp: ts,
      source: 'UK Environment Agency',
      warningId: id,
      description: item?.description || '',
      severityLevel: parseInt(item?.severityLevel) || 0,
      floodArea: item?.floodArea?.label || item?.eaAreaName || '',
      county: item?.floodArea?.county || '',
      latitude: parseFloat(item?.floodArea?.lat) || 0,
      longitude: parseFloat(item?.floodArea?.long) || 0,
      isRaised: true,
      message: item?.message || '',
    })
  }
  return out
}

export async function collectUkEaFloodReadings(limit: number = 500): Promise<UkEaFloodReading[]> {
  const url = 'https://environment.data.gov.uk/flood-monitoring/data/readings?_sorted&_limit=2000&latest'
  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'uk_ea_flood', timeoutMs: 30000 })
  const items = Array.isArray(data?.items) ? data.items : []

  const lastSeen = _ukEaWm.ts
  let maxTs = lastSeen
  const out: UkEaFloodReading[] = []

  for (const item of items) {
    if (out.length >= limit) break
    const dateStr = item?.dateTime
    const ts = dateStr ? new Date(dateStr).getTime() : Date.now()
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const stationRef = item?.measure?.station?.stationReference || ''
    const key = `ukea:read:${stationRef}:${dateStr}`
    if (!(await dedupeStore.add(key))) continue

    out.push({
      timestamp: ts,
      source: 'UK Environment Agency',
      stationRef,
      stationName: item?.measure?.station?.label || stationRef,
      latitude: parseFloat(item?.measure?.station?.lat) || 0,
      longitude: parseFloat(item?.measure?.station?.long) || 0,
      riverLevelM: parseNumericValue(item?.value) ?? null,
      isRising: null,
      typicalRangeHigh: parseNumericValue(item?.measure?.station?.typicalRangeHigh) ?? null,
      typicalRangeLow: parseNumericValue(item?.measure?.station?.typicalRangeLow) ?? null,
    })
  }
  if (maxTs > lastSeen) _ukEaWm.ts = maxTs
  return out
}

// ─── GBIF Occurrences ────────────────────────────────────────────────────────

export interface GbifOccurrence {
  timestamp: number
  source: string
  occurrenceKey: string
  species: string
  scientificName: string
  kingdom: string
  phylum: string
  taxonClass: string
  order: string
  family: string
  genus: string
  latitude: number
  longitude: number
  country: string
  basisOfRecord: string
  datasetName: string
}

const _gbifWm = { ts: 0 }

export async function collectGbifOccurrences(limit: number = 300): Promise<GbifOccurrence[]> {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const dateStr = yesterday.toISOString().slice(0, 10)
  const url = `https://api.gbif.org/v1/occurrence/search?hasCoordinate=true&hasGeospatialIssue=false&eventDate=${dateStr}&limit=${Math.min(limit, 300)}`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'gbif', timeoutMs: 30000 })
  const results = Array.isArray(data?.results) ? data.results : []

  const lastSeen = _gbifWm.ts
  let maxTs = lastSeen
  const out: GbifOccurrence[] = []

  for (const r of results) {
    if (out.length >= limit) break
    const eventDate = r?.eventDate || r?.modified
    const ts = eventDate ? new Date(eventDate).getTime() : Date.now()
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const key = `gbif:${r.key}`
    if (!(await dedupeStore.add(key))) continue

    out.push({
      timestamp: ts,
      source: 'GBIF',
      occurrenceKey: String(r.key),
      species: r.species || r.scientificName || 'Unknown',
      scientificName: r.scientificName || '',
      kingdom: r.kingdom || '',
      phylum: r.phylum || '',
      taxonClass: r.class || '',
      order: r.order || '',
      family: r.family || '',
      genus: r.genus || '',
      latitude: r.decimalLatitude || 0,
      longitude: r.decimalLongitude || 0,
      country: r.country || '',
      basisOfRecord: r.basisOfRecord || '',
      datasetName: r.datasetName || '',
    })
  }
  if (maxTs > lastSeen) _gbifWm.ts = maxTs
  return out
}

// ─── iNaturalist Observations ────────────────────────────────────────────────

export interface INaturalistObservation {
  timestamp: number
  source: string
  observationId: string
  species: string
  scientificName: string
  taxonRank: string
  iconicTaxon: string
  latitude: number
  longitude: number
  placeGuess: string
  qualityGrade: string
  observedOn: string
}

const _inatWm = { ts: 0 }

export async function collectINaturalistObservations(limit: number = 200): Promise<INaturalistObservation[]> {
  const now = new Date()
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const d1 = start.toISOString().slice(0, 10)
  const d2 = now.toISOString().slice(0, 10)
  const url = `https://api.inaturalist.org/v1/observations?d1=${d1}&d2=${d2}&quality_grade=research&has[]=geo&per_page=${Math.min(limit, 200)}&order=desc&order_by=observed_on`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'inaturalist', timeoutMs: 30000 })
  const results = Array.isArray(data?.results) ? data.results : []

  const lastSeen = _inatWm.ts
  let maxTs = lastSeen
  const out: INaturalistObservation[] = []

  for (const r of results) {
    if (out.length >= limit) break
    const ts = r.observed_on ? new Date(r.observed_on).getTime() : (r.created_at ? new Date(r.created_at).getTime() : Date.now())
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const key = `inat:${r.id}`
    if (!(await dedupeStore.add(key))) continue

    const taxon = r.taxon || {}
    const loc = r.geojson?.coordinates || r.location?.split(',') || [0, 0]
    const lat = parseFloat(loc[1] ?? loc[0]) || 0
    const lon = parseFloat(loc[0] ?? loc[1]) || 0

    out.push({
      timestamp: ts,
      source: 'iNaturalist',
      observationId: String(r.id),
      species: taxon.preferred_common_name || taxon.name || 'Unknown',
      scientificName: taxon.name || '',
      taxonRank: taxon.rank || '',
      iconicTaxon: taxon.iconic_taxon_name || '',
      latitude: lat,
      longitude: lon,
      placeGuess: r.place_guess || '',
      qualityGrade: r.quality_grade || '',
      observedOn: r.observed_on || '',
    })
  }
  if (maxTs > lastSeen) _inatWm.ts = maxTs
  return out
}

// ─── OBIS Marine Occurrences ─────────────────────────────────────────────────

export interface ObisOccurrence {
  timestamp: number
  source: string
  occurrenceId: string
  species: string
  scientificName: string
  phylum: string
  taxonClass: string
  order: string
  family: string
  latitude: number
  longitude: number
  depth?: number | null
  datasetName: string
  basisOfRecord: string
}

const _obisWm = { ts: 0 }

export async function collectObisOccurrences(limit: number = 300): Promise<ObisOccurrence[]> {
  const now = new Date()
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const startDate = start.toISOString().slice(0, 10)
  const url = `https://api.obis.org/v3/occurrence?startdate=${startDate}&size=${Math.min(limit, 300)}&fields=id,species,scientificName,phylum,class,order,family,decimalLatitude,decimalLongitude,depth,eventDate,datasetName,basisOfRecord`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'obis', timeoutMs: 30000 })
  const results = Array.isArray(data?.results) ? data.results : []

  const lastSeen = _obisWm.ts
  let maxTs = lastSeen
  const out: ObisOccurrence[] = []

  for (const r of results) {
    if (out.length >= limit) break
    const ts = r.eventDate ? new Date(r.eventDate).getTime() : Date.now()
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const key = `obis:${r.id}`
    if (!(await dedupeStore.add(key))) continue

    out.push({
      timestamp: ts,
      source: 'OBIS',
      occurrenceId: String(r.id),
      species: r.species || r.scientificName || 'Unknown',
      scientificName: r.scientificName || '',
      phylum: r.phylum || '',
      taxonClass: r.class || '',
      order: r.order || '',
      family: r.family || '',
      latitude: r.decimalLatitude || 0,
      longitude: r.decimalLongitude || 0,
      depth: parseNumericValue(r.depth) ?? null,
      datasetName: r.datasetName || '',
      basisOfRecord: r.basisOfRecord || '',
    })
  }
  if (maxTs > lastSeen) _obisWm.ts = maxTs
  return out
}

// ─── USFWS ECOS Species ─────────────────────────────────────────────────────

export interface EcosSpeciesListing {
  timestamp: number
  source: string
  speciesCode: string
  commonName: string
  scientificName: string
  listingStatus: string
  group: string
  family: string
  stateRange: string
}

export async function collectEcosSpecies(limit: number = 200): Promise<EcosSpeciesListing[]> {
  const url = `https://ecos.fws.gov/ecp/pullreports/catalog/species/report/species/export?format=json&distinct=true&columns=%2Fspecies%40cn%2Csn%2Cstatus%2Cdesc%2Cfamily%2Cspcode%2Cvipcode%2Crangebystate&filter=%2Fspecies%40status+%21%3D+%27Extinct%27`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'usfws_ecos', timeoutMs: 30000 })
  const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : [])
  const out: EcosSpeciesListing[] = []

  for (const r of rows) {
    if (out.length >= limit) break
    const spCode = r?.spcode || r?.[5] || ''
    const key = `ecos:${spCode}`
    if (!(await dedupeStore.add(key))) continue

    out.push({
      timestamp: Date.now(),
      source: 'USFWS ECOS',
      speciesCode: spCode,
      commonName: r?.cn || r?.[0] || '',
      scientificName: r?.sn || r?.[1] || '',
      listingStatus: r?.status || r?.[2] || '',
      group: r?.desc || r?.[3] || '',
      family: r?.family || r?.[4] || '',
      stateRange: r?.rangebystate || r?.[7] || '',
    })
  }
  return out
}

// ─── NatureServe Species ─────────────────────────────────────────────────────

export interface NatureServeSpecies {
  timestamp: number
  source: string
  elementGlobalId: string
  scientificName: string
  commonName: string
  globalRank: string
  roundedGlobalRank: string
  nation: string
  nationalRank: string
}

export async function collectNatureServeSpecies(limit: number = 100): Promise<NatureServeSpecies[]> {
  const url = `https://explorer.natureserve.org/api/data/speciesSearch`
  const body = {
    criteriaType: 'species',
    textCriteria: [],
    statusCriteria: [{ type: 'globalRank', paramType: 'rank', ranks: ['G1', 'G2', 'G3', 'T1', 'T2', 'T3'] }],
    locationCriteria: [],
    pagingOptions: { page: 0, recordsPerPage: Math.min(limit, 100) },
  }

  let data: any
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) return []
    data = await resp.json()
  } catch { return [] }

  const results = Array.isArray(data?.results) ? data.results : []
  const out: NatureServeSpecies[] = []

  for (const r of results) {
    if (out.length >= limit) break
    const id = r?.elementGlobalId || r?.uniqueId || ''
    const key = `nsrv:${id}`
    if (!(await dedupeStore.add(key))) continue

    const nations = Array.isArray(r?.nations) ? r.nations : []
    const firstNation = nations[0] || {}

    out.push({
      timestamp: Date.now(),
      source: 'NatureServe',
      elementGlobalId: id,
      scientificName: r?.scientificName || '',
      commonName: r?.primaryCommonName || '',
      globalRank: r?.gRank || '',
      roundedGlobalRank: r?.roundedGRank || '',
      nation: firstNation?.nationCode || '',
      nationalRank: firstNation?.nRank || '',
    })
  }
  return out
}

// ─── NASA EONET Natural Events ───────────────────────────────────────────────

export interface NasaEonetEvent {
  timestamp: number
  source: string
  eventId: string
  title: string
  category: string
  latitude: number
  longitude: number
  magnitudeValue?: number | null
  magnitudeUnit?: string | null
  link: string
}

const _eonetWm = { ts: 0 }

export async function collectNasaEonetEvents(limit: number = 100): Promise<NasaEonetEvent[]> {
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=${Math.min(limit, 100)}`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'nasa_eonet', timeoutMs: 20000 })
  const events = Array.isArray(data?.events) ? data.events : []

  const lastSeen = _eonetWm.ts
  let maxTs = lastSeen
  const out: NasaEonetEvent[] = []

  for (const ev of events) {
    if (out.length >= limit) break
    const geom = Array.isArray(ev?.geometry) ? ev.geometry[ev.geometry.length - 1] : null
    if (!geom) continue

    const ts = geom.date ? new Date(geom.date).getTime() : Date.now()
    if (isNaN(ts) || ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const key = `eonet:${ev.id}`
    if (!(await dedupeStore.add(key))) continue

    const coords = geom.coordinates || [0, 0]
    const categories = Array.isArray(ev.categories) ? ev.categories : []

    out.push({
      timestamp: ts,
      source: 'NASA EONET',
      eventId: ev.id,
      title: ev.title || '',
      category: categories[0]?.title || '',
      latitude: coords[1] || 0,
      longitude: coords[0] || 0,
      magnitudeValue: geom.magnitudeValue != null ? parseFloat(geom.magnitudeValue) : null,
      magnitudeUnit: geom.magnitudeUnit || null,
      link: ev.link || '',
    })
  }
  if (maxTs > lastSeen) _eonetWm.ts = maxTs
  return out
}

// ─── Global Forest Watch Alerts ──────────────────────────────────────────────

export interface GfwAlert {
  timestamp: number
  source: string
  alertId: string
  alertType: string
  confidence: string
  latitude: number
  longitude: number
  treeCoverLossHa?: number | null
  isoCountry: string
}

export async function collectGfwAlerts(limit: number = 200): Promise<GfwAlert[]> {
  const apiKey = process.env.GFW_API_KEY
  if (!apiKey) return []

  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const startDate = weekAgo.toISOString().slice(0, 10)
  const endDate = now.toISOString().slice(0, 10)
  const url = `https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts/latest/query?sql=SELECT latitude, longitude, gfw_integrated_alerts__confidence, gfw_integrated_alerts__date, iso, umd_tree_cover_loss__ha FROM results WHERE gfw_integrated_alerts__date >= '${startDate}' AND gfw_integrated_alerts__date <= '${endDate}' LIMIT ${limit}`

  const data = await fetchJsonWithRetry<any>(url, {
    retries: 1,
    providerId: 'global_forest_watch',
    timeoutMs: 30000,
    headers: { 'x-api-key': apiKey },
  })

  const rows = Array.isArray(data?.data) ? data.data : []
  const out: GfwAlert[] = []

  for (const r of rows) {
    if (out.length >= limit) break
    const dateStr = r?.gfw_integrated_alerts__date || r?.date
    const ts = dateStr ? new Date(dateStr).getTime() : Date.now()
    if (isNaN(ts)) continue

    const lat = r.latitude || 0
    const lon = r.longitude || 0
    const key = `gfw:${lat}:${lon}:${dateStr}`
    if (!(await dedupeStore.add(key))) continue

    out.push({
      timestamp: ts,
      source: 'Global Forest Watch',
      alertId: key,
      alertType: 'integrated_alert',
      confidence: r?.gfw_integrated_alerts__confidence || 'nominal',
      latitude: lat,
      longitude: lon,
      treeCoverLossHa: parseNumericValue(r?.umd_tree_cover_loss__ha) ?? null,
      isoCountry: r?.iso || '',
    })
  }
  return out
}

// ─── USGS MRDS Mining Sites ──────────────────────────────────────────────────

export interface UsgsMrdsSite {
  timestamp: number
  source: string
  depId: string
  siteName: string
  commodity: string
  depositType: string
  developmentStatus: string
  latitude: number
  longitude: number
  state: string
  country: string
}

export async function collectUsgsMrdsSites(limit: number = 500): Promise<UsgsMrdsSite[]> {
  const url = `https://mrdata.usgs.gov/mrds/mrds-us.json`

  let data: any
  try {
    data = await fetchJsonWithRetry<any>(url, { retries: 1, providerId: 'usgs_mrds', timeoutMs: 60000, jsonFallbackValue: [] })
  } catch { return [] }

  const features = Array.isArray(data?.features) ? data.features : (Array.isArray(data) ? data : [])
  const out: UsgsMrdsSite[] = []

  for (const f of features) {
    if (out.length >= limit) break
    const props = f?.properties || f
    const coords = f?.geometry?.coordinates || [props?.longitude, props?.latitude]
    const depId = props?.dep_id || props?.id || ''

    const key = `mrds:${depId}`
    if (!(await dedupeStore.add(key))) continue

    out.push({
      timestamp: Date.now(),
      source: 'USGS MRDS',
      depId: String(depId),
      siteName: props?.site_name || props?.name || '',
      commodity: props?.commod1 || props?.commodity || '',
      depositType: props?.dep_type || '',
      developmentStatus: props?.dev_stat || props?.development_status || '',
      latitude: parseFloat(coords[1] ?? props?.latitude) || 0,
      longitude: parseFloat(coords[0] ?? props?.longitude) || 0,
      state: props?.state || '',
      country: props?.country || 'US',
    })
  }
  return out
}

// ─── UK Planning Data (England) ──────────────────────────────────────────────

export interface UkPlanningApplication {
  timestamp: number
  source: string
  entityId: string
  applicationRef: string
  proposal: string
  decisionDate: string | null
  entryDate: string
  organisationEntity: string
  latitude: number | null
  longitude: number | null
}

const _ukPlanningWm = { offset: 0 }

export async function collectUkPlanningApplications(limit: number = 200): Promise<UkPlanningApplication[]> {
  const baseUrl = 'https://www.planning.data.gov.uk/entity.json'
  const params = new URLSearchParams({
    dataset: 'planning-application',
    limit: String(Math.min(limit, 200)),
    offset: String(_ukPlanningWm.offset),
  })
  const url = `${baseUrl}?${params}`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'uk_planning', timeoutMs: 30000 })
  const entities = Array.isArray(data?.entities) ? data.entities : []

  const out: UkPlanningApplication[] = []

  for (const e of entities) {
    if (out.length >= limit) break
    const entityId = String(e?.entity ?? '')
    const key = `ukplanning:${entityId}`
    if (!(await dedupeStore.add(key))) continue

    let lat: number | null = null
    let lon: number | null = null
    const point = e?.point
    if (point && typeof point === 'string') {
      const coords = point.split(',').map(parseFloat)
      if (coords.length >= 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
        lon = coords[0]
        lat = coords[1]
      }
    } else if (point && typeof point === 'object' && 'lat' in point && 'lon' in point) {
      lat = parseFloat((point as any).lat)
      lon = parseFloat((point as any).lon)
    }

    const entryDate = e?.entry_date ?? e?.['entry-date'] ?? ''
    const ts = entryDate ? new Date(entryDate).getTime() : Date.now()
    if (isNaN(ts)) continue

    out.push({
      timestamp: ts,
      source: 'UK Planning Data',
      entityId,
      applicationRef: e?.reference ?? '',
      proposal: (e?.description ?? '').slice(0, 500),
      decisionDate: e?.decision_date ?? e?.['decision-date'] ?? null,
      entryDate,
      organisationEntity: String(e?.['organisation-entity'] ?? e?.organisation_entity ?? ''),
      latitude: lat,
      longitude: lon,
    })
  }

  if (entities.length > 0) {
    _ukPlanningWm.offset = (_ukPlanningWm.offset + entities.length) % 100000
  }
  return out
}

// ─── Scotland Planning (Spatial Hub WFS) ──────────────────────────────────────

export interface ScotlandPlanningApplication {
  timestamp: number
  source: string
  applicationRef: string
  proposal: string
  decisionDate: string | null
  entryDate: string
  organisationEntity: string
  latitude: number | null
  longitude: number | null
}

const _scotlandPlanningWm = { offset: 0 }

export async function collectScotlandPlanningApplications(limit: number = 200): Promise<ScotlandPlanningApplication[]> {
  const baseUrl = 'https://geo.spatialhub.scot/geoserver/sh_plnapp/wfs'
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: 'sh_plnapp:pub_plnapppnt',
    outputFormat: 'application/json',
    count: String(Math.min(limit, 500)),
    startIndex: String(_scotlandPlanningWm.offset),
  })
  const url = `${baseUrl}?${params}`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'scotland_planning', timeoutMs: 45000 })
  const features = Array.isArray(data?.features) ? data.features : []

  const out: ScotlandPlanningApplication[] = []

  for (const f of features) {
    if (out.length >= limit) break
    const props = f?.properties ?? {}
    const ref = String(props.reference ?? props.local_auth ?? f?.id ?? '')
    const key = `scotlandplanning:${ref}`
    if (!(await dedupeStore.add(key))) continue

    let lat: number | null = null
    let lon: number | null = null
    const geom = f?.geometry
    if (geom?.type === 'Point' && Array.isArray(geom.coordinates)) {
      if (geom.coordinates.length >= 2) {
        lon = geom.coordinates[0]
        lat = geom.coordinates[1]
      }
    }

    const entryDate = props.date_received ?? props.date_submitted ?? ''
    const ts = entryDate ? new Date(entryDate).getTime() : Date.now()
    if (isNaN(ts)) continue

    out.push({
      timestamp: ts,
      source: 'Scotland Planning',
      applicationRef: ref,
      proposal: props.description ?? props.development ?? '',
      decisionDate: props.decision_date ?? null,
      entryDate,
      organisationEntity: String(props.local_auth ?? props.local_authority ?? ''),
      latitude: lat,
      longitude: lon,
    })
  }

  if (features.length > 0) {
    _scotlandPlanningWm.offset = (_scotlandPlanningWm.offset + features.length) % 50000
  }
  return out
}

// ─── NSW Planning (Planning Alerts AU) ───────────────────────────────────────

export interface NswPlanningApplication {
  timestamp: number
  source: string
  applicationRef: string
  proposal: string
  decisionDate: string | null
  entryDate: string
  organisationEntity: string
  latitude: number | null
  longitude: number | null
}

export async function collectNswPlanningApplications(limit: number = 200): Promise<NswPlanningApplication[]> {
  const apiKey = process.env.PLANNING_ALERTS_AU_API_KEY
  if (!apiKey?.trim()) return []

  const url = `https://api.planningalerts.org.au/applications.json?key=${encodeURIComponent(apiKey)}&lat=-33.8688&lng=151.2093&radius=50000&count=${Math.min(limit, 100)}`

  const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'nsw_planning', timeoutMs: 30000 })
  const applications = Array.isArray(data?.applications) ? data.applications : []

  const out: NswPlanningApplication[] = []

  for (const a of applications) {
    if (out.length >= limit) break
    const ref = String(a?.id ?? a?.council_reference ?? '')
    const key = `nswplanning:${ref}`
    if (!(await dedupeStore.add(key))) continue

    const lat = typeof a?.lat === 'number' && !isNaN(a.lat) ? a.lat : null
    const lon = typeof a?.lng === 'number' && !isNaN(a.lng) ? a.lng : null

    const dateReceived = a?.date_received ?? a?.date_scraped ?? ''
    const ts = dateReceived ? new Date(dateReceived).getTime() : Date.now()
    if (isNaN(ts)) continue

    out.push({
      timestamp: ts,
      source: 'NSW Planning',
      applicationRef: ref,
      proposal: (a?.description ?? '').slice(0, 500),
      decisionDate: a?.date_decided ?? null,
      entryDate: dateReceived,
      organisationEntity: String(a?.authority ?? a?.council ?? ''),
      latitude: lat,
      longitude: lon,
    })
  }

  return out
}

// ─── OpenSky Network Aircraft States ─────────────────────────────────────────

export interface OpenSkyState {
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
  verticalRate: number
  onGround: boolean
}

const _openskyWm = { ts: 0 }

export async function collectOpenSkyStates(limit: number = 1000): Promise<OpenSkyState[]> {
  const url = 'https://opensky-network.org/api/states/all'
  const headers: Record<string, string> = {}
  const user = process.env.OPENSKY_USERNAME
  const pass = process.env.OPENSKY_PASSWORD
  if (user && pass) {
    headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  }

  const data = await fetchJsonWithRetry<any>(url, { retries: 1, providerId: 'opensky', timeoutMs: 30000, headers })
  const states = Array.isArray(data?.states) ? data.states : []

  const lastSeen = _openskyWm.ts
  const apiTime = data?.time ? data.time * 1000 : Date.now()
  let maxTs = lastSeen
  const out: OpenSkyState[] = []

  for (const s of states) {
    if (out.length >= limit) break
    if (!Array.isArray(s) || s.length < 17) continue

    const icao24 = s[0]
    const lat = s[6]
    const lon = s[5]
    if (lat == null || lon == null) continue

    const ts = s[3] ? s[3] * 1000 : apiTime
    if (ts <= lastSeen) continue
    if (ts > maxTs) maxTs = ts

    const key = `osky:${icao24}:${Math.floor(ts / 60000)}`
    if (!(await dedupeStore.add(key))) continue

    out.push({
      timestamp: ts,
      source: 'OpenSky Network',
      icao24,
      callsign: (s[1] || '').trim(),
      originCountry: s[2] || '',
      latitude: lat,
      longitude: lon,
      altitudeM: s[13] ?? s[7] ?? 0,
      velocityMs: s[9] ?? 0,
      heading: s[10] ?? 0,
      verticalRate: s[11] ?? 0,
      onGround: !!s[8],
    })
  }
  if (maxTs > lastSeen) _openskyWm.ts = maxTs
  return out
}

// ─── AISStream Vessel Positions ──────────────────────────────────────────────

export interface AisVesselPosition {
  timestamp: number
  source: string
  mmsi: string
  vesselName: string
  shipType: number
  latitude: number
  longitude: number
  heading: number
  course: number
  speed: number
  destination: string
}

const _aisBuffer: AisVesselPosition[] = []
let _aisConnected = false

export function getAisBufferSnapshot(limit: number = 500): AisVesselPosition[] {
  const snapshot = _aisBuffer.splice(0, limit)
  return snapshot
}

export function startAisStream(): void {
  const apiKey = process.env.AISSTREAM_API_KEY
  if (!apiKey || _aisConnected) return

  _aisConnected = true

  const connectWs = () => {
    try {
      const WebSocket = require('ws')
      const ws = new WebSocket('wss://stream.aisstream.io/v0/stream')

      ws.on('open', () => {
        ws.send(JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: [[[-90, -180], [90, 180]]],
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        }))
      })

      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString())
          const meta = msg?.MetaData
          if (!meta) return

          const pos: AisVesselPosition = {
            timestamp: meta.time_utc ? new Date(meta.time_utc).getTime() : Date.now(),
            source: 'AISStream',
            mmsi: String(meta.MMSI || ''),
            vesselName: meta.ShipName || '',
            shipType: meta.ShipType || 0,
            latitude: meta.latitude || 0,
            longitude: meta.longitude || 0,
            heading: msg?.Message?.PositionReport?.TrueHeading || 0,
            course: msg?.Message?.PositionReport?.Cog || 0,
            speed: msg?.Message?.PositionReport?.Sog || 0,
            destination: msg?.Message?.ShipStaticData?.Destination || '',
          }

          if (_aisBuffer.length < 10000) {
            _aisBuffer.push(pos)
          }
        } catch { /* malformed message */ }
      })

      ws.on('close', () => {
        _aisConnected = false
        setTimeout(connectWs, 30000)
      })

      ws.on('error', () => {
        _aisConnected = false
        setTimeout(connectWs, 60000)
      })
    } catch {
      _aisConnected = false
    }
  }

  connectWs()
}

// ─── Movebank Animal Tracking ────────────────────────────────────────────────
// Aligned with Movebank REST API: https://github.com/movebank/movebank-api-doc
// Uses direct-read (CSV) with api-token or Basic auth. Fetches events + individuals.

const MOVEBANK_BASE = 'https://www.movebank.org/movebank/service/direct-read'
const MOVEBANK_MAX_STUDIES = 5
const MOVEBANK_MAX_EVENTS_PER_STUDY = 500

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      let end = i + 1
      while (end < line.length) {
        if (line[end] === '"') {
          if (line[end + 1] === '"') {
            end += 2
            continue
          }
          break
        }
        end++
      }
      result.push(line.slice(i + 1, end).replace(/""/g, '"'))
      i = end + 1
      if (line[i] === ',') i++
    } else {
      const comma = line.indexOf(',', i)
      if (comma === -1) {
        result.push(line.slice(i).trim())
        break
      }
      result.push(line.slice(i, comma).trim())
      i = comma + 1
    }
  }
  return result
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []
  const header = parseCSVLine(lines[0])
  const out: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i])
    const row: Record<string, string> = {}
    header.forEach((h, j) => {
      row[h] = values[j] ?? ''
    })
    out.push(row)
  }
  return out
}

function buildMovebankAuth(): { headers?: Record<string, string>; tokenParam?: string } {
  const user = process.env.MOVEBANK_USERNAME?.trim()
  const pass = process.env.MOVEBANK_PASSWORD?.trim()
  const apiKey = process.env.MOVEBANK_API_KEY?.trim()
  if (user && pass) {
    const encoded = Buffer.from(`${user}:${pass}`, 'utf-8').toString('base64')
    return { headers: { 'Authorization': `Basic ${encoded}` } }
  }
  if (apiKey?.includes(':')) {
    const encoded = Buffer.from(apiKey, 'utf-8').toString('base64')
    return { headers: { 'Authorization': `Basic ${encoded}` } }
  }
  if (apiKey) {
    return { tokenParam: apiKey }
  }
  return {}
}

export interface MovebankTrack {
  timestamp: number
  source: string
  studyId: string
  studyName: string
  individualId: string
  individualLocalId: string
  taxon: string
  latitude: number
  longitude: number
  altitudeM?: number | null
  groundSpeed?: number | null
  heading?: number | null
  visible?: boolean
  /** All event-level attributes (sensor-dependent) */
  eventAttributes: Record<string, unknown>
  /** All individual reference data (animal metadata) */
  individualAttributes: Record<string, unknown>
}

export async function collectMovebankTracking(limit: number = 200): Promise<MovebankTrack[]> {
  const auth = buildMovebankAuth()
  if (!auth.headers && !auth.tokenParam) return []

  const tokenParam = auth.tokenParam ? `&api-token=${encodeURIComponent(auth.tokenParam)}` : ''
  const out: MovebankTrack[] = []

  try {
    const studiesUrl = `${MOVEBANK_BASE}?entity_type=study&i_have_download_access=true&attributes=id,name${tokenParam}`
    const studiesText = await fetchTextWithRetry(studiesUrl, {
      retries: 1,
      providerId: 'movebank',
      timeoutMs: 30000,
      headers: auth.headers ?? {},
    })
    if (studiesText.trim().startsWith('<')) {
      console.warn('Movebank: Received HTML instead of CSV (license terms or error). Accept terms at movebank.org or check credentials.')
      return []
    }
    const studies = parseCSV(studiesText)
    const studyIds = studies
      .map(s => parseNumericValue(s.id))
      .filter((id): id is number => id !== undefined && id > 0)
      .slice(0, MOVEBANK_MAX_STUDIES)

    for (const studyId of studyIds) {
      if (out.length >= limit) break
      const studyRow = studies.find(s => String(parseNumericValue(s.id)) === String(studyId))
      const studyName = studyRow?.name ?? `study_${studyId}`

      const individualsUrl = `${MOVEBANK_BASE}?entity_type=individual&study_id=${studyId}&attributes=all${tokenParam}`
      let individuals: Record<string, string>[] = []
      try {
        const indText = await fetchTextWithRetry(individualsUrl, {
          retries: 1,
          providerId: 'movebank',
          timeoutMs: 30000,
          headers: auth.headers ?? {},
        })
        individuals = parseCSV(indText)
      } catch {
        // Individual fetch optional; continue with events only
      }

      const eventsUrl = `${MOVEBANK_BASE}?entity_type=event&study_id=${studyId}&attributes=all${tokenParam}`
      let events: Record<string, string>[] = []
      try {
        const evText = await fetchTextWithRetry(eventsUrl, {
          retries: 1,
          providerId: 'movebank',
          timeoutMs: 60000,
          headers: auth.headers ?? {},
        })
        events = parseCSV(evText).slice(0, MOVEBANK_MAX_EVENTS_PER_STUDY)
      } catch {
        continue
      }

      const indById = new Map<string, Record<string, string>>()
      for (const ind of individuals) {
        const id = ind.id ?? ind.local_identifier
        if (id) indById.set(String(id), ind)
      }

      for (const ev of events) {
        if (out.length >= limit) break
        const lat = parseNumericValue(ev.location_lat ?? ev.latitude)
        const lon = parseNumericValue(ev.location_long ?? ev.longitude)
        if (lat == null || lon == null) continue

        const tsRaw = ev.timestamp ?? ev['event-timestamp']
        const ts = tsRaw ? new Date(tsRaw).getTime() : Date.now()
        if (isNaN(ts)) continue

        const individualId = ev.individual_id ?? ev.individualId ?? ''
        const key = `movebank:${studyId}:${individualId}:${ts}`
        if (!(await dedupeStore.add(key))) continue

        const visibleStr = (ev.visible ?? '').toLowerCase()
        const visible = visibleStr === 'true' || visibleStr === '1'

        const eventAttributes: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(ev)) {
          if (k && v !== '' && v != null) {
            const num = parseNumericValue(v)
            eventAttributes[k] = num !== undefined ? num : v
          }
        }

        const ind = indById.get(String(individualId))
        const individualAttributes: Record<string, unknown> = {}
        if (ind) {
          for (const [k, v] of Object.entries(ind)) {
            if (k && v !== '' && v != null) {
              const num = parseNumericValue(v)
              individualAttributes[k] = num !== undefined ? num : v
            }
          }
        }

        out.push({
          timestamp: ts,
          source: 'Movebank',
          studyId: String(studyId),
          studyName,
          individualId: String(individualId),
          individualLocalId: String(ev.individual_local_identifier ?? ind?.local_identifier ?? ''),
          taxon: ev.individual_taxon_canonical_name ?? ind?.individual_taxon_canonical_name ?? '',
          latitude: lat,
          longitude: lon,
          altitudeM: parseNumericValue(ev.height_above_ellipsoid) ?? null,
          groundSpeed: parseNumericValue(ev.ground_speed) ?? null,
          heading: parseNumericValue(ev.heading) ?? null,
          visible,
          eventAttributes,
          individualAttributes,
        })
      }
    }
  } catch (error) {
    console.error('Movebank fetch error:', error)
  }
  return out
}
