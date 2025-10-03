import { workerQueue } from './worker-queue'
import { BSVTransactionData } from './bsv-transaction-service'
import { bsvConfig } from './bsv-config'
import {
  collectAirQualityDataBatch,
  collectSeismicDataBatch,
  collectWaterLevelDataBatch,
} from './data-collector'
import { TOP_100_CITIES } from './city-seeds'
import { dedupeStore } from './stores'
import { fetchJsonWithRetry } from './provider-fetch'
import { insertAdvanced, insertAirQuality, insertWaterLevel, insertSeismic, calculateSourceHash, getOwmStationsPage, getStationsByProviderPage, readCursor, writeCursor } from './repositories'
import { providerConfigs } from './provider-registry'
import { cursorStore } from './stores'

export interface WorkerStats {
  workerId: string
  isRunning: boolean
  lastRun: number
  nextRun: number
  totalRuns: number
  totalTransactions: number
  errors: number
  averageProcessingTime: number
}

export interface EnvironmentalData {
  type: 'air-quality' | 'weather' | 'seismic' | 'water-level' | 'advanced'
  timestamp: number
  location: string
  measurement: any
  source: string
  priority: 'high' | 'normal'
  eventId?: string
  coordinates?: { lat: number; lon: number }
  stationId?: string
}

export abstract class BaseWorker {
  protected workerId: string
  protected isRunning = false
  protected interval: NodeJS.Timeout | null = null
  protected stats = {
    totalRuns: 0,
    totalTransactions: 0,
    errors: 0,
    processingTimes: [] as number[],
    lastRunTime: 0
  }

  constructor(workerId: string) {
    this.workerId = workerId
  }

  public start(): void {
    if (this.isRunning) return
    
    this.isRunning = true
    console.log(`🚀 Starting ${this.workerId} worker`)
    
    // Start immediately, subsequent runs are scheduled dynamically
    this.run()
  }

  public stop(): void {
    if (this.interval) { clearTimeout(this.interval); this.interval = null }
    this.isRunning = false
    console.log(`🛑 Stopped ${this.workerId} worker`)
  }

