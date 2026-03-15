import { workerQueue } from './worker-queue'
import { BSVTransactionData } from './bsv-transaction-service'
import { bsvConfig } from './bsv-config'
import {
  collectAirQualityDataBatch,
  collectEMSCLatestEvents,
  collectNdbcLatestObservations,
  collectSeismicDataBatch,
  collectSensorCommunityDataBatch,
  collectWaterLevelDataBatch,
} from './data-collector'
import { TOP_100_CITIES } from './city-seeds'
import { dedupeStore } from './stores'
import { fetchJsonWithRetry } from './provider-fetch'
import { insertAdvanced, insertAirQuality, insertWaterLevel, insertSeismic, calculateSourceHash, getOwmStationsPage, getStationsByProviderPage, readCursor, writeCursor, hasAirQualityTxId, hasWaterLevelTxId, hasSeismicTxId, hasSeismicEventTxId, hasAdvancedTxId, getSeismicByEventId } from './repositories'
import { datasetConfigs, providerConfigs } from './provider-registry'
import { cursorStore } from './stores'
import { blockchainService } from './blockchain'
import { DataFamily, DatasetId, mapWorkerTypeToFamily, ProviderId, QueueLane, resolveProviderIdFromSource, resolveSourceLabel } from './stream-registry'
import { throughputObservability } from './throughput-observability'

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
  type: 'air-quality' | 'weather' | 'seismic' | 'water-level' | 'advanced' | 'geomagnetism' | 'volcanic' | 'space-weather' | 'upper-atmosphere'
  timestamp: number
  location: string
  measurement: any
  source: string
  priority: 'high' | 'normal'
  family?: DataFamily
  providerId?: ProviderId
  datasetId?: DatasetId
  queueLane?: QueueLane
  maxInFlight?: number
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

  private recordCollectionBatch(data: EnvironmentalData[]): void {
    if (!Array.isArray(data) || data.length === 0) return
    const grouped = new Map<string, { family: DataFamily; providerId?: ProviderId; datasetId?: DatasetId; queueLane?: QueueLane; count: number }>()
    for (const item of data) {
      const family = item.family || mapWorkerTypeToFamily(item.type)
      const providerId = item.providerId || resolveProviderIdFromSource(item.source) || undefined
      const datasetId = item.datasetId
      const queueLane = item.queueLane
      const key = [family, providerId || 'unknown', datasetId || '-', queueLane || 'unknown'].join('|')
      const existing = grouped.get(key)
      if (existing) {
        existing.count += 1
      } else {
        grouped.set(key, { family, providerId, datasetId, queueLane, count: 1 })
      }
    }
    for (const entry of grouped.values()) {
      throughputObservability.recordProviderBatch({
        family: entry.family,
        providerId: entry.providerId,
        datasetId: entry.datasetId,
        queueLane: entry.queueLane,
      }, entry.count, 1)
    }
  }

  protected abstract getIntervalMs(): number
  protected abstract collectData(): Promise<EnvironmentalData[]>

  private async run(): Promise<void> {
    const startTime = Date.now()
    const cycleStats = {
      submitted: 0,
      queued: 0,
      duplicateDropped: 0,
      alreadyOnChainDropped: 0,
      backpressured: 0,
    }
    const metaForItem = (item: EnvironmentalData) => ({
      family: item.family || mapWorkerTypeToFamily(item.type),
      providerId: item.providerId || resolveProviderIdFromSource(item.source) || undefined,
      datasetId: item.datasetId,
      queueLane: item.queueLane,
    })
    
    try {
      console.log(`📡 ${this.workerId}: Collecting environmental data...`)
      
      const data = await this.collectData()
      this.recordCollectionBatch(data)
      
      for (const item of data) {
        const itemMeta = metaForItem(item)
        const idempotencyKey = (item.type === 'seismic' && item.eventId)
          ? `seismic:${item.eventId}`
          : `${item.type}:${item.source}:${item.location}:${item.timestamp}`
        const isNew = await dedupeStore.add(idempotencyKey)
        if (!isNew) {
          cycleStats.duplicateDropped++
          throughputObservability.recordDuplicateDropped(itemMeta)
          continue
        }

        // Persist a DB row first with a unified, canonical source_hash per stream
        let unifiedHash: string
        const collectedAt = new Date(item.timestamp)
        try {
          if (item.type === 'air-quality') {
            const envelope = { type: 'air_quality', aq: { ...item.measurement, location: item.location, timestamp: new Date(item.timestamp).toISOString(), source: item.source } }
            unifiedHash = calculateSourceHash(envelope)
            if (process.env.GAIALOG_NO_DB !== 'true') {
              // Skip if already on-chain
              try {
                if (await hasAirQualityTxId(unifiedHash)) {
                  cycleStats.alreadyOnChainDropped++
                  throughputObservability.recordAlreadyOnChainDropped(itemMeta)
                  if (bsvConfig.logging.level === 'debug') {
                    console.log(`⏭️  Skipping air-quality - already on-chain (${unifiedHash.slice(0, 12)}...)`)
                  }
                  continue
                }
              } catch {}
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
            }
          } else if (item.type === 'water-level') {
            const envelope = { type: 'water_levels', w: { ...item.measurement, location: item.location, timestamp: new Date(item.timestamp).toISOString(), source: item.source } }
            unifiedHash = calculateSourceHash(envelope)
            if (process.env.GAIALOG_NO_DB !== 'true') {
              // Skip if already on-chain
              try {
                if (await hasWaterLevelTxId(unifiedHash)) {
                  cycleStats.alreadyOnChainDropped++
                  throughputObservability.recordAlreadyOnChainDropped(itemMeta)
                  if (bsvConfig.logging.level === 'debug') {
                    console.log(`⏭️  Skipping water-level - already on-chain (${unifiedHash.slice(0, 12)}...)`)
                  }
                  continue
                }
              } catch {}
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
            }
          } else if (item.type === 'seismic') {
            const envelope = { type: 'seismic', s: { magnitude: (item.measurement as any)?.magnitude, depth: (item.measurement as any)?.depth, location: item.location, coordinates: { lat: (item.measurement as any)?.latitude, lon: (item.measurement as any)?.longitude }, timestamp: new Date(item.timestamp).toISOString(), source: item.source, event_id: item.eventId } }
            unifiedHash = calculateSourceHash(envelope)
            if (process.env.GAIALOG_NO_DB !== 'true') {
              // Skip if this event_id or hash is already on-chain/persisted
              try {
                const alreadyByHash = await hasSeismicTxId(unifiedHash)
                const alreadyByEvent = item.eventId ? await hasSeismicEventTxId(item.eventId) : false
                if (alreadyByHash || alreadyByEvent) {
                  cycleStats.alreadyOnChainDropped++
                  throughputObservability.recordAlreadyOnChainDropped(itemMeta)
                  if (bsvConfig.logging.level === 'debug') {
                    console.log(`⏭️  Skipping seismic ${item.eventId || 'unknown'} - already on-chain`)
                  }
                  continue
                }
              } catch {}
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
            }
          } else if (item.type === 'advanced') {
            // Already persisted in AdvancedMetricsWorker with calculateSourceHash; mirror that envelope
            const envelope = { type: 'advanced', a: { ...item.measurement, location: item.location, timestamp: new Date(item.timestamp).toISOString(), source: item.source } }
            unifiedHash = calculateSourceHash(envelope)
            if (process.env.GAIALOG_NO_DB !== 'true') {
              // Skip if already on-chain
              try {
                if (await hasAdvancedTxId(unifiedHash)) {
                  cycleStats.alreadyOnChainDropped++
                  throughputObservability.recordAlreadyOnChainDropped(itemMeta)
                  if (bsvConfig.logging.level === 'debug') {
                    console.log(`⏭️  Skipping advanced-metrics - already on-chain (${unifiedHash.slice(0, 12)}...)`)
                  }
                  continue
                }
              } catch {}
            }
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
          source_hash: unifiedHash,
          family: item.family || mapWorkerTypeToFamily(item.type),
          providerId: item.providerId || resolveProviderIdFromSource(item.source) || undefined,
          datasetId: item.datasetId,
          sourceLabel: resolveSourceLabel(item.providerId, item.datasetId, item.source),
          queueLane: item.queueLane,
          maxInFlight: item.maxInFlight,
          coordinates: item.coordinates,
          stationId: item.stationId,
        }

        // Check if we should bypass queue for direct broadcasting
        const BYPASS_QUEUE = process.env.BSV_BYPASS_QUEUE === 'true'

        if (BYPASS_QUEUE) {
          // Direct broadcast - bypass queue to avoid Supabase bottleneck
          try {
            const stream = item.type === 'air-quality' ? 'air_quality' 
              : item.type === 'water-level' ? 'water_levels'
              : item.type === 'seismic' ? 'seismic_activity'
              : 'advanced_metrics'
            
            const txid = await blockchainService.writeToChain({
              stream,
              timestamp: item.timestamp,
              family: bsvData.family,
              providerId: bsvData.providerId,
              datasetId: bsvData.datasetId,
              queueLane: bsvData.queueLane,
              payload: {
                location: item.location,
                timestamp: new Date(item.timestamp).toISOString(),
                source: resolveSourceLabel(bsvData.providerId, bsvData.datasetId, item.source),
                provider_id: bsvData.providerId,
                dataset_id: bsvData.datasetId,
                family: bsvData.family,
                ...item.measurement,
                source_hash: unifiedHash
              }
            })
            
            if (bsvConfig.logging.level !== 'error') {
              console.log(`✅ ${this.workerId}: Direct broadcast ${item.type} - ${txid}`)
            }
            this.stats.totalTransactions++
            cycleStats.submitted++
          } catch (e) {
            const eMsg = e instanceof Error ? e.message : String(e)
            const isTransient = /MEMPOOL_CHAIN_LIMIT|No reservable UTXO|No UTXOs available|txn-mempool-conflict|DOUBLE_SPEND|HEAP_PRESSURE_BACKOFF/i.test(eMsg)
            // Reliability guard: never drop a reading on direct-broadcast failure.
            // Route to queue so retry/backoff/idempotency logic can recover safely.
            const queueId = workerQueue.addToQueue(bsvData, item.priority)
            if (queueId) {
              this.stats.totalTransactions++
              cycleStats.queued++
            } else {
              cycleStats.backpressured++
            }

            if (isTransient) {
              if (bsvConfig.logging.level !== 'error') {
                console.warn(queueId
                  ? `⏳ ${this.workerId}: direct broadcast transient failure, queued for retry (${queueId}) - ${eMsg.split('\n')[0].substring(0, 140)}`
                  : `⏸️ ${this.workerId}: direct broadcast transient failure but queue is backpressured for ${bsvData.datasetId || bsvData.providerId || 'source'}`
                )
              }
            } else {
              if (queueId) console.error(`❌ ${this.workerId}: Direct broadcast failed, queued for retry (${queueId}):`, e)
              else console.error(`❌ ${this.workerId}: Direct broadcast failed but queue is backpressured:`, e)
            }
          }
        } else {
          // Normal queue path (when Supabase is stable)
          const queueId = workerQueue.addToQueue(bsvData, item.priority)
          if (queueId) {
            this.stats.totalTransactions++
            cycleStats.queued++
          } else {
            cycleStats.backpressured++
          }
          if (queueId && bsvConfig.logging.level === 'debug') {
            console.log(`📥 ${this.workerId}: Queued ${item.type} data (${item.priority} priority): ${queueId}`)
          }
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
        console.log(
          `✅ ${this.workerId}: Processed ${data.length} data points in ${processingTime}ms ` +
          `(submitted=${cycleStats.submitted}, queued=${cycleStats.queued}, duplicate=${cycleStats.duplicateDropped}, ` +
          `already_on_chain=${cycleStats.alreadyOnChainDropped}, backpressured=${cycleStats.backpressured})`
        )
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
    const providerKey = data.providerId || resolveProviderIdFromSource(data.source) || 'unknown'
    const datasetKey = data.datasetId || 'default'
    const sourceString = `${data.type}|${providerKey}|${datasetKey}|${data.source}|${rounded}|${data.location}|${canonical}`
    return Buffer.from(sourceString).toString('base64').substring(0, 32)
  }
}

// Worker 1: WAQI + Environmental APIs
export class WAQIEnvironmentalWorker extends BaseWorker {
  constructor() {
    super('WAQI-Environmental')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.waqi_station_feed?.cadence.intervalMs || 30 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.waqi_station_feed
    if (!config?.enabled) return []
    const data: EnvironmentalData[] = []
    try {
      // Ensure WAQI station index is being discovered and persisted
      try {
        const { ensureWaqiStationIndex } = await import('./data-collector')
        // Use default (env-driven) tiles per cycle instead of hardcoded 5
        await ensureWaqiStationIndex()
      } catch (e) {
        console.log(`⚠️ WAQI: Station index discovery failed:`, (e as Error).message)
      }
      // If DB is disabled, skip DB querying entirely and use DB-less path
      const dbDisabled = process.env.GAIALOG_NO_DB === 'true'
      // Iterate WAQI stations by allowed countries using persisted registry (DB), when enabled
      const allow = (providerConfigs as any)?.waqi?.countries?.allow || []
      const countries = Array.isArray(allow) && allow.length > 0 ? allow : undefined
      const key = 'stations'
      let offset = 0
      let stations: any[] = []
      if (!dbDisabled) {
        try {
          offset = await readCursor('waqi', countries && countries.length === 1 ? countries[0] : null, key)
          const pageSize = Number(process.env.WAQI_STATION_PAGE_SIZE || 150)
          console.log(`📡 WAQI: Querying stations (provider=waqi, countries=${countries || 'ALL'}, offset=${offset}, limit=${pageSize})`)
          stations = await getStationsByProviderPage({ provider: 'waqi', countries, offset, limit: pageSize })
          console.log(`✅ WAQI: Found ${stations.length} stations from database`)
          
          // Auto-reset cursor if we've gone past the end
          let nextOffset: number
          if (stations.length === 0 && offset > 0) {
            console.log(`🔄 WAQI: Reached end of stations (offset=${offset}), resetting cursor to 0`)
            nextOffset = 0
          } else if (stations.length < pageSize && stations.length > 0) {
            // Partial page means we're near the end, wrap around
            console.log(`🔄 WAQI: Partial page (${stations.length}/${pageSize}), wrapping cursor to 0`)
            nextOffset = 0
          } else {
            nextOffset = offset + stations.length
          }
          
          await writeCursor('waqi', countries && countries.length === 1 ? countries[0] : null, key, nextOffset)
        } catch (e) {
          console.error(`❌ WAQI: Error fetching stations from database:`, e)
          stations = []
        }
      } else {
        console.log('🗄️ WAQI: Database disabled (GAIALOG_NO_DB=true); using DB-less station index')
      }

      const items: any[] = []
      if (stations.length && process.env.WAQI_API_KEY) {
        console.log(`🌐 WAQI: Fetching data from ${stations.length} stations via WAQI API...`)
        let successCount = 0
        let errorCount = 0
        let invalidStatusCount = 0
        let firstError: string | null = null
        let firstInvalidStatus: any = null
        
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
              successCount++
            } else {
              invalidStatusCount++
              if (!firstInvalidStatus) {
                firstInvalidStatus = { station: s.station_code, response: d }
              }
            }
          } catch (e) {
            errorCount++
            if (!firstError) {
              firstError = `Station ${s.station_code}: ${(e as Error).message}`
            }
          }
        }
        
        console.log(`📊 WAQI API results: ${successCount} success, ${errorCount} errors, ${invalidStatusCount} invalid status from ${stations.length} stations`)
        if (firstError) {
          console.error(`❌ First WAQI error: ${firstError}`)
        }
        if (firstInvalidStatus) {
          console.warn(`⚠️ First invalid status example:`, JSON.stringify(firstInvalidStatus))
        }
      } else {
        console.log(`⚠️ WAQI: Skipping API calls (stations=${stations.length}, hasApiKey=${!!process.env.WAQI_API_KEY})`)
      }

      // If DB isn’t in use or returned no stations, try DB-less collection via in-memory index
      let aqItems = items
      if (aqItems.length === 0 && process.env.WAQI_API_KEY) {
        try {
          const { collectWAQIStationsBatch, ensureWaqiStationIndex } = await import('./data-collector')
          await ensureWaqiStationIndex()
          const limit = Number(process.env.WAQI_STATION_PAGE_SIZE || 150)
          const batch = await collectWAQIStationsBatch(limit)
          if (batch.length > 0) {
            console.log(`🌐 WAQI: Collected ${batch.length} stations via in-memory index (DB-less mode)`)
            aqItems = batch as any
          }
        } catch (e) {
          console.log(`⚠️ WAQI: DB-less collection failed:`, (e as Error).message)
        }
      }

      if (aqItems.length === 0) {
        console.log(`⚠️ WAQI: No stations found, using fallback (WeatherAPI/TOP_100_CITIES)`)
        // Fallback to WeatherAPI using OWM station names by allowed countries
        const waAllow = (providerConfigs as any)?.weatherapi?.countries?.allow || []
        const waCountries = Array.isArray(waAllow) && waAllow.length > 0 ? waAllow : undefined
        const cityKey = 'owm_cities'
        const cityOffset = await readCursor('weatherapi', waCountries && waCountries.length === 1 ? waCountries[0] : null, cityKey)
        const cityPageSize = Number(process.env.WAQI_FALLBACK_CITY_PAGE_SIZE || 100)
        const owmCities = await getOwmStationsPage({ countries: waCountries, offset: cityOffset, limit: cityPageSize })
        const nextCityOffset = owmCities.length ? cityOffset + owmCities.length : 0
        await writeCursor('weatherapi', waCountries && waCountries.length === 1 ? waCountries[0] : null, cityKey, nextCityOffset)
        const cities = owmCities.length ? owmCities.map(c => c.name || c.station_code) : TOP_100_CITIES
        console.log(`📍 WAQI: Using ${cities.length} cities for air quality collection (owmCities=${owmCities.length})`)
        const batch = await collectAirQualityDataBatch(cities, false)
        console.log(`📊 WAQI: Collected ${batch.length} air quality readings from fallback`)
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
          priority: config.defaultPriority,
          family: 'air_quality',
          providerId: 'waqi',
          datasetId: 'waqi_station_feed',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
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
    return datasetConfigs.noaa_coops_water_levels?.cadence.intervalMs || 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.noaa_coops_water_levels
    if (!config?.enabled) return []
    const data: EnvironmentalData[] = []
    try {
      // First run: always use a small batch (50) so data appears quickly on startup.
      // Subsequent runs use the configured NOAA_STATION_BATCH_SIZE (or 150 default).
      const flagKey = '__NOAA_ONEOFF_DONE__'
      const done = (global as any)[flagKey] === true
      const configured = Number(process.env.NOAA_STATION_BATCH_SIZE)
      const fullBatch = Number.isFinite(configured) && configured > 0 ? configured : config.chunkSize
      const limit = done ? fullBatch : Math.min(50, fullBatch)
      if (!done) {
        console.log(`🌊 NOAA-Weather: First run – using fast-start batch of ${limit} stations (full batch: ${fullBatch})`)
      }
      const batch = await collectWaterLevelDataBatch(limit)
      if (!done) (global as any)[flagKey] = true
      for (const item of batch) {
        const measurement: any = {
          river_level: item.river_level,
          sea_level: item.sea_level,
          station_id: item.station_id,
        }
        // Include all optional NOAA metrics if available
        if (item.water_temperature_c != null) measurement.water_temperature_c = item.water_temperature_c
        if (item.salinity_psu != null) measurement.salinity_psu = item.salinity_psu
        if (item.dissolved_oxygen_mg_l != null) measurement.dissolved_oxygen_mg_l = item.dissolved_oxygen_mg_l
        if (item.turbidity_ntu != null) measurement.turbidity_ntu = item.turbidity_ntu
        if (item.tide_height != null) measurement.tide_height = item.tide_height
        if (item.wind_speed_kph != null) measurement.wind_speed_kph = item.wind_speed_kph
        if (item.wind_direction_deg != null) measurement.wind_direction_deg = item.wind_direction_deg
        if (item.current_speed_ms != null) measurement.current_speed_ms = item.current_speed_ms
        if (item.current_direction_deg != null) measurement.current_direction_deg = item.current_direction_deg
        if (item.wave_height_m != null) measurement.wave_height_m = item.wave_height_m
        if ((item as any).pressure_hpa != null) measurement.pressure_hpa = (item as any).pressure_hpa
        if ((item as any).air_temperature_c != null) measurement.air_temperature_c = (item as any).air_temperature_c
        if ((item as any).dew_point_c != null) measurement.dew_point_c = (item as any).dew_point_c
        if ((item as any).visibility_nmi != null) measurement.visibility_nmi = (item as any).visibility_nmi
        data.push({
          type: 'water-level',
          timestamp: Date.parse(item.timestamp) || Date.now(),
          location: item.location,
          measurement,
          source: item.source,
          priority: config.defaultPriority,
          family: 'water_levels',
          providerId: 'noaa',
          datasetId: 'noaa_coops_water_levels',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: (item as any)?.coordinates,
          stationId: item.station_id,
        })
      }
    } catch (error) {
      console.error('Error fetching NOAA data:', error)
    }
    return data
  }
}

export class SensorCommunityWorker extends BaseWorker {
  constructor() {
    super('SensorCommunity-AirQuality')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.sensor_community_air_quality?.cadence.intervalMs || 5 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.sensor_community_air_quality
    if (!config?.enabled) return []

    const data: EnvironmentalData[] = []
    try {
      const batch = await collectSensorCommunityDataBatch(config.chunkSize)
      for (const item of batch) {
        data.push({
          type: 'air-quality',
          timestamp: Date.parse(item.timestamp) || Date.now(),
          location: item.location,
          measurement: {
            aqi: item.aqi,
            pm25: item.pm25,
            pm10: item.pm10,
            co: item.co,
            no2: item.no2,
            o3: item.o3,
            ...(item.temperature != null ? { temperature_c: item.temperature } : {}),
            ...(item.humidity != null ? { humidity_pct: item.humidity } : {}),
            ...(item.pressure != null ? { pressure_mb: item.pressure } : {}),
          },
          source: item.source,
          priority: config.defaultPriority,
          family: 'air_quality',
          providerId: 'sensor_community',
          datasetId: 'sensor_community_air_quality',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: item.coordinates,
          stationId: item.station_id,
        })
      }
    } catch (error) {
      console.error('Error fetching Sensor.Community data:', error)
    }
    return data
  }
}

export class NOAANdbcWorker extends BaseWorker {
  constructor() {
    super('NOAA-NDBC')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.noaa_ndbc_latest_obs?.cadence.intervalMs || 5 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.noaa_ndbc_latest_obs
    if (!config?.enabled) return []

    const data: EnvironmentalData[] = []
    try {
      const batch = await collectNdbcLatestObservations(config.chunkSize)
      for (const item of batch) {
        const measurement: Record<string, unknown> = {
          station_id: item.station_id,
        }
        if (item.sea_level != null) measurement.sea_level = item.sea_level
        if (item.river_level != null) measurement.river_level = item.river_level
        if (item.wave_height_m != null) measurement.wave_height_m = item.wave_height_m
        if (item.tide_height != null) measurement.tide_height = item.tide_height
        if (item.water_temperature_c != null) measurement.water_temperature_c = item.water_temperature_c
        if (item.air_temperature_c != null) measurement.air_temperature_c = item.air_temperature_c
        if (item.dew_point_c != null) measurement.dew_point_c = item.dew_point_c
        if (item.pressure_hpa != null) measurement.pressure_hpa = item.pressure_hpa
        if (item.pressure_tendency_hpa != null) measurement.pressure_tendency_hpa = item.pressure_tendency_hpa
        if (item.wind_speed_kph != null) measurement.wind_speed_kph = item.wind_speed_kph
        if (item.gust_kph != null) measurement.gust_kph = item.gust_kph
        if (item.wind_direction_deg != null) measurement.wind_direction_deg = item.wind_direction_deg
        if (item.wave_period_s != null) measurement.wave_period_s = item.wave_period_s
        if (item.average_wave_period_s != null) measurement.average_wave_period_s = item.average_wave_period_s
        if (item.mean_wave_direction_deg != null) measurement.mean_wave_direction_deg = item.mean_wave_direction_deg
        if (item.visibility_nmi != null) measurement.visibility_nmi = item.visibility_nmi

        data.push({
          type: 'water-level',
          timestamp: Date.parse(item.timestamp) || Date.now(),
          location: item.location,
          measurement,
          source: item.source,
          priority: config.defaultPriority,
          family: 'water_levels',
          providerId: 'noaa_ndbc',
          datasetId: 'noaa_ndbc_latest_obs',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: item.coordinates,
          stationId: item.station_id,
        })
      }
    } catch (error) {
      console.error('Error fetching NOAA NDBC data:', error)
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
    const base = datasetConfigs.usgs_earthquakes?.cadence.intervalMs || 15 * 60 * 1000
    return base
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.usgs_earthquakes
    if (!config?.enabled) return []
    const data: EnvironmentalData[] = []
    try {
      // Read collection window and magnitude threshold from environment, with sensible defaults
      const envHours = Number(process.env.USGS_TIME_WINDOW_HOURS)
      const hours = Number.isFinite(envHours) && envHours > 0 ? envHours : 24
      const envMinMag = Number(process.env.USGS_MIN_MAGNITUDE)
      const minMag = Number.isFinite(envMinMag) && envMinMag >= 0 ? envMinMag : 2.0
      const envMax = Number(process.env.USGS_MAX_RESULTS)
      const maxResults = Number.isFinite(envMax) && envMax > 0 ? envMax : undefined
      const batch = await collectSeismicDataBatch(hours, minMag, maxResults)
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
          priority: item.magnitude >= 4 ? 'high' : config.defaultPriority,
          family: 'seismic_activity',
          providerId: 'usgs',
          datasetId: 'usgs_earthquakes',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          eventId: item.event_id,
          coordinates: item.coordinates,
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

export class EMSCRealtimeWorker extends BaseWorker {
  private socket: any | null = null
  private socketConnecting = false
  private bufferedEvents: EnvironmentalData[] = []
  private lastSocketEventAt = 0

  constructor() {
    super('EMSC-Realtime')
  }

  public start(): void {
    void this.ensureSocket()
    super.start()
  }

  public stop(): void {
    try {
      this.socket?.removeAllListeners?.()
      this.socket?.close?.()
    } catch {}
    this.socket = null
    this.socketConnecting = false
    super.stop()
  }

  protected getIntervalMs(): number {
    return datasetConfigs.emsc_realtime_events?.cadence.intervalMs || 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.emsc_realtime_events
    if (!config?.enabled) return []

    await this.ensureSocket()

    if (this.bufferedEvents.length > 0) {
      const drained = this.bufferedEvents.splice(0, config.chunkSize)
      return drained
    }

    if (this.lastSocketEventAt > 0 && (Date.now() - this.lastSocketEventAt) < 5 * 60 * 1000) {
      return []
    }

    const fallbackWindowMinutes = Number(process.env.EMSC_FALLBACK_WINDOW_MINUTES || 15)
    const fallback = await collectEMSCLatestEvents(fallbackWindowMinutes, config.chunkSize)
    return fallback.map(item => ({
      type: 'seismic',
      timestamp: Date.parse(item.timestamp) || Date.now(),
      location: item.location,
      measurement: {
        magnitude: item.magnitude,
        depth: item.depth,
        latitude: item.coordinates.lat,
        longitude: item.coordinates.lon,
      },
      source: item.source,
      priority: item.magnitude >= 4 ? 'high' : config.defaultPriority,
      family: 'seismic_activity',
      providerId: 'emsc',
      datasetId: 'emsc_realtime_events',
      queueLane: config.queueLane,
      maxInFlight: config.maxInFlight,
      eventId: item.event_id,
      coordinates: item.coordinates,
    }))
  }

  private async ensureSocket(): Promise<void> {
    const config = datasetConfigs.emsc_realtime_events
    if (!config?.enabled) return
    if (this.socketConnecting) return
    const readyState = this.socket?.readyState
    if (readyState === 0 || readyState === 1) return

    this.socketConnecting = true
    try {
      const WebSocketCtor = require('ws')
      const endpoint = process.env.EMSC_WEBSOCKET_URL || 'wss://www.seismicportal.eu/standing_order/websocket'
      const ws = new WebSocketCtor(endpoint, { handshakeTimeout: 15000 })
      this.socket = ws

      ws.on('open', () => {
        this.socketConnecting = false
        try { console.log('🌋 EMSC: WebSocket connected') } catch {}
      })

      ws.on('message', async (message: Buffer | string) => {
        try {
          const parsed = JSON.parse(String(message))
          const properties = parsed?.data?.properties || {}
          const geometry = parsed?.data?.geometry?.coordinates || []
          const eventId = String(properties?.unid || properties?.source_id || '')
          if (!eventId) return
          const dedupeKey = `emsc:ws:${eventId}:${properties?.time || ''}`
          if (!(await dedupeStore.add(dedupeKey))) return

          const item: EnvironmentalData = {
            type: 'seismic',
            timestamp: Date.parse(properties?.time || '') || Date.now(),
            location: String(properties?.flynn_region || 'Unknown region'),
            measurement: {
              magnitude: Number(properties?.mag ?? 0),
              depth: Number(properties?.depth ?? 0),
              latitude: Number(properties?.lat ?? geometry?.[1] ?? 0),
              longitude: Number(properties?.lon ?? geometry?.[0] ?? 0),
              action: parsed?.action || 'insert',
            },
            source: 'EMSC',
            priority: Number(properties?.mag ?? 0) >= 4 ? 'high' : config.defaultPriority,
            family: 'seismic_activity',
            providerId: 'emsc',
            datasetId: 'emsc_realtime_events',
            queueLane: config.queueLane,
            maxInFlight: config.maxInFlight,
            eventId,
            coordinates: {
              lat: Number(properties?.lat ?? geometry?.[1] ?? 0),
              lon: Number(properties?.lon ?? geometry?.[0] ?? 0),
            },
          }

          this.lastSocketEventAt = Date.now()
          this.bufferedEvents.push(item)
          const maxBuffered = config.maxInFlight
          if (this.bufferedEvents.length > maxBuffered) {
            this.bufferedEvents.splice(0, this.bufferedEvents.length - maxBuffered)
          }
        } catch (error) {
          if (bsvConfig.logging.level === 'debug') {
            console.warn('EMSC WebSocket parse error:', error)
          }
        }
      })

      ws.on('close', () => {
        this.socket = null
        this.socketConnecting = false
        try { console.warn('⚠️ EMSC: WebSocket disconnected, will reconnect on next cycle') } catch {}
      })

      ws.on('error', (error: Error) => {
        this.socket = null
        this.socketConnecting = false
        console.warn('⚠️ EMSC WebSocket error:', error.message)
      })
    } catch (error) {
      this.socket = null
      this.socketConnecting = false
      console.warn('⚠️ Unable to initialise EMSC WebSocket:', error)
    }
  }
}

// Worker 4: Advanced Metrics (WeatherAPI primary, OWM fallback)
export class AdvancedMetricsWorker extends BaseWorker {
  constructor() {
    super('Advanced-Metrics')
  }

  protected getIntervalMs(): number {
    const weatherConfig = datasetConfigs.weatherapi_advanced_metrics
    const owmConfig = datasetConfigs.owm_advanced_metrics
    return weatherConfig?.cadence.intervalMs || owmConfig?.cadence.intervalMs || 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    if (!datasetConfigs.weatherapi_advanced_metrics?.enabled && !datasetConfigs.owm_advanced_metrics?.enabled) return []
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
      let rawQueries = stations.length
        ? stations.map(s => (typeof (s as any).lat === 'number' && typeof (s as any).lon === 'number')
            ? `${(s as any).lat},${(s as any).lon}`
            : ((s as any).name || (s as any).station_code))
        : []
      // DB-less fallback: use WAQI in-memory station index (lat,lon) when stations table is empty or DB disabled
      if (rawQueries.length === 0) {
        try {
          const { ensureWaqiStationIndex } = await import('./data-collector')
          const { cacheStore } = await import('./stores')
          await ensureWaqiStationIndex()
          const waqi = (await cacheStore.get<any[]>('waqi:stationIndex')) || []
          if (Array.isArray(waqi) && waqi.length > 0) {
            rawQueries = waqi.slice(0, pageSize).map(s => `${s.lat},${s.lon}`)
            try { console.log(`📍 Advanced: Using ${rawQueries.length} WAQI index locations`) } catch {}
          }
        } catch {}
      }
      // Final fallback: TOP_100_CITIES up to pageSize
      if (rawQueries.length === 0) {
        rawQueries = TOP_100_CITIES.slice(0, pageSize)
        try { console.log(`📍 Advanced: Using ${rawQueries.length} TOP_100_CITIES locations`) } catch {}
      }
      const cities = rawQueries.filter(q => typeof q === 'string' && q.trim().length >= 2)

      // Fetch with configurable concurrency to reduce wall-clock time
      const concurrency = Math.max(1, Number(process.env.ADVANCED_CONCURRENCY || 8))
      for (let i = 0; i < cities.length; i += concurrency) {
        const slice = cities.slice(i, i + concurrency)
        const results = await Promise.all(slice.map(async (city) => {
          const data = await this.fetchAdvancedForCity(city!)
          if (!data) return null
          const datasetConfig = data.datasetId === 'owm_advanced_metrics'
            ? datasetConfigs.owm_advanced_metrics
            : datasetConfigs.weatherapi_advanced_metrics
          // Persist to DB only if enabled
          if (process.env.GAIALOG_NO_DB !== 'true') {
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
          }
          return {
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
            priority: datasetConfig?.defaultPriority || 'normal',
            family: 'advanced_metrics',
            providerId: data.providerId,
            datasetId: data.datasetId,
            queueLane: datasetConfig?.queueLane,
            maxInFlight: datasetConfig?.maxInFlight,
            coordinates: data.coordinates,
          } as EnvironmentalData
        }))
        for (const r of results) if (r) items.push(r)
      }
    } catch (e) {
      console.error('Error fetching Advanced metrics:', e)
    }
    return items
  }

  private async fetchAdvancedForCity(city: string): Promise<any | null> {
    if (!city || typeof city !== 'string' || city.trim().length < 2) return null
    const coordMatch = city.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
    const coordQuery = coordMatch
      ? { lat: Number(coordMatch[1]), lon: Number(coordMatch[2]) }
      : null
    // WeatherAPI primary
    try {
      if (datasetConfigs.weatherapi_advanced_metrics?.enabled && process.env.WEATHERAPI_KEY) {
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
          providerId: 'weatherapi',
          datasetId: 'weatherapi_advanced_metrics',
          coordinates: (typeof data?.location?.lat === 'number' && typeof data?.location?.lon === 'number')
            ? { lat: data.location.lat, lon: data.location.lon } : undefined,
        }
      }
    } catch (e) {
      // Log once at warn level on first failure, then debug only — avoids noisy stack traces
      const warnKey = '__WEATHERAPI_WARNED__'
      if (!(global as any)[warnKey]) {
        ;(global as any)[warnKey] = true
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`⚠️  WeatherAPI: ${msg} — if this persists, verify WEATHERAPI_KEY is valid/unexpired. Falling back to OWM.`)
      }
    }
    // OWM fallback (15‑min cache handled inside provider)
    try {
      if (datasetConfigs.owm_advanced_metrics?.enabled && process.env.OWM_API_KEY) {
        let first: any = coordQuery ? { lat: coordQuery.lat, lon: coordQuery.lon, name: city } : null
        if (!first) {
          const geo = await fetchJsonWithRetry<any>(
            `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${process.env.OWM_API_KEY}`,
            { retries: 2, providerId: 'owm' }
          )
          first = Array.isArray(geo) ? geo[0] : null
        }
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
          location: first.name || city,
          timestamp: ts,
          source: 'OWM-derived metrics',
          temperature_c: curr.temp ?? undefined,
          humidity_pct: curr.humidity ?? undefined,
          pressure_mb: curr.pressure ?? undefined,
          wind_kph: windKph || undefined,
          wind_deg: curr.wind_deg ?? undefined,
          providerId: 'owm',
          datasetId: 'owm_advanced_metrics',
          coordinates: { lat: first.lat, lon: first.lon },
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
      const sensorCommunityWorker = new SensorCommunityWorker()
      const noaaNdbcWorker = new NOAANdbcWorker()
      const usgsWorker = new USGSWorker()
      const emscWorker = new EMSCRealtimeWorker()
      const advWorker = new AdvancedMetricsWorker()

      this.workers.set('waqi-environmental', waqiWorker)
      this.workers.set('noaa-weather', noaaWorker)
      this.workers.set('sensor-community-air-quality', sensorCommunityWorker)
      this.workers.set('noaa-ndbc', noaaNdbcWorker)
      this.workers.set('usgs-seismic', usgsWorker)
      this.workers.set('emsc-realtime', emscWorker)
      this.workers.set('advanced-metrics', advWorker)

      this.isInitialized = true
      try { console.log(`✅ Worker Manager initialized with ${this.workers.size} workers`) } catch {}
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

// Persist singleton on globalThis to survive Next.js dev-mode module
// re-evaluations that would otherwise create duplicate managers/workers.
const _wm = globalThis as any
if (!_wm.__GAIALOG_WORKER_MANAGER__) {
  _wm.__GAIALOG_WORKER_MANAGER__ = new WorkerManager()
}
export const workerManager: WorkerManager = _wm.__GAIALOG_WORKER_MANAGER__