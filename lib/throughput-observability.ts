import type { QueueLane } from './stream-registry'

export type ThroughputStage =
  | 'provider_reads'
  | 'provider_records_emitted'
  | 'duplicate_dropped'
  | 'already_on_chain_dropped'
  | 'queue_enqueued'
  | 'queue_backpressured'
  | 'broadcast_accepted'
  | 'broadcast_failed'
  | 'confirmed'
  | 'explorer_indexed'

export interface ThroughputRecordMeta {
  family?: string | null
  providerId?: string | null
  datasetId?: string | null
  queueLane?: QueueLane | null
  channel?: string | null
  error?: string | null
  txid?: string | null
}

export interface StageCounts {
  providerReads: number
  providerRecordsEmitted: number
  duplicateDropped: number
  alreadyOnChainDropped: number
  queueEnqueued: number
  queueBackpressured: number
  broadcastAccepted: number
  broadcastFailed: number
  confirmed: number
  explorerIndexed: number
}

export interface ThroughputAggregate extends StageCounts {
  projectedAcceptedPerDay: number
  projectedConfirmedPerDay: number
  acceptanceRate: number | null
  confirmationRate: number | null
  acceptedByChannel: Record<string, number>
  failedByChannel: Record<string, number>
}

interface ParsedStageKey {
  stage: ThroughputStage
  providerId: string
  datasetId: string
  family: string
  queueLane: string
  channel: string
}

interface NormalisedMeta {
  family: string
  providerId: string
  datasetId: string
  queueLane: string
  channel: string
}

interface ProviderSnapshot extends ThroughputAggregate {
  providerId: string
  family: string | null
  queueLane: string | null
}

interface DatasetSnapshot extends ThroughputAggregate {
  providerId: string
  datasetId: string
  family: string | null
  queueLane: string | null
}

export interface ThroughputSnapshot {
  windowMinutes: number
  generatedAt: string
  overall: ThroughputAggregate
  providers: ProviderSnapshot[]
  datasets: DatasetSnapshot[]
  errors: Array<{ category: string; count: number }>
}

function emptyCounts(): StageCounts {
  return {
    providerReads: 0,
    providerRecordsEmitted: 0,
    duplicateDropped: 0,
    alreadyOnChainDropped: 0,
    queueEnqueued: 0,
    queueBackpressured: 0,
    broadcastAccepted: 0,
    broadcastFailed: 0,
    confirmed: 0,
    explorerIndexed: 0,
  }
}

function createAggregate(): ThroughputAggregate {
  return {
    ...emptyCounts(),
    projectedAcceptedPerDay: 0,
    projectedConfirmedPerDay: 0,
    acceptanceRate: null,
    confirmationRate: null,
    acceptedByChannel: {},
    failedByChannel: {},
  }
}

function applyStage(counts: StageCounts, stage: ThroughputStage, value: number): void {
  switch (stage) {
    case 'provider_reads':
      counts.providerReads += value
      break
    case 'provider_records_emitted':
      counts.providerRecordsEmitted += value
      break
    case 'duplicate_dropped':
      counts.duplicateDropped += value
      break
    case 'already_on_chain_dropped':
      counts.alreadyOnChainDropped += value
      break
    case 'queue_enqueued':
      counts.queueEnqueued += value
      break
    case 'queue_backpressured':
      counts.queueBackpressured += value
      break
    case 'broadcast_accepted':
      counts.broadcastAccepted += value
      break
    case 'broadcast_failed':
      counts.broadcastFailed += value
      break
    case 'confirmed':
      counts.confirmed += value
      break
    case 'explorer_indexed':
      counts.explorerIndexed += value
      break
  }
}

function finaliseAggregate<T extends ThroughputAggregate>(aggregate: T, windowMinutes: number): T {
  const safeWindow = Math.max(1, windowMinutes)
  aggregate.projectedAcceptedPerDay = Math.round(aggregate.broadcastAccepted * (1440 / safeWindow))
  aggregate.projectedConfirmedPerDay = Math.round(aggregate.confirmed * (1440 / safeWindow))
  aggregate.acceptanceRate = aggregate.providerRecordsEmitted > 0
    ? Number((aggregate.broadcastAccepted / aggregate.providerRecordsEmitted).toFixed(4))
    : null
  aggregate.confirmationRate = aggregate.broadcastAccepted > 0
    ? Number((aggregate.confirmed / aggregate.broadcastAccepted).toFixed(4))
    : null
  return aggregate
}

function classifyError(error: string | null | undefined): string {
  const safe = String(error || '').toUpperCase()
  if (!safe) return 'unknown'
  if (safe.includes('MEMPOOL_CHAIN_LIMIT')) return 'mempool_chain_limit'
  if (safe.includes('DOUBLE_SPEND') || safe.includes('TXN-MEMPOOL-CONFLICT') || safe.includes('MEMPOOL_CONFLICT')) return 'double_spend_or_conflict'
  if (safe.includes('NO UTXO') || safe.includes('NO RESERVABLE UTXO')) return 'no_utxos'
  if (safe.includes('HEAP_PRESSURE_BACKOFF')) return 'heap_pressure_backoff'
  if (safe.includes('429') || safe.includes('RATE LIMIT')) return 'rate_limited'
  if (safe.includes('MISSING INPUT')) return 'missing_inputs'
  if (safe.includes('ARC')) return 'arc_rejection'
  return 'other'
}