  public getStats(): WorkerStats {
    const averageProcessingTime = this.stats.processingTimes.length > 0
      ? this.stats.processingTimes.reduce((sum, time) => sum + time, 0) / this.stats.processingTimes.length
      : 0

    const lastRun = this.stats.totalRuns > 0 ? this.stats.lastRunTime : 0
    const nextRun = lastRun > 0 ? lastRun + this.getIntervalMs() : Date.now() + this.getIntervalMs()

    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      lastRun,
      nextRun,
      totalRuns: this.stats.totalRuns,
      totalTransactions: this.stats.totalTransactions,
      errors: this.stats.errors,
      averageProcessingTime
    }
  }

  protected abstract getIntervalMs(): number
  protected abstract collectData(): Promise<EnvironmentalData[]>

  private async run(): Promise<void> {
    const startTime = Date.now()
    
    try {
      console.log(`📡 ${this.workerId}: Collecting environmental data...`)
      
      const data = await this.collectData()
      
      for (const item of data) {
        const idempotencyKey = (item.type === 'seismic' && item.eventId)
          ? `seismic:${item.eventId}`
          : `${item.type}:${item.source}:${item.location}:${item.timestamp}`
        const isNew = await dedupeStore.add(idempotencyKey)
        if (!isNew) {
          continue
        }

        // Persist a DB row first with a unified, canonical source_hash per stream
        let unifiedHash: string
        const collectedAt = new Date(item.timestamp)
        try {
          if (item.type === 'air-quality') {
            const envelope = { type: 'air_quality', aq: { ...item.measurement, location: item.location, timestamp: new Date(item.timestamp).toISOString(), source: item.source } }
            unifiedHash = calculateSourceHash(envelope)
            // WAQI sometimes returns '-' for pollutants; coerce to nulls
            const { toNumberOrNull } = await import('./utils')
            await insertAirQuality({
              provider: item.source,
              station_code: (item as any)?.station_id != null ? String((item as any).station_id) : null,
              city: item.location,
              lat: (item as any)?.coordinates?.lat ?? null,
              lon: (item as any)?.coordinates?.lon ?? null,
              aqi: toNumberOrNull(item.measurement?.aqi),
              pm25: toNumberOrNull(item.measurement?.pm25),
              pm10: toNumberOrNull(item.measurement?.pm10),
              co: toNumberOrNull(item.measurement?.co),
              no2: toNumberOrNull(item.measurement?.no2),
              o3: toNumberOrNull(item.measurement?.o3),
              so2: toNumberOrNull((item.measurement as any)?.so2),
              temperature_c: toNumberOrNull((item.measurement as any)?.temperature ?? (item.measurement as any)?.temperature_c),
              humidity_pct: toNumberOrNull((item.measurement as any)?.humidity ?? (item.measurement as any)?.humidity_pct),
              pressure_mb: toNumberOrNull((item.measurement as any)?.pressure ?? (item.measurement as any)?.pressure_mb),
              wind_kph: toNumberOrNull((item.measurement as any)?.windSpeed ?? (item.measurement as any)?.wind_kph),
              wind_deg: toNumberOrNull((item.measurement as any)?.windDirection ?? (item.measurement as any)?.wind_deg),
              source: item.source,
              source_hash: unifiedHash,
              collected_at: collectedAt,
            })
          } else if (item.type === 'water-level') {
            const envelope = { type: 'water_levels', w: { ...item.measurement, location: item.location, timestamp: new Date(item.timestamp).toISOString(), source: item.source } }
            unifiedHash = calculateSourceHash(envelope)
            await insertWaterLevel({
              provider: item.source,
              station_code: String((item as any)?.stationId ?? (item.measurement as any)?.station_id ?? '' ) || null,
              location: item.location ?? null,
              lat: (item as any)?.coordinates?.lat ?? null,
              lon: (item as any)?.coordinates?.lon ?? null,
              level_m: (item.measurement as any)?.sea_level ?? null,
              tide_height_m: (item.measurement as any)?.tide_height ?? null,
              wave_height_m: (item.measurement as any)?.wave_height_m ?? null,
              salinity_psu: (item.measurement as any)?.salinity_psu ?? null,
              dissolved_oxygen_mg_l: (item.measurement as any)?.dissolved_oxygen_mg_l ?? null,
              turbidity_ntu: (item.measurement as any)?.turbidity_ntu ?? null,
              current_speed_ms: (item.measurement as any)?.current_speed_ms ?? null,
              current_direction_deg: (item.measurement as any)?.current_direction_deg ?? null,
              wind_kph: (item.measurement as any)?.wind_kph ?? null,
              wind_deg: (item.measurement as any)?.wind_deg ?? null,
              source: item.source,
              source_hash: unifiedHash,
              collected_at: collectedAt,
            })
          } else if (item.type === 'seismic') {
            const envelope = { type: 'seismic', s: { magnitude: (item.measurement as any)?.magnitude, depth: (item.measurement as any)?.depth, location: item.location, coordinates: { lat: (item.measurement as any)?.latitude, lon: (item.measurement as any)?.longitude }, timestamp: new Date(item.timestamp).toISOString(), source: item.source, event_id: item.eventId } }
            unifiedHash = calculateSourceHash(envelope)
            await insertSeismic({
              provider: item.source,
              event_id: item.eventId ?? null,
              location: item.location,
              magnitude: (item.measurement as any)?.magnitude ?? null,
              depth_km: (item.measurement as any)?.depth ?? null,
              lat: (item.measurement as any)?.latitude ?? null,
              lon: (item.measurement as any)?.longitude ?? null,
              source_hash: unifiedHash,
              collected_at: collectedAt,
            })
          } else if (item.type === 'advanced') {
            // Already persisted in AdvancedMetricsWorker with calculateSourceHash; mirror that envelope
            const envelope = { type: 'advanced', a: { ...item.measurement, location: item.location, timestamp: new Date(item.timestamp).toISOString(), source: item.source } }
            unifiedHash = calculateSourceHash(envelope)
          } else {
            unifiedHash = this.generateSourceHash(item)
          }
        } catch (persistErr) {
          // If persistence fails, still proceed with queueing using fallback hash to avoid data loss
          unifiedHash = this.generateSourceHash(item)
          console.error('Persistence error before enqueue:', persistErr)
        }

        const bsvData: BSVTransactionData = {
          type: item.type,
          timestamp: item.timestamp,
          location: item.location,
          measurement: item.measurement,
          source_hash: unifiedHash
        }

        const queueId = workerQueue.addToQueue(bsvData, item.priority)
        this.stats.totalTransactions++
        if (bsvConfig.logging.level === 'debug') {
          console.log(`📥 ${this.workerId}: Queued ${item.type} data (${item.priority} priority): ${queueId}`)
        }
      }

      this.stats.totalRuns++
      this.stats.lastRunTime = Date.now()
      const processingTime = Date.now() - startTime
      this.stats.processingTimes.push(processingTime)
      
      // Keep only last 100 processing times for average calculation
      if (this.stats.processingTimes.length > 100) {
        this.stats.processingTimes.shift()
      }

      if (bsvConfig.logging.level !== 'error') {
        console.log(`✅ ${this.workerId}: Processed ${data.length} data points in ${processingTime}ms`)
      }

    } catch (error) {
      this.stats.errors++
      console.error(`❌ ${this.workerId}: Error collecting data:`, error)
    }

    // Schedule next run dynamically based on current interval
    if (this.isRunning) {
      if (this.interval) { clearTimeout(this.interval); this.interval = null }
      this.interval = setTimeout(() => this.run(), this.getIntervalMs())
    }
  }

  private generateSourceHash(data: EnvironmentalData): string {
    // Stable hash: type + canonical JSON(measurement) + rounded timestamp(ISO minute) + location
    const rounded = new Date(Math.floor((data.timestamp) / 60000) * 60000).toISOString()
    const canonical = JSON.stringify(data.measurement, Object.keys(data.measurement).sort())
    const sourceString = `${data.type}|${rounded}|${data.location}|${canonical}`
    return Buffer.from(sourceString).toString('base64').substring(0, 32)
  }
}

