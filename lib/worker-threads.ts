import { workerQueue } from './worker-queue'
import { BSVTransactionData } from './bsv-transaction-service'
import { bsvConfig } from './bsv-config'
import {
  collectAirQualityDataBatch,
  collectEMSCLatestEvents,
  collectGeoNetLatestEvents,
  collectNdbcLatestObservations,
  collectSeismicDataBatch,
  collectSensorCommunityDataBatch,
  collectWaterLevelDataBatch,
  collectSpaceWeatherData,
  collectGeomagnetismData,
  collectVolcanoAlerts,
  collectUpperAtmosphereData,
} from './data-collector'
import { TOP_100_CITIES } from './city-seeds'
import { dedupeStore } from './stores'
import { fetchJsonWithRetry } from './provider-fetch'
import { fetchOwmJsonWithRotation, hasOwmApiKeys } from './owm'
import { insertAdvanced, insertAirQuality, insertWaterLevel, insertSeismic, calculateSourceHash, getOwmStationsPage, getStationsByProviderPage, getStationCountByProvider, readCursor, writeCursor, hasAirQualityTxId, hasWaterLevelTxId, hasSeismicTxId, hasSeismicEventTxId, hasAdvancedTxId, getSeismicByEventId } from './repositories'
import { datasetConfigs, providerConfigs } from './provider-registry'
import { cursorStore } from './stores'
import { blockchainService } from './blockchain'
import { DataFamily, DatasetId, mapWorkerTypeToFamily, ProviderId, QueueLane, resolveProviderIdFromSource, resolveSourceLabel } from './stream-registry'
import { throughputObservability } from './throughput-observability'
import { applySensitivityControls } from './sensitivity-controls'

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
  type: 'air-quality' | 'weather' | 'seismic' | 'water-level' | 'advanced' | 'geomagnetism' | 'volcanic' | 'space-weather' | 'upper-atmosphere' | 'biodiversity' | 'conservation' | 'hydrology' | 'flood' | 'natural-event' | 'land-use' | 'mining' | 'transport' | 'planning'
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

        let unifiedHash: string
        try {
          unifiedHash = this.computeUnifiedHash(item)
        } catch {
          unifiedHash = this.generateSourceHash(item)
        }

        const isNew = await dedupeStore.add(unifiedHash)
        if (!isNew) {
          cycleStats.duplicateDropped++
          throughputObservability.recordDuplicateDropped(itemMeta)
          continue
        }

        const collectedAt = new Date(item.timestamp)
        try {
          if (item.type === 'air-quality') {
            if (process.env.GAIALOG_NO_DB !== 'true') {
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
            if (process.env.GAIALOG_NO_DB !== 'true') {
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
            if (process.env.GAIALOG_NO_DB !== 'true') {
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
            if (process.env.GAIALOG_NO_DB !== 'true') {
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
          }
        } catch (persistErr) {
          console.error('Persistence error before enqueue:', persistErr)
        }

        const resolvedFamily = (item.family || mapWorkerTypeToFamily(item.type)) as DataFamily
        const resolvedProvider = (item.providerId || resolveProviderIdFromSource(item.source) || undefined) as ProviderId | undefined
        const sensitivityResult = applySensitivityControls(
          item.measurement || {},
          {
            family: resolvedFamily,
            providerId: resolvedProvider ?? null,
            dedupeKey: `${resolvedFamily}:${resolvedProvider}:${item.timestamp}`,
            lat: item.coordinates?.lat,
            lon: item.coordinates?.lon,
          },
        )

        if (!sensitivityResult.allowed) {
          if (sensitivityResult.delayed) cycleStats.backpressured++
          continue
        }

        const policyCoords = sensitivityResult.coordinates
        const finalCoordinates = item.coordinates
          ? { lat: policyCoords.lat ?? item.coordinates.lat, lon: policyCoords.lon ?? item.coordinates.lon }
          : item.coordinates

        const bsvData: BSVTransactionData = {
          type: item.type,
          timestamp: item.timestamp,
          location: item.location,
          measurement: sensitivityResult.payload,
          source_hash: unifiedHash,
          family: resolvedFamily,
          providerId: resolvedProvider,
          datasetId: item.datasetId,
          sourceLabel: resolveSourceLabel(item.providerId, item.datasetId, item.source),
          queueLane: item.queueLane,
          maxInFlight: item.maxInFlight,
          coordinates: finalCoordinates,
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
          const queueId = workerQueue.addToQueue(bsvData, item.priority)
          if (queueId) {
            this.stats.totalTransactions++
            cycleStats.queued++
          } else {
            cycleStats.backpressured++
            break
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
        const novel = cycleStats.submitted + cycleStats.queued
        const nextRunIn = Math.max(1000, this.getIntervalMs() - processingTime)
        console.log(
          `✅ ${this.workerId}: Processed ${data.length} data points in ${processingTime}ms ` +
          `(submitted=${cycleStats.submitted}, queued=${cycleStats.queued}, duplicate=${cycleStats.duplicateDropped}, ` +
          `already_on_chain=${cycleStats.alreadyOnChainDropped}, backpressured=${cycleStats.backpressured}) ` +
          `novel=${novel} nextRunIn=${(nextRunIn / 1000).toFixed(0)}s`
        )
      }

    } catch (error) {
      this.stats.errors++
      console.error(`❌ ${this.workerId}: Error collecting data:`, error)
    }

    if (this.isRunning) {
      if (this.interval) { clearTimeout(this.interval); this.interval = null }
      const elapsed = Date.now() - startTime
      const backpressureRetryMs = 10_000
      const delay = cycleStats.backpressured > 0
        ? backpressureRetryMs
        : Math.max(1000, this.getIntervalMs() - elapsed)
      this.interval = setTimeout(() => this.run(), delay)
    }
  }

  private computeUnifiedHash(item: EnvironmentalData): string {
    const ts = new Date(item.timestamp).toISOString()
    if (item.type === 'air-quality') {
      return calculateSourceHash({ type: 'air_quality', aq: { ...item.measurement, location: item.location, timestamp: ts, source: item.source } })
    } else if (item.type === 'water-level') {
      return calculateSourceHash({ type: 'water_levels', w: { ...item.measurement, location: item.location, timestamp: ts, source: item.source } })
    } else if (item.type === 'seismic') {
      return calculateSourceHash({ type: 'seismic', s: { magnitude: (item.measurement as any)?.magnitude, depth: (item.measurement as any)?.depth, location: item.location, coordinates: { lat: (item.measurement as any)?.latitude, lon: (item.measurement as any)?.longitude }, timestamp: ts, source: item.source, event_id: item.eventId } })
    } else if (item.type === 'advanced') {
      return calculateSourceHash({ type: 'advanced', a: { ...item.measurement, location: item.location, timestamp: ts, source: item.source } })
    }
    return this.generateSourceHash(item)
  }

  private generateSourceHash(data: EnvironmentalData): string {
    return calculateSourceHash({
      type: data.type,
      providerId: data.providerId || resolveProviderIdFromSource(data.source) || 'unknown',
      datasetId: data.datasetId || 'default',
      source: data.source,
      timestamp: new Date(data.timestamp).toISOString(),
      location: data.location,
      measurement: data.measurement,
    })
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

  private discoveryLastRanAt = 0

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.waqi_station_feed
    if (!config?.enabled) return []
    const data: EnvironmentalData[] = []
    try {
      const DISCOVERY_INTERVAL_MS = 15 * 60 * 1000
      const now = Date.now()
      if (now - this.discoveryLastRanAt >= DISCOVERY_INTERVAL_MS) {
        try {
          const { ensureWaqiStationIndex } = await import('./data-collector')
          await ensureWaqiStationIndex()
          this.discoveryLastRanAt = now
        } catch (e) {
          console.log(`⚠️ WAQI: Station index discovery failed:`, (e as Error).message)
        }
      }
      const dbDisabled = process.env.GAIALOG_NO_DB === 'true'
      const allow = (providerConfigs as any)?.waqi?.countries?.allow || []
      const countries = Array.isArray(allow) && allow.length > 0 ? allow : undefined
      const key = 'stations'
      const pageSize = Number(process.env.WAQI_STATION_PAGE_SIZE || 1000)
      const concurrency = Math.max(1, Number(process.env.WAQI_STATION_CONCURRENCY || 20))

      const sweepBudgetMs = Math.max(30_000, Math.floor(this.getIntervalMs() * 0.85))
      const sweepStart = Date.now()
      const allItems: any[] = []
      let pagesSwept = 0
      let totalStationsQueried = 0
      let totalStationsProcessed = 0
      let totalSuccess = 0
      let totalErrors = 0

      if (!dbDisabled && process.env.WAQI_API_KEY) {
        const cursorScope = countries && countries.length === 1 ? countries[0] : null
        let cursorWrapped = false
        const token = process.env.WAQI_API_KEY
        const cursorStartPos = await readCursor('waqi', cursorScope, key)

        while (!cursorWrapped && (Date.now() - sweepStart) < sweepBudgetMs) {
          try {
            const offset = await readCursor('waqi', cursorScope, key)
            const stations = await getStationsByProviderPage({ provider: 'waqi', countries, offset, limit: pageSize })

            if (stations.length === 0 && offset > 0) {
              await writeCursor('waqi', cursorScope, key, 0)
              cursorWrapped = true
              continue
            } else if (stations.length === 0) {
              break
            }

            let processedInPage = 0
            let budgetExhausted = false
            for (let chunkStart = 0; chunkStart < stations.length; chunkStart += concurrency) {
              if ((Date.now() - sweepStart) >= sweepBudgetMs) { budgetExhausted = true; break }
              const chunk = stations.slice(chunkStart, chunkStart + concurrency)
              const results = await Promise.allSettled(chunk.map(async (s) => {
                const url = `https://api.waqi.info/feed/@${encodeURIComponent(s.station_code)}/?token=${token}`
                const d = await fetchJsonWithRetry<any>(url, { retries: 1, providerId: 'waqi' })
                if (d?.status === 'ok') {
                  return {
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
                  }
                }
                return null
              }))
              for (const r of results) {
                if (r.status === 'fulfilled' && r.value) {
                  allItems.push(r.value)
                  totalSuccess++
                } else if (r.status === 'rejected') {
                  totalErrors++
                }
              }
              processedInPage += chunk.length
            }

            totalStationsProcessed += processedInPage
            totalStationsQueried += stations.length

            const nextOffset = offset + processedInPage
            if (stations.length < pageSize) {
              await writeCursor('waqi', cursorScope, key, 0)
              cursorWrapped = true
            } else {
              await writeCursor('waqi', cursorScope, key, nextOffset)
            }

            pagesSwept++
            if (budgetExhausted) break
            if (pagesSwept % 3 === 0 || cursorWrapped) {
              const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(1)
              console.log(`WAQI: Sweep p${pagesSwept} queried=${totalStationsQueried} processed=${totalStationsProcessed} readings=${allItems.length} ok=${totalSuccess} err=${totalErrors} ${elapsed}s`)
            }
          } catch (e) {
            console.error('WAQI: Sweep page error:', e)
            break
          }
        }

        const cursorEndPos = await readCursor('waqi', cursorScope, key)
        const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(1)
        console.log(
          `WAQI: Sweep done pages=${pagesSwept} cursor=${cursorStartPos}→${cursorEndPos} queried=${totalStationsQueried} processed=${totalStationsProcessed} ` +
          `readings=${allItems.length} ok=${totalSuccess} err=${totalErrors} ${elapsed}s` +
          (cursorWrapped ? ' [full cycle]' : '')
        )
      } else if (dbDisabled) {
        console.log('WAQI: Database disabled (GAIALOG_NO_DB=true); using DB-less station index')
      }

      let aqItems: any[] = allItems
      if (aqItems.length === 0 && process.env.WAQI_API_KEY) {
        try {
          const { collectWAQIStationsBatch } = await import('./data-collector')
          const limit = pageSize
          const batch = await collectWAQIStationsBatch(limit)
          if (batch.length > 0) {
            console.log(`WAQI: Collected ${batch.length} stations via in-memory index (DB-less mode)`)
            aqItems = batch as any
          }
        } catch (e) {
          console.log(`WAQI: DB-less collection failed: ${(e as Error).message}`)
        }
      }

      if (aqItems.length === 0) {
        console.log(`⚠️ WAQI: No stations found via DB or in-memory index, using fallback (WeatherAPI/TOP_100_CITIES)`)
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
      const sweepBudget = Math.max(30_000, Math.floor(this.getIntervalMs() * 0.85))
      const batch = await collectWaterLevelDataBatch(limit, sweepBudget)
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
      const batch = await collectSensorCommunityDataBatch(config.chunkSize, true)
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
      const batch = await collectNdbcLatestObservations(config.chunkSize, true)
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

export class GeoNetWorker extends BaseWorker {
  constructor() {
    super('GeoNet-Seismic')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.geonet_realtime_events?.cadence.intervalMs || 5 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.geonet_realtime_events
    if (!config?.enabled) return []

    const data: EnvironmentalData[] = []
    try {
      const batch = await collectGeoNetLatestEvents(60, config.chunkSize)
      for (const item of batch) {
        data.push({
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
          providerId: 'geonet',
          datasetId: 'geonet_realtime_events',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          eventId: item.event_id,
          coordinates: item.coordinates,
        })
      }
    } catch (error) {
      console.error('Error fetching GeoNet data:', error)
    }
    return data
  }
}

// Worker 4: Advanced Metrics (WeatherAPI primary, OWM fallback)
export class AdvancedMetricsWorker extends BaseWorker {
  private poolHealthLogged = false

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

    if (!this.poolHealthLogged && process.env.GAIALOG_NO_DB !== 'true') {
      this.poolHealthLogged = true
      try {
        const owmCount = await getStationCountByProvider('owm')
        const waqiCount = await getStationCountByProvider('waqi')
        console.log(`Advanced: Station pool health — OWM=${owmCount} WAQI=${waqiCount}`)
        if (owmCount === 0) {
          console.warn(`⚠️ Advanced: OWM station pool is EMPTY. Run 'npx tsx scripts/seed-owm-stations.ts' to populate for full breadth.`)
        }
      } catch {}
    }

    const items: EnvironmentalData[] = []
    try {
      const allow = providerConfigs.weatherapi?.countries?.allow || []
      const countries = Array.isArray(allow) && allow.length > 0 ? allow : undefined
      const key = 'owm_cities'
      const pageSize = Number(process.env.ADVANCED_METRICS_PAGE_SIZE || 100)
      const concurrency = Math.max(1, Number(process.env.ADVANCED_CONCURRENCY || 8))
      const cursorScope = countries && countries.length === 1 ? countries[0] : null

      const sweepBudgetMs = Math.max(30_000, Math.floor(this.getIntervalMs() * 0.85))
      const sweepStart = Date.now()
      let pagesSwept = 0
      let totalCitiesQueried = 0
      let totalCitiesProcessed = 0
      let cursorWrapped = false

      while (!cursorWrapped && (Date.now() - sweepStart) < sweepBudgetMs) {
        const offset = await readCursor('weatherapi', cursorScope, key)
        const stations = await getOwmStationsPage({ countries, offset, limit: pageSize })

        if (stations.length === 0 && offset > 0) {
          await writeCursor('weatherapi', cursorScope, key, 0)
          cursorWrapped = true
          continue
        } else if (stations.length === 0) {
          break
        }

        const rawQueries = stations.map(s => (typeof (s as any).lat === 'number' && typeof (s as any).lon === 'number')
            ? `${(s as any).lat},${(s as any).lon}`
            : ((s as any).name || (s as any).station_code))

        const cities = rawQueries.filter(q => typeof q === 'string' && q.trim().length >= 2)
        if (cities.length === 0) {
          if (stations.length < pageSize) {
            await writeCursor('weatherapi', cursorScope, key, 0)
            cursorWrapped = true
          } else {
            await writeCursor('weatherapi', cursorScope, key, offset + stations.length)
          }
          pagesSwept++
          continue
        }

        totalCitiesQueried += cities.length
        let processedInPage = 0
        let budgetExhausted = false

        for (let i = 0; i < cities.length; i += concurrency) {
          if ((Date.now() - sweepStart) >= sweepBudgetMs) { budgetExhausted = true; break }
          const slice = cities.slice(i, i + concurrency)
          const results = await Promise.all(slice.map(async (city) => {
            const data = await this.fetchAdvancedForCity(city!)
            if (!data) return null
            const datasetConfig = data.datasetId === 'owm_advanced_metrics'
              ? datasetConfigs.owm_advanced_metrics
              : datasetConfigs.weatherapi_advanced_metrics
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
                  source_hash: calculateSourceHash({ type: 'advanced', a: { ...data, location: data.location, timestamp: new Date(data.timestamp).toISOString(), source: data.source } }),
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
          processedInPage += slice.length
        }

        totalCitiesProcessed += processedInPage

        const nextOffset = offset + processedInPage
        if (stations.length < pageSize) {
          await writeCursor('weatherapi', cursorScope, key, 0)
          cursorWrapped = true
        } else {
          await writeCursor('weatherapi', cursorScope, key, nextOffset)
        }

        pagesSwept++
        if (budgetExhausted) break
        if (pagesSwept % 3 === 0 || cursorWrapped) {
          const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(1)
          console.log(`Advanced: Sweep p${pagesSwept} queried=${totalCitiesQueried} processed=${totalCitiesProcessed} readings=${items.length} ${elapsed}s`)
        }
      }

      if (items.length === 0 && pagesSwept === 0) {
        console.warn(`⚠️ Advanced: OWM station pool is empty or not seeded. Run seed-owm-stations to populate. Falling back to WAQI index or TOP_100_CITIES.`)
        let rawQueries: string[] = []
        try {
          const { cacheStore } = await import('./stores')
          const waqi = (await cacheStore.get<any[]>('waqi:stationIndex')) || []
          if (Array.isArray(waqi) && waqi.length > 0) {
            rawQueries = waqi.slice(0, pageSize).map(s => `${s.lat},${s.lon}`)
            console.log(`Advanced: Using ${rawQueries.length} WAQI index locations as fallback`)
          }
        } catch {}
        if (rawQueries.length === 0) {
          rawQueries = TOP_100_CITIES.slice(0, pageSize)
          console.log(`Advanced: Using ${rawQueries.length} TOP_100_CITIES as last-resort fallback`)
        }
        const cities = rawQueries.filter(q => typeof q === 'string' && q.trim().length >= 2)
        for (let i = 0; i < cities.length; i += concurrency) {
          const slice = cities.slice(i, i + concurrency)
          const results = await Promise.all(slice.map(async (city) => {
            const data = await this.fetchAdvancedForCity(city!)
            if (!data) return null
            const datasetConfig = data.datasetId === 'owm_advanced_metrics'
              ? datasetConfigs.owm_advanced_metrics
              : datasetConfigs.weatherapi_advanced_metrics
            return {
              type: 'advanced',
              timestamp: Date.parse(data.timestamp) || Date.now(),
              location: data.location,
              measurement: {
                uv_index: data.uv_index, soil_moisture: data.soil_moisture,
                wildfire_risk: data.wildfire_risk, environmental_quality_score: data.environmental_quality_score,
                temperature_c: data.temperature_c, humidity_pct: data.humidity_pct,
                pressure_mb: data.pressure_mb, wind_kph: data.wind_kph, wind_deg: data.wind_deg,
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
      }

      const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(1)
      console.log(`Advanced: Sweep done pages=${pagesSwept} queried=${totalCitiesQueried} processed=${totalCitiesProcessed} readings=${items.length} ${elapsed}s${cursorWrapped ? ' [full cycle]' : ''}`)
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
      if (datasetConfigs.owm_advanced_metrics?.enabled && hasOwmApiKeys()) {
        let first: any = coordQuery ? { lat: coordQuery.lat, lon: coordQuery.lon, name: city } : null
        if (!first) {
          const geo = await fetchOwmJsonWithRotation<any>(
            (apiKey) => `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${apiKey}`,
            { retries: 2, providerId: 'owm' },
          )
          first = Array.isArray(geo) ? geo[0] : null
        }
        if (!first?.lat || !first?.lon) return null
        const oc = await fetchOwmJsonWithRotation<any>(
          (apiKey) => `https://api.openweathermap.org/data/3.0/onecall?lat=${first.lat}&lon=${first.lon}&exclude=minutely,hourly,daily,alerts&units=metric&appid=${apiKey}`,
          { retries: 2, providerId: 'owm' },
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

// ─── Space Weather Worker ────────────────────────────────────────────────────

export class SpaceWeatherWorker extends BaseWorker {
  constructor() {
    super('SpaceWeather-RTSW')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.noaa_space_weather_rtsw?.cadence.intervalMs || 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.noaa_space_weather_rtsw
    if (!config?.enabled) return []

    const data: EnvironmentalData[] = []
    try {
      const batch = await collectSpaceWeatherData()
      for (const item of batch) {
        data.push({
          type: 'space-weather',
          timestamp: item.timestamp,
          location: 'DSCOVR L1 Lagrange Point',
          measurement: {
            bx_gsm: item.bx_gsm,
            by_gsm: item.by_gsm,
            bz_gsm: item.bz_gsm,
            bt: item.bt,
            speed: item.speed,
            density: item.density,
            temperature: item.temperature,
          },
          source: item.source,
          priority: (item.bz_gsm !== null && item.bz_gsm < -10) ? 'high' : 'normal',
          family: 'space_weather',
          providerId: 'noaa_space_weather',
          datasetId: 'noaa_space_weather_rtsw',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: 0, lon: 0 },
        })
      }
    } catch (error) {
      console.error('Error fetching space weather data:', error)
    }
    return data
  }
}

// ─── Geomagnetism Worker ─────────────────────────────────────────────────────

export class GeomagnetismWorker extends BaseWorker {
  constructor() {
    super('Geomagnetism-USGS')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.usgs_geomagnetism_observatories?.cadence.intervalMs || 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.usgs_geomagnetism_observatories
    if (!config?.enabled) return []

    const data: EnvironmentalData[] = []
    try {
      const batch = await collectGeomagnetismData()
      for (const item of batch) {
        data.push({
          type: 'geomagnetism',
          timestamp: item.timestamp,
          location: item.observatory,
          measurement: item.elements,
          source: item.source,
          priority: 'normal',
          family: 'geomagnetism',
          providerId: 'usgs_geomagnetism',
          datasetId: 'usgs_geomagnetism_observatories',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching geomagnetism data:', error)
    }
    return data
  }
}

// ─── Volcanoes Worker ────────────────────────────────────────────────────────

export class VolcanoWorker extends BaseWorker {
  constructor() {
    super('Volcanoes-USGS')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.usgs_volcano_alerts?.cadence.intervalMs || 10 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.usgs_volcano_alerts
    if (!config?.enabled) return []

    const data: EnvironmentalData[] = []
    try {
      const batch = await collectVolcanoAlerts()
      for (const item of batch) {
        data.push({
          type: 'volcanic',
          timestamp: item.timestamp,
          location: item.volcanoName,
          measurement: {
            alertLevel: item.alertLevel,
            colorCode: item.colorCode,
            volcanoId: item.volcanoId,
            observatoryCode: item.observatoryCode,
          },
          source: item.source,
          priority: item.alertLevel === 'WARNING' || item.alertLevel === 'WATCH' ? 'high' : 'normal',
          family: 'volcanic_activity',
          providerId: 'usgs_volcanoes',
          datasetId: 'usgs_volcano_alerts',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching volcano data:', error)
    }
    return data
  }
}

// ─── Upper Atmosphere Worker ─────────────────────────────────────────────────

export class UpperAtmosphereWorker extends BaseWorker {
  constructor() {
    super('UpperAtmosphere-IGRA')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.igra2_soundings?.cadence.intervalMs || 12 * 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.igra2_soundings
    if (!config?.enabled) return []

    const data: EnvironmentalData[] = []
    try {
      const batch = await collectUpperAtmosphereData()
      for (const item of batch) {
        data.push({
          type: 'upper-atmosphere',
          timestamp: item.timestamp,
          location: item.stationId,
          measurement: {
            numLevels: item.numLevels,
            surfacePressure: item.surfacePressure,
            surfaceTemperature: item.surfaceTemperature,
            surfaceDewpoint: item.surfaceDewpoint,
          },
          source: item.source,
          priority: 'normal',
          family: 'upper_atmosphere',
          providerId: 'igra2',
          datasetId: 'igra2_soundings',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          stationId: item.stationId,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching upper atmosphere data:', error)
    }
    return data
  }
}

// ─── openSenseMap Worker ─────────────────────────────────────────────────────

export class OpenSenseMapWorker extends BaseWorker {
  constructor() {
    super('OpenSenseMap')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.opensensemap_boxes?.cadence.intervalMs || 15 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.opensensemap_boxes
    if (!config?.enabled) return []

    const { collectOpenSenseMapData } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectOpenSenseMapData(config.chunkSize || 500)
      for (const item of batch) {
        data.push({
          type: 'air-quality',
          timestamp: item.timestamp,
          location: item.boxName,
          measurement: {
            temperature: item.temperature,
            humidity: item.humidity,
            pressure: item.pressure,
            pm25: item.pm25,
            pm10: item.pm10,
            uvIntensity: item.uvIntensity,
            illuminance: item.illuminance,
            aqi: 0, pm25_val: item.pm25, pm10_val: item.pm10, co: 0, no2: 0, o3: 0,
          },
          source: item.source,
          priority: 'normal',
          family: 'air_quality',
          providerId: 'opensensemap',
          datasetId: 'opensensemap_boxes',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          stationId: item.boxId,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching openSenseMap data:', error)
    }
    return data
  }
}

// ─── INTERMAGNET Worker ──────────────────────────────────────────────────────

export class IntermagnetWorker extends BaseWorker {
  constructor() {
    super('INTERMAGNET')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.intermagnet_observatories?.cadence.intervalMs || 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.intermagnet_observatories
    if (!config?.enabled) return []

    const { collectIntermagnetData } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectIntermagnetData()
      for (const item of batch) {
        data.push({
          type: 'geomagnetism',
          timestamp: item.timestamp,
          location: item.observatory,
          measurement: { x: item.x, y: item.y, z: item.z, f: item.f },
          source: item.source,
          priority: 'normal',
          family: 'geomagnetism',
          providerId: 'intermagnet',
          datasetId: 'intermagnet_observatories',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          stationId: item.observatory,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching INTERMAGNET data:', error)
    }
    return data
  }
}

// ─── IRIS EarthScope Worker ──────────────────────────────────────────────────

export class IrisWorker extends BaseWorker {
  constructor() {
    super('IRIS-EarthScope')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.iris_events?.cadence.intervalMs || 15 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.iris_events
    if (!config?.enabled) return []

    const { collectIrisEvents } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectIrisEvents(60, config.chunkSize || 500)
      for (const item of batch) {
        data.push({
          type: 'seismic',
          timestamp: item.timestamp,
          location: item.location,
          measurement: {
            magnitude: item.magnitude,
            depth: item.depth,
            latitude: item.latitude,
            longitude: item.longitude,
          },
          source: item.source,
          priority: item.magnitude >= 5 ? 'high' : 'normal',
          family: 'seismic_activity',
          providerId: 'iris',
          datasetId: 'iris_events',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          eventId: item.eventId,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching IRIS events:', error)
    }
    return data
  }
}

// ─── NASA POWER Worker ───────────────────────────────────────────────────────

export class NasaPowerWorker extends BaseWorker {
  constructor() {
    super('NASA-POWER')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.nasa_power_points?.cadence.intervalMs || 12 * 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.nasa_power_points
    if (!config?.enabled) return []

    const { collectNasaPowerData } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectNasaPowerData()
      for (const item of batch) {
        data.push({
          type: 'advanced',
          timestamp: item.timestamp,
          location: `${item.latitude.toFixed(1)},${item.longitude.toFixed(1)}`,
          measurement: {
            temperature_c: item.temperature2m,
            humidity_pct: item.relativeHumidity2m,
            wind_kph: item.windSpeed10m != null ? item.windSpeed10m * 3.6 : null,
            precipitation_mm: item.precipitation,
            solar_irradiance_wm2: item.solarIrradiance,
            pressure_mb: item.surfacePressure != null ? item.surfacePressure / 100 : null,
            uv_index: 0, soil_moisture: 0, wildfire_risk: 0, environmental_quality_score: 0,
          },
          source: item.source,
          priority: 'normal',
          family: 'advanced_metrics',
          providerId: 'nasa_power',
          datasetId: 'nasa_power_points',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching NASA POWER data:', error)
    }
    return data
  }
}

// ─── Copernicus CAMS Worker ──────────────────────────────────────────────────

export class CopernicusCamsWorker extends BaseWorker {
  constructor() {
    super('Copernicus-CAMS')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.copernicus_cams_grids?.cadence.intervalMs || 6 * 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.copernicus_cams_grids
    if (!config?.enabled) return []

    const { collectCamsData } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectCamsData()
      for (const item of batch) {
        data.push({
          type: 'air-quality',
          timestamp: item.timestamp,
          location: `${item.latitude.toFixed(1)},${item.longitude.toFixed(1)}`,
          measurement: {
            pm25: item.pm25 ?? 0, pm10: item.pm10 ?? 0,
            o3: item.ozone ?? 0, no2: item.no2 ?? 0,
            so2: item.so2 ?? 0, co: item.co ?? 0, aqi: 0,
          },
          source: item.source,
          priority: 'normal',
          family: 'air_quality',
          providerId: 'copernicus_cams',
          datasetId: 'copernicus_cams_grids',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching Copernicus CAMS data:', error)
    }
    return data
  }
}

// ─── USGS Water Worker ───────────────────────────────────────────────────────

export class UsgsWaterWorker extends BaseWorker {
  constructor() {
    super('USGS-Water')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.usgs_water_sites?.cadence.intervalMs || 15 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.usgs_water_sites
    if (!config?.enabled) return []

    const { collectUsgsWaterData } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectUsgsWaterData(config.chunkSize || 500)
      for (const item of batch) {
        data.push({
          type: 'hydrology',
          timestamp: item.timestamp,
          location: item.siteName,
          measurement: {
            discharge_cfs: item.dischargeCfs,
            gage_height_ft: item.gageHeightFt,
            water_temperature_c: item.waterTemperatureC,
            dissolved_oxygen_mg_l: item.dissolvedOxygenMgL,
            specific_conductance: item.specificConductance,
            ph: item.ph,
            turbidity_ntu: item.turbidityNtu,
          },
          source: item.source,
          priority: 'normal',
          family: 'hydrology',
          providerId: 'usgs_water',
          datasetId: 'usgs_water_sites',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          stationId: item.siteId,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching USGS Water data:', error)
    }
    return data
  }
}

// ─── UK EA Flood Worker ──────────────────────────────────────────────────────

export class UkEaFloodWorker extends BaseWorker {
  constructor() {
    super('UK-EA-Flood')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.uk_ea_flood_warnings?.cadence.intervalMs || 15 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const warningConfig = datasetConfigs.uk_ea_flood_warnings
    const readingConfig = datasetConfigs.uk_ea_flood_readings
    if (!warningConfig?.enabled && !readingConfig?.enabled) return []

    const { collectUkEaFloodWarnings, collectUkEaFloodReadings } = await import('./data-collector')
    const data: EnvironmentalData[] = []

    try {
      if (warningConfig?.enabled) {
        const warnings = await collectUkEaFloodWarnings()
        for (const w of warnings) {
          data.push({
            type: 'flood',
            timestamp: w.timestamp,
            location: w.floodArea || w.county,
            measurement: {
              severity_level: w.severityLevel,
              flood_area: w.floodArea,
              is_raised: w.isRaised,
              description: w.description,
            },
            source: w.source,
            priority: w.severityLevel <= 2 ? 'high' : 'normal',
            family: 'flood_risk',
            providerId: 'uk_ea_flood',
            datasetId: 'uk_ea_flood_warnings',
            queueLane: warningConfig.queueLane,
            maxInFlight: warningConfig.maxInFlight,
            coordinates: { lat: w.latitude, lon: w.longitude },
          })
        }
      }

      if (readingConfig?.enabled) {
        const readings = await collectUkEaFloodReadings(readingConfig.chunkSize || 500)
        for (const r of readings) {
          const hasCoordinates = Number.isFinite(r.latitude) && Number.isFinite(r.longitude)
          data.push({
            type: 'hydrology',
            timestamp: r.timestamp,
            location: r.stationName || r.riverName || r.stationRef,
            measurement: {
              river_level_m: r.riverLevelM,
              is_rising: r.isRising,
              typical_range_high: r.typicalRangeHigh,
              typical_range_low: r.typicalRangeLow,
              station_reference: r.stationRef,
              station_name: r.stationName,
              river_name: r.riverName,
              town: r.town,
              catchment_name: r.catchmentName,
              ea_area_name: r.eaAreaName,
              station_status: r.stationStatus,
              parameter: r.parameter,
              parameter_name: r.parameterName,
              qualifier: r.qualifier,
              unit_name: r.unitName,
              measure_id: r.measureId,
            },
            source: r.source,
            priority: 'normal',
            family: 'hydrology',
            providerId: 'uk_ea_flood',
            datasetId: 'uk_ea_flood_readings',
            queueLane: readingConfig.queueLane,
            maxInFlight: readingConfig.maxInFlight,
            stationId: r.stationRef,
            coordinates: hasCoordinates
              ? { lat: r.latitude as number, lon: r.longitude as number }
              : undefined,
          })
        }
      }
    } catch (error) {
      console.error('Error fetching UK EA flood data:', error)
    }
    return data
  }
}

// ─── GBIF Worker ─────────────────────────────────────────────────────────────

export class GbifWorker extends BaseWorker {
  constructor() {
    super('GBIF')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.gbif_occurrences?.cadence.intervalMs || 30 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.gbif_occurrences
    if (!config?.enabled) return []

    const { collectGbifOccurrences } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectGbifOccurrences(config.chunkSize || 300)
      for (const item of batch) {
        data.push({
          type: 'biodiversity',
          timestamp: item.timestamp,
          location: item.locality || item.country || `${item.latitude.toFixed(2)},${item.longitude.toFixed(2)}`,
          measurement: {
            species: item.species,
            scientific_name: item.scientificName,
            kingdom: item.kingdom,
            phylum: item.phylum,
            observation_count: 1,
            locality: item.locality,
            event_date: item.eventDate,
            recorded_by: item.recordedBy,
            institution_code: item.institutionCode,
            taxon_rank: item.taxonRank,
            accepted_scientific_name: item.acceptedScientificName,
            region: item.region,
            county: item.county,
            city: item.city,
            continent: item.continent,
            country_code: item.countryCode,
            catalog_number: item.catalogNumber,
            basis_of_record: item.basisOfRecord,
            dataset_name: item.datasetName,
          },
          source: item.source,
          priority: 'normal',
          family: 'biodiversity',
          providerId: 'gbif',
          datasetId: 'gbif_occurrences',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching GBIF data:', error)
    }
    return data
  }
}

// ─── iNaturalist Worker ──────────────────────────────────────────────────────

export class INaturalistWorker extends BaseWorker {
  constructor() {
    super('iNaturalist')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.inaturalist_observations?.cadence.intervalMs || 30 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.inaturalist_observations
    if (!config?.enabled) return []

    const { collectINaturalistObservations } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectINaturalistObservations(config.chunkSize || 200)
      for (const item of batch) {
        data.push({
          type: 'biodiversity',
          timestamp: item.timestamp,
          location: item.placeGuess || `${item.latitude.toFixed(2)},${item.longitude.toFixed(2)}`,
          measurement: {
            species: item.species,
            scientific_name: item.scientificName,
            taxon_rank: item.taxonRank,
            iconic_taxon: item.iconicTaxon,
            quality_grade: item.qualityGrade,
            observation_count: 1,
            description: item.description,
            captive: item.captive,
            threatened: item.threatened,
            endemic: item.endemic,
            introduced: item.introduced,
            observed_on_string: item.observedOnString,
            positional_accuracy_m: item.positionalAccuracy,
            photo_url: item.photoUrl,
            identifications_count: item.identificationsCount,
            num_identification_agreements: item.numIdentificationAgreements,
          },
          source: item.source,
          priority: 'normal',
          family: 'biodiversity',
          providerId: 'inaturalist',
          datasetId: 'inaturalist_observations',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching iNaturalist data:', error)
    }
    return data
  }
}

// ─── OBIS Worker ─────────────────────────────────────────────────────────────

export class ObisWorker extends BaseWorker {
  constructor() {
    super('OBIS')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.obis_occurrences?.cadence.intervalMs || 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.obis_occurrences
    if (!config?.enabled) return []

    const { collectObisOccurrences } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectObisOccurrences(config.chunkSize || 300)
      for (const item of batch) {
        data.push({
          type: 'biodiversity',
          timestamp: item.timestamp,
          location: item.locality || `${item.latitude.toFixed(2)},${item.longitude.toFixed(2)}`,
          measurement: {
            species: item.species,
            scientific_name: item.scientificName,
            phylum: item.phylum,
            depth: item.depth,
            observation_count: 1,
            event_date: item.eventDate,
            locality: item.locality,
            recorded_by: item.recordedBy,
            basis_of_record: item.basisOfRecord,
            dataset_name: item.datasetName,
          },
          source: item.source,
          priority: 'normal',
          family: 'biodiversity',
          providerId: 'obis',
          datasetId: 'obis_occurrences',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching OBIS data:', error)
    }
    return data
  }
}

// ─── USFWS ECOS Worker ──────────────────────────────────────────────────────

export class EcosWorker extends BaseWorker {
  constructor() {
    super('USFWS-ECOS')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.usfws_ecos_species?.cadence.intervalMs || 24 * 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.usfws_ecos_species
    if (!config?.enabled) return []

    const { collectEcosSpecies } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectEcosSpecies(config.chunkSize || 200)
      for (const item of batch) {
        data.push({
          type: 'conservation',
          timestamp: item.timestamp,
          location: item.stateRange || 'US',
          measurement: {
            species: item.commonName,
            scientific_name: item.scientificName,
            listing_status: item.listingStatus,
            family: item.family,
          },
          source: item.source,
          priority: 'normal',
          family: 'conservation_status',
          providerId: 'usfws_ecos',
          datasetId: 'usfws_ecos_species',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
        })
      }
    } catch (error) {
      console.error('Error fetching ECOS data:', error)
    }
    return data
  }
}

// ─── NatureServe Worker ──────────────────────────────────────────────────────

export class NatureServeWorker extends BaseWorker {
  constructor() {
    super('NatureServe')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.natureserve_species?.cadence.intervalMs || 24 * 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.natureserve_species
    if (!config?.enabled) return []

    const { collectNatureServeSpecies } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectNatureServeSpecies(config.chunkSize || 100)
      for (const item of batch) {
        data.push({
          type: 'conservation',
          timestamp: item.timestamp,
          location: item.nation || 'North America',
          measurement: {
            species: item.commonName,
            scientific_name: item.scientificName,
            conservation_rank: item.globalRank,
            population_trend: item.roundedGlobalRank,
          },
          source: item.source,
          priority: 'normal',
          family: 'conservation_status',
          providerId: 'natureserve',
          datasetId: 'natureserve_species',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
        })
      }
    } catch (error) {
      console.error('Error fetching NatureServe data:', error)
    }
    return data
  }
}

// ─── NASA EONET Worker ───────────────────────────────────────────────────────

export class NasaEonetWorker extends BaseWorker {
  constructor() {
    super('NASA-EONET')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.nasa_eonet_events?.cadence.intervalMs || 30 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.nasa_eonet_events
    if (!config?.enabled) return []

    const { collectNasaEonetEvents } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectNasaEonetEvents(config.chunkSize || 100)
      for (const item of batch) {
        data.push({
          type: 'natural-event',
          timestamp: item.timestamp,
          location: item.title,
          measurement: {
            event_type: item.category,
            category: item.category,
            magnitude_value: item.magnitudeValue,
            magnitude_unit: item.magnitudeUnit,
          },
          source: item.source,
          priority: 'high',
          family: 'natural_events',
          providerId: 'nasa_eonet',
          datasetId: 'nasa_eonet_events',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          eventId: item.eventId,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching NASA EONET data:', error)
    }
    return data
  }
}

// ─── GFW Worker ──────────────────────────────────────────────────────────────

export class GfwWorker extends BaseWorker {
  constructor() {
    super('Global-Forest-Watch')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.gfw_alerts?.cadence.intervalMs || 24 * 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.gfw_alerts
    if (!config?.enabled) return []

    const { collectGfwAlerts } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectGfwAlerts(config.chunkSize || 200)
      for (const item of batch) {
        data.push({
          type: 'land-use',
          timestamp: item.timestamp,
          location: item.isoCountry || `${item.latitude.toFixed(2)},${item.longitude.toFixed(2)}`,
          measurement: {
            alert_confidence: item.confidence,
            tree_cover_loss_ha: item.treeCoverLossHa,
            disturbance_type: item.alertType,
          },
          source: item.source,
          priority: 'normal',
          family: 'land_use_change',
          providerId: 'global_forest_watch',
          datasetId: 'gfw_alerts',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching GFW data:', error)
    }
    return data
  }
}

// ─── USGS MRDS Worker ────────────────────────────────────────────────────────

export class UsgsMrdsWorker extends BaseWorker {
  constructor() {
    super('USGS-MRDS')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.usgs_mrds_sites?.cadence.intervalMs || 7 * 24 * 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.usgs_mrds_sites
    if (!config?.enabled) return []

    const { collectUsgsMrdsSites } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectUsgsMrdsSites(config.chunkSize || 500)
      for (const item of batch) {
        data.push({
          type: 'mining',
          timestamp: item.timestamp,
          location: item.siteName || `${item.state}, ${item.country}`,
          measurement: {
            commodity: item.commodity,
            deposit_type: item.depositType,
            development_status: item.developmentStatus,
            site_name: item.siteName,
          },
          source: item.source,
          priority: 'normal',
          family: 'mining_activity',
          providerId: 'usgs_mrds',
          datasetId: 'usgs_mrds_sites',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching USGS MRDS data:', error)
    }
    return data
  }
}

// ─── International Planning Worker (umbrella for all planning providers) ───────

const PLANNING_COLLECTOR_MAP: Record<string, (limit: number) => Promise<Array<{
  timestamp: number
  source: string
  applicationRef?: string
  proposal?: string
  decisionDate?: string | null
  latitude?: number | null
  longitude?: number | null
  organisationEntity?: string
  entryDate?: string
  [k: string]: unknown
}>>> = {
  uk_planning: async (limit) => {
    const { collectUkPlanningApplications } = await import('./data-collector')
    return collectUkPlanningApplications(limit)
  },
  scotland_planning: async (limit) => {
    const { collectScotlandPlanningApplications } = await import('./data-collector')
    return collectScotlandPlanningApplications(limit)
  },
  nsw_planning: async (limit) => {
    const { collectNswPlanningApplications } = await import('./data-collector')
    return collectNswPlanningApplications(limit)
  },
}

export class InternationalPlanningWorker extends BaseWorker {
  constructor() {
    super('International-Planning')
  }

  protected getIntervalMs(): number {
    const planningConfigs = Object.values(datasetConfigs).filter(
      (c) => c.family === 'planning_development' && c.enabled,
    )
    const first = planningConfigs[0]
    return first?.cadence.intervalMs ?? 24 * 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const planningConfigs = Object.values(datasetConfigs).filter(
      (c) => c.family === 'planning_development' && c.enabled,
    )
    if (planningConfigs.length === 0) return []

    const data: EnvironmentalData[] = []

    for (const config of planningConfigs) {
      const collector = PLANNING_COLLECTOR_MAP[config.providerId]
      if (!collector) continue

      try {
        const batch = await collector(config.chunkSize || 200)
        for (const item of batch) {
          data.push({
            type: 'planning',
            timestamp: item.timestamp,
            location: item.applicationRef ?? item.organisationEntity ?? config.providerId,
            measurement: {
              application_ref: item.applicationRef,
              proposal: item.proposal,
              decision_date: item.decisionDate,
              status: (item as { entryDate?: string }).entryDate ? 'recorded' : null,
            },
            source: item.source,
            priority: 'normal',
            family: 'planning_development',
            providerId: config.providerId as ProviderId,
            datasetId: config.id,
            queueLane: config.queueLane,
            maxInFlight: config.maxInFlight,
            coordinates: item.latitude != null && item.longitude != null
              ? { lat: item.latitude, lon: item.longitude }
              : undefined,
          })
        }
      } catch (error) {
        console.error(`Error fetching ${config.providerId} planning data:`, error)
      }
    }

    return data
  }
}

// ─── OpenSky Worker ──────────────────────────────────────────────────────────

export class OpenSkyWorker extends BaseWorker {
  constructor() {
    super('OpenSky')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.opensky_states?.cadence.intervalMs || 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.opensky_states
    if (!config?.enabled) return []

    const { collectOpenSkyStates } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectOpenSkyStates(config.chunkSize || 1000)
      for (const item of batch) {
        data.push({
          type: 'transport',
          timestamp: item.timestamp,
          location: item.originCountry || `${item.latitude.toFixed(1)},${item.longitude.toFixed(1)}`,
          measurement: {
            icao24: item.icao24,
            callsign: item.callsign,
            origin_country: item.originCountry,
            velocity_ms: item.velocityMs,
            altitude_m: item.altitudeM,
            heading: item.heading,
            on_ground: item.onGround,
          },
          source: item.source,
          priority: 'normal',
          family: 'transport_tracking',
          providerId: 'opensky',
          datasetId: 'opensky_states',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching OpenSky data:', error)
    }
    return data
  }
}

// ─── AISStream Worker ────────────────────────────────────────────────────────

export class AisStreamWorker extends BaseWorker {
  private streamStarted = false

  constructor() {
    super('AISStream')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.aisstream_vessels?.cadence.intervalMs || 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.aisstream_vessels
    if (!config?.enabled) return []

    const { startAisStream, getAisBufferSnapshot } = await import('./data-collector')
    if (!this.streamStarted) {
      startAisStream()
      this.streamStarted = true
    }

    const data: EnvironmentalData[] = []
    try {
      const batch = getAisBufferSnapshot(config.chunkSize || 500)
      for (const item of batch) {
        data.push({
          type: 'transport',
          timestamp: item.timestamp,
          location: item.vesselName || item.mmsi,
          measurement: {
            mmsi: item.mmsi,
            vessel_name: item.vesselName,
            ship_type: item.shipType,
            heading: item.heading,
            course: item.course,
            speed: item.speed,
            destination: item.destination,
          },
          source: item.source,
          priority: 'normal',
          family: 'transport_tracking',
          providerId: 'aisstream',
          datasetId: 'aisstream_vessels',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error processing AIS data:', error)
    }
    return data
  }
}

// ─── Movebank Worker ─────────────────────────────────────────────────────────

export class MovebankWorker extends BaseWorker {
  constructor() {
    super('Movebank')
  }

  protected getIntervalMs(): number {
    return datasetConfigs.movebank_tracking?.cadence.intervalMs || 6 * 60 * 60 * 1000
  }

  protected async collectData(): Promise<EnvironmentalData[]> {
    const config = datasetConfigs.movebank_tracking
    if (!config?.enabled) return []

    const { collectMovebankTracking } = await import('./data-collector')
    const data: EnvironmentalData[] = []
    try {
      const batch = await collectMovebankTracking(config.chunkSize || 200)
      for (const item of batch) {
        data.push({
          type: 'biodiversity',
          timestamp: item.timestamp,
          location: item.taxon || item.studyName,
          measurement: {
            species: item.taxon,
            study_name: item.studyName,
            study_id: item.studyId,
            individual_id: item.individualId,
            individual_local_id: item.individualLocalId,
            altitude_m: item.altitudeM,
            ground_speed: item.groundSpeed,
            heading: item.heading,
            visible: item.visible,
            event_attributes: item.eventAttributes,
            individual_attributes: item.individualAttributes,
          },
          source: item.source,
          priority: 'normal',
          family: 'biodiversity',
          providerId: 'movebank',
          datasetId: 'movebank_tracking',
          queueLane: config.queueLane,
          maxInFlight: config.maxInFlight,
          coordinates: { lat: item.latitude, lon: item.longitude },
        })
      }
    } catch (error) {
      console.error('Error fetching Movebank data:', error)
    }
    return data
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
      const geonetWorker = new GeoNetWorker()
      const advWorker = new AdvancedMetricsWorker()
      const spaceWeatherWorker = new SpaceWeatherWorker()
      const geomagWorker = new GeomagnetismWorker()
      const volcanoWorker = new VolcanoWorker()
      const upperAtmosphereWorker = new UpperAtmosphereWorker()
      const opensensemapWorker = new OpenSenseMapWorker()
      const intermagnetWorker = new IntermagnetWorker()
      const irisWorker = new IrisWorker()
      const nasaPowerWorker = new NasaPowerWorker()
      const camsWorker = new CopernicusCamsWorker()
      const usgsWaterWorker = new UsgsWaterWorker()
      const ukEaFloodWorker = new UkEaFloodWorker()
      const gbifWorker = new GbifWorker()
      const inatWorker = new INaturalistWorker()
      const obisWorker = new ObisWorker()
      const ecosWorker = new EcosWorker()
      const natureserveWorker = new NatureServeWorker()
      const eonetWorker = new NasaEonetWorker()
      const gfwWorker = new GfwWorker()
      const mrdsWorker = new UsgsMrdsWorker()
      const openskyWorker = new OpenSkyWorker()
      const aisWorker = new AisStreamWorker()
      const movebankWorker = new MovebankWorker()
      const internationalPlanningWorker = new InternationalPlanningWorker()

      this.workers.set('waqi-environmental', waqiWorker)
      this.workers.set('noaa-weather', noaaWorker)
      this.workers.set('sensor-community-air-quality', sensorCommunityWorker)
      this.workers.set('noaa-ndbc', noaaNdbcWorker)
      this.workers.set('usgs-seismic', usgsWorker)
      this.workers.set('emsc-realtime', emscWorker)
      this.workers.set('geonet-seismic', geonetWorker)
      this.workers.set('advanced-metrics', advWorker)
      this.workers.set('space-weather', spaceWeatherWorker)
      this.workers.set('geomagnetism', geomagWorker)
      this.workers.set('volcanoes', volcanoWorker)
      this.workers.set('upper-atmosphere', upperAtmosphereWorker)
      this.workers.set('opensensemap', opensensemapWorker)
      this.workers.set('intermagnet', intermagnetWorker)
      this.workers.set('iris-earthscope', irisWorker)
      this.workers.set('nasa-power', nasaPowerWorker)
      this.workers.set('copernicus-cams', camsWorker)
      this.workers.set('usgs-water', usgsWaterWorker)
      this.workers.set('uk-ea-flood', ukEaFloodWorker)
      this.workers.set('gbif', gbifWorker)
      this.workers.set('inaturalist', inatWorker)
      this.workers.set('obis', obisWorker)
      this.workers.set('usfws-ecos', ecosWorker)
      this.workers.set('natureserve', natureserveWorker)
      this.workers.set('nasa-eonet', eonetWorker)
      this.workers.set('global-forest-watch', gfwWorker)
      this.workers.set('usgs-mrds', mrdsWorker)
      this.workers.set('opensky', openskyWorker)
      this.workers.set('aisstream', aisWorker)
      this.workers.set('movebank', movebankWorker)
      this.workers.set('international-planning', internationalPlanningWorker)

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