class ThroughputObservability {
  private readonly bucketMs = 60 * 1000
  private readonly retentionMs = 24 * 60 * 60 * 1000
  private readonly txRetentionMs = 48 * 60 * 60 * 1000
  private readonly stageBuckets = new Map<number, Map<string, number>>()
  private readonly errorBuckets = new Map<number, Map<string, number>>()
  private readonly txMetaByTxid = new Map<string, { meta: NormalisedMeta; acceptedAt: number }>()

  private normaliseMeta(meta: ThroughputRecordMeta): NormalisedMeta {
    return {
      family: String(meta.family || 'unknown').trim() || 'unknown',
      providerId: String(meta.providerId || 'unknown').trim() || 'unknown',
      datasetId: String(meta.datasetId || '-').trim() || '-',
      queueLane: meta.queueLane === 'throughput' || meta.queueLane === 'coverage' ? meta.queueLane : 'unknown',
      channel: String(meta.channel || 'n/a').trim().toLowerCase() || 'n/a',
    }
  }

  private bucketStart(ts: number = Date.now()): number {
    return Math.floor(ts / this.bucketMs) * this.bucketMs
  }

  private stageKey(stage: ThroughputStage, meta: NormalisedMeta): string {
    return [stage, meta.providerId, meta.datasetId, meta.family, meta.queueLane, meta.channel].join('|')
  }

  private parseStageKey(key: string): ParsedStageKey {
    const [stage, providerId, datasetId, family, queueLane, channel] = key.split('|')
    return {
      stage: stage as ThroughputStage,
      providerId: providerId || 'unknown',
      datasetId: datasetId || '-',
      family: family || 'unknown',
      queueLane: queueLane || 'unknown',
      channel: channel || 'n/a',
    }
  }

  private cleanup(now: number = Date.now()): void {
    const minBucket = this.bucketStart(now - this.retentionMs)
    for (const bucket of this.stageBuckets.keys()) {
      if (bucket < minBucket) this.stageBuckets.delete(bucket)
    }
    for (const bucket of this.errorBuckets.keys()) {
      if (bucket < minBucket) this.errorBuckets.delete(bucket)
    }
    const minTxTs = now - this.txRetentionMs
    for (const [txid, state] of this.txMetaByTxid.entries()) {
      if (state.acceptedAt < minTxTs) this.txMetaByTxid.delete(txid)
    }
  }