// Worker 1: WAQI + Environmental APIs
export class WAQIEnvironmentalWorker extends BaseWorker {
  constructor() {
    super('WAQI-Environmental')
  }

  protected getIntervalMs(): number {
    const envMs = Number(process.env.WAQI_WORKER_INTERVAL_MS)
    return Number.isFinite(envMs) && envMs > 0 ? envMs : 30 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const data: EnvironmentalData[] = []
    try {
      // Ensure WAQI station index is being discovered and persisted
      try { const { ensureWaqiStationIndex } = await import('./data-collector'); await ensureWaqiStationIndex(5) } catch {}
      // Iterate WAQI stations by allowed countries using persisted registry
      const allow = (providerConfigs as any)?.waqi?.countries?.allow || []
      const countries = Array.isArray(allow) && allow.length > 0 ? allow : undefined
      const key = 'stations'
      const offset = await readCursor('waqi', countries && countries.length === 1 ? countries[0] : null, key)
      const pageSize = Number(process.env.WAQI_STATION_PAGE_SIZE || 150)
      const stations = await getStationsByProviderPage({ provider: 'waqi', countries, offset, limit: pageSize })
      const nextOffset = stations.length ? offset + stations.length : 0
      await writeCursor('waqi', countries && countries.length === 1 ? countries[0] : null, key, nextOffset)

      const items: any[] = []
      if (stations.length && process.env.WAQI_API_KEY) {
        for (const s of stations) {
          try {
            const url = `https://api.waqi.info/feed/@${encodeURIComponent(s.station_code)}/?token=${process.env.WAQI_API_KEY}`
            const d = await fetchJsonWithRetry<any>(url, { retries: 1, providerId: 'waqi' })
            if (d?.status === 'ok') {
              items.push({
                aqi: d.data?.aqi,
                pm25: d.data?.iaqi?.pm25?.['v'] || 0,
                pm10: d.data?.iaqi?.pm10?.['v'] || 0,
                co: d.data?.iaqi?.co?.['v'] || 0,
                no2: d.data?.iaqi?.no2?.['v'] || 0,
                o3: d.data?.iaqi?.o3?.['v'] || 0,
                so2: d.data?.iaqi?.so2?.['v'] || 0,
                location: d.data?.city?.name || s.name || `@${s.station_code}`,
                timestamp: d.data?.time?.iso || new Date().toISOString(),
                source: 'WAQI',
                coordinates: (typeof s.lat === 'number' && typeof s.lon === 'number') ? { lat: s.lat, lon: s.lon } : undefined,
                station_id: s.station_code,
                temperature: d.data?.iaqi?.t?.['v'] ?? d.data?.iaqi?.temp?.['v'],
                humidity: d.data?.iaqi?.h?.['v'],
                pressure: d.data?.iaqi?.p?.['v'],
              })
            }
        } catch {}
        }
      }

      let aqItems = items
      if (aqItems.length === 0) {
        // Fallback to WeatherAPI using OWM station names by allowed countries
        const waAllow = (providerConfigs as any)?.weatherapi?.countries?.allow || []
        const waCountries = Array.isArray(waAllow) && waAllow.length > 0 ? waAllow : undefined
        const cityKey = 'owm_cities'
        const cityOffset = await readCursor('weatherapi', waCountries && waCountries.length === 1 ? waCountries[0] : null, cityKey)
        const cityPageSize = 100
        const owmCities = await getOwmStationsPage({ countries: waCountries, offset: cityOffset, limit: cityPageSize })
        const nextCityOffset = owmCities.length ? cityOffset + owmCities.length : 0
        await writeCursor('weatherapi', waCountries && waCountries.length === 1 ? waCountries[0] : null, cityKey, nextCityOffset)
        const cities = owmCities.length ? owmCities.map(c => c.name || c.station_code) : TOP_100_CITIES
        const batch = await collectAirQualityDataBatch(cities, false)
        aqItems = batch as any
      }
      for (const item of aqItems) {
        const measurement = {
          aqi: item.aqi,
          pm25: item.pm25,
          pm10: item.pm10,
          co: item.co,
          no2: item.no2,
          o3: item.o3,
          source: item.source,
        }
        data.push({
          type: 'air-quality',
          timestamp: Date.parse(item.timestamp) || Date.now(),
          location: item.location,
          measurement,
          source: item.source,
          priority: 'normal',
          coordinates: (item as any)?.coordinates,
          stationId: (item as any)?.station_id,
        })
      }
    } catch (error) {
      console.error('Error fetching WAQI/Environmental data:', error)
    }
    return data
  }
}

