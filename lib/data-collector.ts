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
} from './repositories'
import { fetchJsonWithRetry } from './provider-fetch'
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
}

export interface WaterLevelData {
  river_level: number
  sea_level: number
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
        fetchJsonWithRetry<any>(`${base}&product=currents&bin=1&begin_date=${begin}&end_date=${end}`, { retries: 1 }).catch(() => null),
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
      if (process.env.OWM_API_KEY) {
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
      const appid = process.env.OWM_API_KEY!
      // Geocode city to coords (cache 24h since geocoding is stable)
      const geoKey = `owm:geo:${location.toLowerCase()}`
      let first = await cacheStore.get<any>(geoKey)
      if (!first) {
        const geo = await fetchJsonWithRetry<any>(
          `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${appid}`,
          { retries: 2, providerId: 'owm' }
        )
        first = Array.isArray(geo) ? geo[0] : null
        if (first) await cacheStore.set(geoKey, first, 24 * 60 * 60 * 1000)
      }
      if (!first?.lat || !first?.lon) return null

      // One Call 3.0 current data (cache for 15 minutes)
      const oneCallUrl = `https://api.openweathermap.org/data/3.0/onecall?lat=${first.lat}&lon=${first.lon}&exclude=minutely,hourly,daily,alerts&units=metric&appid=${appid}`
      const ocKey = `owm:onecall:${first.lat.toFixed(3)},${first.lon.toFixed(3)}`
      let oneCall = await cacheStore.get<any>(ocKey)
      if (!oneCall) {
        oneCall = await fetchJsonWithRetry<any>(oneCallUrl, { retries: 2, providerId: 'owm' })
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

export async function collectWaterLevelDataBatch(limit: number = 25): Promise<WaterLevelData[]> {
  const out: WaterLevelData[] = []
  const stations = await fetchJsonWithRetry<any>(
    'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels',
    { retries: 2, etagKey: 'noaa:stations:waterlevels', providerId: 'noaa' }
  )
  const list = (stations as any)?.__notModified ? [] : (stations?.stations || [])
  const total = list.length
  const startIndex = (await cursorStore.get('noaa')) as number | null
  let i = typeof startIndex === 'number' ? startIndex : 0
  for (let count = 0; count < limit && count < total; count++) {
    const s = list[i % total]
    try {
      // Country toggle enforcement for NOAA station batch
      try {
        const plat = Number((s as any).lat)
        const plon = Number((s as any).lon ?? (s as any).lng)
        if (Number.isFinite(plat) && Number.isFinite(plon)) {
          const { getNearestOwmCountry } = await import('./repositories')
          const { isCountryAllowed } = await import('./country-controls')
          const cc = await getNearestOwmCountry(plat, plon)
          if (!isCountryAllowed('noaa' as any, cc)) { i++; continue }
        }
      } catch {}
      const stationId = s.id
      const stationLatN = Number((s as any).lat)
      const stationLonN = Number((s as any).lng ?? (s as any).lon)
      const stationLat: number | undefined = Number.isFinite(stationLatN) ? stationLatN : undefined
      const stationLon: number | undefined = Number.isFinite(stationLonN) ? stationLonN : undefined

      const begin = new Date().toISOString().slice(0, 10)
      const end = begin
      const base = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${stationId}&time_zone=gmt&units=metric&format=json`

      // Fetch core water level plus optional products in parallel
      const [waterData, tempData, windData, tidePred, salinityData, doData, turbidityData, currentsData] = await Promise.all([
        fetchJsonWithRetry<any>(`${base}&product=water_level&datum=MLLW&begin_date=${begin}&end_date=${end}`, { retries: 2, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=water_temperature&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=wind&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=predictions&interval=h&datum=MLLW&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=salinity&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=dissolved_oxygen&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=turbidity&begin_date=${begin}&end_date=${end}`, { retries: 1, providerId: 'noaa' }).catch(() => null),
        fetchJsonWithRetry<any>(`${base}&product=currents&bin=1&begin_date=${begin}&end_date=${end}`, { retries: 1 }).catch(() => null),
      ])

      const latest = (arr?: any[]) => (Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null)

      const wl = latest(waterData?.data)
      if (!wl) { i++; continue }

      const water_level_val = parseFloat(wl.v) || 0

      // Optional extractions
      const wt = latest(tempData?.data)
      const wind = latest(windData?.data)
      const pred = latest(tidePred?.predictions)
      const sal = latest(salinityData?.data)
      const disox = latest(doData?.data)
      const turb = latest(turbidityData?.data)

      const item: WaterLevelData = {
        river_level: water_level_val,
        sea_level: water_level_val,
        location: s.name,
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

      // Enrich with NDBC wave height if coordinates available (async, don't block)
      if (stationLat != null && stationLon != null) {
        // Wave height fetch is optional and can be slow, so we'll skip it in batch mode for performance
        // Individual fetches via fetchNOAAWaterData will still include it
      }

      const key = `noaa:water:${item.station_id}:${item.timestamp}`
      if (await dedupeStore.add(key)) out.push(item)
      await new Promise(r => setTimeout(r, 250))
    } catch {
      // skip station on failure
    }
    i++
  }
  await cursorStore.set('noaa', i % (total || 1))
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
  const data = await fetchJsonWithRetry<any>(url, { retries: 2 })
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