  private incrementStage(stage: ThroughputStage, meta: ThroughputRecordMeta, count: number = 1, ts: number = Date.now()): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.cleanup(ts)
    const bucket = this.bucketStart(ts)
    const normalised = this.normaliseMeta(meta)
    const key = this.stageKey(stage, normalised)
    let bucketEntries = this.stageBuckets.get(bucket)
    if (!bucketEntries) {
      bucketEntries = new Map<string, number>()
      this.stageBuckets.set(bucket, bucketEntries)
    }
    bucketEntries.set(key, (bucketEntries.get(key) || 0) + count)
  }

  private incrementError(error: string | null | undefined, count: number = 1, ts: number = Date.now()): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.cleanup(ts)
    const bucket = this.bucketStart(ts)
    let bucketEntries = this.errorBuckets.get(bucket)
    if (!bucketEntries) {
      bucketEntries = new Map<string, number>()
      this.errorBuckets.set(bucket, bucketEntries)
    }
    const category = classifyError(error)
    bucketEntries.set(category, (bucketEntries.get(category) || 0) + count)
  }

  public recordProviderBatch(meta: ThroughputRecordMeta, recordCount: number, readCount: number = 1): void {
    if (readCount > 0) this.incrementStage('provider_reads', meta, readCount)
    if (recordCount > 0) this.incrementStage('provider_records_emitted', meta, recordCount)
  }

  public recordDuplicateDropped(meta: ThroughputRecordMeta, count: number = 1): void {
    this.incrementStage('duplicate_dropped', meta, count)
  }

  public recordAlreadyOnChainDropped(meta: ThroughputRecordMeta, count: number = 1): void {
    this.incrementStage('already_on_chain_dropped', meta, count)
  }

  public recordQueueEnqueued(meta: ThroughputRecordMeta, count: number = 1): void {
    this.incrementStage('queue_enqueued', meta, count)
  }

  public recordQueueBackpressured(meta: ThroughputRecordMeta, count: number = 1): void {
    this.incrementStage('queue_backpressured', meta, count)
  }

  public recordBroadcastAccepted(meta: ThroughputRecordMeta): void {
    const now = Date.now()
    this.incrementStage('broadcast_accepted', meta, 1, now)
    if (meta.txid) {
      this.txMetaByTxid.set(meta.txid, {
        meta: this.normaliseMeta(meta),
        acceptedAt: now,
      })
    }
  }

  public recordBroadcastFailed(meta: ThroughputRecordMeta): void {
    const now = Date.now()
    this.incrementStage('broadcast_failed', meta, 1, now)
    this.incrementError(meta.error, 1, now)
  }

  public recordConfirmed(txid: string, meta: ThroughputRecordMeta = {}): void {
    const remembered = this.txMetaByTxid.get(txid)
    const merged: ThroughputRecordMeta = remembered
      ? {
          family: meta.family || remembered.meta.family,
          providerId: meta.providerId || remembered.meta.providerId,
          datasetId: meta.datasetId || remembered.meta.datasetId,
          queueLane: (meta.queueLane as QueueLane | null | undefined) || (remembered.meta.queueLane as QueueLane | null | undefined),
          channel: meta.channel || remembered.meta.channel,
        }
      : meta
    this.incrementStage('confirmed', { ...merged, txid }, 1)
  }

  public recordExplorerIndexed(meta: ThroughputRecordMeta, count: number = 1): void {
    this.incrementStage('explorer_indexed', meta, count)
  }

  public getSnapshot(windowMinutes: number = 60): ThroughputSnapshot {
    const now = Date.now()
    this.cleanup(now)
    const safeWindowMinutes = Math.max(1, Math.floor(windowMinutes))
    const cutoff = now - (safeWindowMinutes * this.bucketMs)
    const overall = createAggregate()
    const providerMap = new Map<string, ProviderSnapshot>()
    const datasetMap = new Map<string, DatasetSnapshot>()

    for (const [bucket, entries] of this.stageBuckets.entries()) {
      if (bucket < cutoff) continue
      for (const [key, count] of entries.entries()) {
        const parsed = this.parseStageKey(key)
        applyStage(overall, parsed.stage, count)

        if (parsed.stage === 'broadcast_accepted') {
          overall.acceptedByChannel[parsed.channel] = (overall.acceptedByChannel[parsed.channel] || 0) + count
        } else if (parsed.stage === 'broadcast_failed') {
          overall.failedByChannel[parsed.channel] = (overall.failedByChannel[parsed.channel] || 0) + count
        }

        const provider = providerMap.get(parsed.providerId) || {
          providerId: parsed.providerId,
          family: parsed.family === 'unknown' ? null : parsed.family,
          queueLane: parsed.queueLane === 'unknown' ? null : parsed.queueLane,
          ...createAggregate(),
        }
        applyStage(provider, parsed.stage, count)
        if (parsed.stage === 'broadcast_accepted') {
          provider.acceptedByChannel[parsed.channel] = (provider.acceptedByChannel[parsed.channel] || 0) + count
        } else if (parsed.stage === 'broadcast_failed') {
          provider.failedByChannel[parsed.channel] = (provider.failedByChannel[parsed.channel] || 0) + count
        }
        providerMap.set(parsed.providerId, provider)

        if (parsed.datasetId !== '-') {
          const datasetKey = `${parsed.providerId}:${parsed.datasetId}`
          const dataset = datasetMap.get(datasetKey) || {
            providerId: parsed.providerId,
            datasetId: parsed.datasetId,
            family: parsed.family === 'unknown' ? null : parsed.family,
            queueLane: parsed.queueLane === 'unknown' ? null : parsed.queueLane,
            ...createAggregate(),
          }
          applyStage(dataset, parsed.stage, count)
          if (parsed.stage === 'broadcast_accepted') {
            dataset.acceptedByChannel[parsed.channel] = (dataset.acceptedByChannel[parsed.channel] || 0) + count
          } else if (parsed.stage === 'broadcast_failed') {
            dataset.failedByChannel[parsed.channel] = (dataset.failedByChannel[parsed.channel] || 0) + count
          }
          datasetMap.set(datasetKey, dataset)
        }
      }
    }

    const errors = new Map<string, number>()
    for (const [bucket, entries] of this.errorBuckets.entries()) {
      if (bucket < cutoff) continue
      for (const [category, count] of entries.entries()) {
        errors.set(category, (errors.get(category) || 0) + count)
      }
    }

    return {
      windowMinutes: safeWindowMinutes,
      generatedAt: new Date(now).toISOString(),
      overall: finaliseAggregate(overall, safeWindowMinutes),
      providers: Array.from(providerMap.values())
        .map(provider => finaliseAggregate(provider, safeWindowMinutes))
        .sort((left, right) => right.broadcastAccepted - left.broadcastAccepted),
      datasets: Array.from(datasetMap.values())
        .map(dataset => finaliseAggregate(dataset, safeWindowMinutes))
        .sort((left, right) => right.broadcastAccepted - left.broadcastAccepted),
      errors: Array.from(errors.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((left, right) => right.count - left.count),
    }
  }
}

const _g = globalThis as any
if (!_g.__GAIALOG_THROUGHPUT_OBSERVABILITY__) {
  _g.__GAIALOG_THROUGHPUT_OBSERVABILITY__ = new ThroughputObservability()
}

export const throughputObservability: ThroughputObservability = _g.__GAIALOG_THROUGHPUT_OBSERVABILITY__