// Worker 2: NOAA Weather API
export class NOAAWorker extends BaseWorker {
  constructor() {
    super('NOAA-Weather')
  }

  protected getIntervalMs(): number {
    const envMs = Number(process.env.NOAA_WORKER_INTERVAL_MS)
    return Number.isFinite(envMs) && envMs > 0 ? envMs : 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const data: EnvironmentalData[] = []
    try {
      // One-off verification: run 50-station sample once after startup, then revert to 150
      const flagKey = '__NOAA_ONEOFF_DONE__'
      const done = (global as any)[flagKey] === true
      const limit = done ? 150 : 50
      const batch = await collectWaterLevelDataBatch(limit)
      if (!done) (global as any)[flagKey] = true
      for (const item of batch) {
        const measurement = {
          river_level: item.river_level,
          sea_level: item.sea_level,
          station_id: item.station_id,
        }
        data.push({
          type: 'water-level',
          timestamp: Date.parse(item.timestamp) || Date.now(),
          location: item.location,
          measurement,
          source: item.source,
          priority: 'normal',
        })
      }
    } catch (error) {
      console.error('Error fetching NOAA data:', error)
    }
    return data
  }
}

// Worker 3: USGS Seismic API
export class USGSWorker extends BaseWorker {
  constructor() {
    super('USGS-Seismic')
  }

  protected getIntervalMs(): number {
    // Event-triggered burst: if last run detected significant event, shorten temporarily
    const burstUntil = (global as any).__USGS_BURST_UNTIL__ as number | undefined
    if (burstUntil && Date.now() < burstUntil) {
      return 5 * 60 * 1000 // 5 minutes during burst
    }
    const envMs = Number(process.env.USGS_WORKER_INTERVAL_MS)
    const base = Number.isFinite(envMs) && envMs > 0 ? envMs : 15 * 60 * 1000
    return base
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectSeismicDataBatch(6, 2.5)
      for (const item of batch) {
        const measurement = {
          magnitude: item.magnitude,
          depth: item.depth,
          latitude: item.coordinates.lat,
          longitude: item.coordinates.lon,
        }
        data.push({
          type: 'seismic',
          timestamp: Date.parse(item.timestamp) || Date.now(),
          location: item.location,
          measurement,
          source: item.source,
          priority: item.magnitude >= 4 ? 'high' : 'normal',
          eventId: item.event_id,
        })
      }

      // If any significant events, enable burst for 60 minutes
      if (batch.some(b => (b.magnitude || 0) >= 4)) {
        ;(global as any).__USGS_BURST_UNTIL__ = Date.now() + 60 * 60 * 1000
      }
    } catch (error) {
      console.error('Error fetching USGS data:', error)
    }
    return data
  }
}

// Worker 4: Advanced Metrics (WeatherAPI primary, OWM fallback)
export class AdvancedMetricsWorker extends BaseWorker {
  constructor() {
    super('Advanced-Metrics')
  }

  protected getIntervalMs(): number {
    const envMs = Number(process.env.ADVANCED_WORKER_INTERVAL_MS)
    return Number.isFinite(envMs) && envMs > 0 ? envMs : 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const items: EnvironmentalData[] = []
    try {
      // Pull OWM stations by allowed countries (if configured), rotate with cursor
      const allow = providerConfigs.weatherapi?.countries?.allow || []
      const countries = Array.isArray(allow) && allow.length > 0 ? allow : undefined
      const key = 'owm_cities'
      const offset = await readCursor('weatherapi', countries && countries.length === 1 ? countries[0] : null, key)
      const pageSize = Number(process.env.ADVANCED_METRICS_PAGE_SIZE || 100)
      const stations = await getOwmStationsPage({ countries, offset, limit: pageSize })
      const nextOffset = stations.length ? offset + stations.length : 0
      await writeCursor('weatherapi', countries && countries.length === 1 ? countries[0] : null, key, nextOffset)
      // Prefer precise lat,lon queries to avoid WeatherAPI 400s from ambiguous names
      const rawQueries = stations.length
        ? stations.map(s => (typeof (s as any).lat === 'number' && typeof (s as any).lon === 'number')
            ? `${(s as any).lat},${(s as any).lon}`
            : ((s as any).name || (s as any).station_code))
        : ['51.5074,-0.1278']
      const cities = rawQueries.filter(q => typeof q === 'string' && q.trim().length >= 2)

      for (const city of cities) {
        const data = await this.fetchAdvancedForCity(city!)
        if (data) {
          // Persist to DB
          try {
            await insertAdvanced({
              provider: data.source,
              city: data.location,
              lat: data.coordinates?.lat ?? null,
              lon: data.coordinates?.lon ?? null,
              uv_index: data.uv_index,
              soil_moisture_pct: Math.round((data.soil_moisture ?? 0) * 100),
              wildfire_risk: data.wildfire_risk,
              environmental_score: Math.round((data.environmental_quality_score ?? 0) * 100),
              temperature_c: data.temperature_c ?? null,
              humidity_pct: data.humidity_pct ?? null,
              pressure_mb: data.pressure_mb ?? null,
              wind_kph: data.wind_kph ?? null,
              wind_deg: data.wind_deg ?? null,
              source_hash: Buffer.from(JSON.stringify({ type: 'advanced', data })).toString('base64').slice(0, 64),
              collected_at: new Date(data.timestamp),
            })
          } catch (e) {
            console.error('insertAdvanced error:', e)
          }
          items.push({
            type: 'advanced',
            timestamp: Date.parse(data.timestamp) || Date.now(),
            location: data.location,
            measurement: {
              uv_index: data.uv_index,
              soil_moisture: data.soil_moisture,
              wildfire_risk: data.wildfire_risk,
              environmental_quality_score: data.environmental_quality_score,
              temperature_c: data.temperature_c,
              humidity_pct: data.humidity_pct,
              pressure_mb: data.pressure_mb,
              wind_kph: data.wind_kph,
              wind_deg: data.wind_deg,
            },
            source: data.source,
            priority: 'normal',
          })
        }
      }
    } catch (e) {
      console.error('Error fetching Advanced metrics:', e)
    }
    return items
  }

  private async fetchAdvancedForCity(city: string): Promise<any | null> {
    if (!city || typeof city !== 'string' || city.trim().length < 2) return null
    // WeatherAPI primary
    try {
      if (process.env.WEATHERAPI_KEY) {
        const url = `https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHERAPI_KEY}&q=${encodeURIComponent(city)}&aqi=no`
        const data = await fetchJsonWithRetry<any>(url, { retries: 2, providerId: 'weatherapi' })
        const uv = data.current?.uv ?? 0
        const humidity = data.current?.humidity ?? 0
        const windKph = data.current?.wind_kph ?? 0
        const soil = Math.max(0, Math.min(1, humidity / 100))
        const wildfire = Math.max(1, Math.min(10, Math.round(uv + windKph / 10 - humidity / 20)))
        const eqs = this.calcEQS(uv, soil, wildfire)
        return {
          uv_index: uv,
          soil_moisture: soil,
          wildfire_risk: wildfire,
          environmental_quality_score: eqs,
          location: data.location?.name || city,
          timestamp: (typeof data?.current?.last_updated === 'string' && data.current?.last_updated)
            ? new Date(data.current.last_updated).toISOString() : new Date().toISOString(),
          source: 'WeatherAPI-derived metrics',
          temperature_c: data.current?.temp_c ?? undefined,
          humidity_pct: data.current?.humidity ?? undefined,
          pressure_mb: data.current?.pressure_mb ?? undefined,
          wind_kph: data.current?.wind_kph ?? undefined,
          wind_deg: data.current?.wind_degree ?? undefined,
          coordinates: (typeof data?.location?.lat === 'number' && typeof data?.location?.lon === 'number')
            ? { lat: data.location.lat, lon: data.location.lon } : undefined,
        }
      }
    } catch (e) {
      console.error('WeatherAPI advanced fetch error:', e)
    }
    // OWM fallback (15‑min cache handled inside provider)
    try {
      if (process.env.OWM_API_KEY) {
        // Geocode
        const geo = await fetchJsonWithRetry<any>(
          `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${process.env.OWM_API_KEY}`,
          { retries: 2, providerId: 'owm' }
        )
        const first = Array.isArray(geo) ? geo[0] : null
        if (!first?.lat || !first?.lon) return null
        const oc = await fetchJsonWithRetry<any>(
          `https://api.openweathermap.org/data/3.0/onecall?lat=${first.lat}&lon=${first.lon}&exclude=minutely,hourly,daily,alerts&units=metric&appid=${process.env.OWM_API_KEY}`,
          { retries: 2, providerId: 'owm' }
        )
        const curr = oc?.current || {}
        const humidity = curr.humidity ?? 0
        const windKph = curr.wind_speed != null ? Number(curr.wind_speed) * 3.6 : 0
        const uv = curr.uvi ?? 0
        const soil = Math.max(0, Math.min(1, humidity / 100))
        const wildfire = Math.max(1, Math.min(10, Math.round(uv + windKph / 10 - humidity / 20)))
        const eqs = this.calcEQS(uv, soil, wildfire)
        const ts = typeof curr.dt === 'number' ? new Date(curr.dt * 1000).toISOString() : new Date().toISOString()
        return {
          uv_index: uv,
          soil_moisture: soil,
          wildfire_risk: wildfire,
          environmental_quality_score: eqs,
          location: city,
          timestamp: ts,
          source: 'OWM-derived metrics',
        }
      }
    } catch (e) {
      console.error('OWM advanced fetch error:', e)
    }
    return null
  }

  private calcEQS(uv: number, soil: number, wildfire: number): number {
    // Simple EQS calculation (example):
    // UV Index: 0-2 (Low), 3-5 (Moderate), 6-7 (High), 8+ (Very High)
    // Soil Moisture: 0-1 (Dry to Wet)
    // Wildfire Risk: 1-10 (Low to Extreme)
    // Example weights: UV (0.3), Soil (0.2), Wildfire (0.5)
    const uvWeight = 0.3
    const soilWeight = 0.2
    const wildfireWeight = 0.5

    const uvScore = uv > 0 ? Math.min(1, uv / 8) * uvWeight : 0
    const soilScore = soil * soilWeight
    const wildfireScore = wildfire * wildfireWeight

    return Math.min(1, uvScore + soilScore + wildfireScore)
  }
}

// Worker Manager
export class WorkerManager {
  private workers: Map<string, BaseWorker> = new Map()
  private isInitialized = false

  constructor() {
    this.initialize()
  }

  private initialize(): void {
    try {
      const waqiWorker = new WAQIEnvironmentalWorker()
      const noaaWorker = new NOAAWorker()
      const usgsWorker = new USGSWorker()
      const advWorker = new AdvancedMetricsWorker()

      this.workers.set('waqi-environmental', waqiWorker)
      this.workers.set('noaa-weather', noaaWorker)
      this.workers.set('usgs-seismic', usgsWorker)
      this.workers.set('advanced-metrics', advWorker)

      this.isInitialized = true
      try { console.log('✅ Worker Manager initialized with 4 workers') } catch {}
    } catch (error) {
      console.error('❌ Failed to initialize Worker Manager:', error)
      this.isInitialized = false
    }
  }

  public startAll(): void {
    if (!this.isInitialized) {
      console.error('Worker Manager not initialized')
      return
    }
    console.log('🚀 Starting all worker threads...')
    this.workers.forEach((worker) => { worker.start() })
  }

  public stopAll(): void {
    console.log('🛑 Stopping all worker threads...')
    this.workers.forEach((worker) => { worker.stop() })
  }

  public getWorkerStats(): WorkerStats[] {
    return Array.from(this.workers.values()).map(worker => worker.getStats())
  }

  public getWorker(workerId: string): BaseWorker | undefined {
    return this.workers.get(workerId)
  }

  public isReady(): boolean {
    return this.isInitialized
  }

  public forceInitialize(): void {
    this.initialize()
  }
}

// Export singleton instance
export const workerManager = new WorkerManager()