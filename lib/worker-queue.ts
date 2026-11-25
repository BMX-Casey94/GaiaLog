import type { BSVTransactionData } from './bsv-transaction-service'
import {
  blockchainService,
  isEndpointBackoffError,
  isFeeTooLowBroadcastError,
  isTerminalBroadcastError,
} from './blockchain'
import { bsvConfig } from './bsv-config'
import { walletManager } from './wallet-manager'
import { setAdvancedTxId, setAirQualityTxId, setSeismicTxId, setWaterLevelTxId, hasAirQualityTxId, hasWaterLevelTxId, hasSeismicTxId, hasAdvancedTxId, hasWrittenReading, recordWrittenReading } from './repositories'
import { ensureQueueTable, enqueueQueueItem, claimPendingQueueItems, reclaimStuckQueueItems, markQueueItemCompleted, markQueueItemFailed, markQueueItemsProcessing, requeueQueueItem, cleanupOldFailedItems, setQueueItemBroadcastTxid } from './queue-repository'
import { getMutatorControlState, logMutatorSkip } from './mutator-control'
import { getOverlayFallbackConfig } from './overlay-config'
import { getSpendSourceForWallet, getTreasuryTopicForWallet } from './spend-source'
import { getQueueGateMinConfirmations } from './utxo-spend-policy'
import { normaliseDataFamily, resolveSourceLabel } from './stream-registry'
import { throughputObservability } from './throughput-observability'
import { isWritePausedForFunding } from './write-dry-mode'

/**
 * A broadcast txid: 32 bytes as 64 hex characters.
 *
 * Used to gate `markQueueItemCompleted`. The blockchain service used to return
 * the sentinel string 'blockchain-not-configured' when no signing key was
 * present, and any non-empty string was accepted as a completed broadcast —
 * so readings were marked on-chain without a transaction existing.
 */
const TXID_PATTERN = /^[0-9a-fA-F]{64}$/

/**
 * Upper bound on the in-memory failed-item list.
 *
 * Nothing drains it: a failed item is retained for the lifetime of the process
 * for diagnostics only. At production failure rates that is unbounded growth in
 * the same process the heap guard is trying to keep stable.
 */
const MAX_FAILED_ITEMS_IN_MEMORY = 500

export interface QueueItem {
  id: string
  priority: 'high' | 'normal'
  lane: 'throughput' | 'coverage'
  data: BSVTransactionData
  timestamp: number
  retryCount: number
  maxRetries: number
  /**
   * True when this row is already owned by this worker in the database, so the
   * batch must not try to claim it again. Hydration claims on the way in;
   * anything added directly by addToQueue is not yet owned and is claimed at
   * process time.
   */
  dbClaimed?: boolean
}

export interface QueueStats {
  totalItems: number
  highPriorityItems: number
  normalPriorityItems: number
  throughputLaneItems: number
  coverageLaneItems: number
  processingItems: number
  completedItems: number
  failedItems: number
  processingRate: number
  averageWaitTime: number
  errorRate: number
}

export interface QueueGateInfo {
  paused: boolean
  minRequired: number
  minConfirmed: number
  okWallets: number
  totalWallets: number
  source: 'legacy' | 'overlay'
  wallets: Array<{
    walletIndex: number
    walletLabel: string
    address: string
    confirmed: number
  }>
}

export class WorkerQueue {
  private highPriorityQueue: QueueItem[] = []
  private normalPriorityQueue: QueueItem[] = []
  private processingQueue: QueueItem[] = []
  /**
   * Count of completed items, not a list of them.
   *
   * This was a `QueueItem[]` that nothing ever pruned, so every successful
   * broadcast retained its full payload for the lifetime of the process. At the
   * measured collection rate (~158k readings/day) that is hundreds of MB per
   * day, which matches the heap-pressure backoff the worker already implements
   * and the "runs for a few days then stalls" pattern reported in production.
   * Only the count is ever read (getQueueStats, getQueueStatus), so the retained
   * payloads served no purpose.
   */
  private completedCount = 0
  private failedItems: QueueItem[] = []
  private lastServedHighLane: 'throughput' | 'coverage' = 'coverage'
  private lastServedNormalLane: 'throughput' | 'coverage' = 'coverage'
  private backpressureLogAt = new Map<string, number>()
  private isProcessing = false
  private isProcessQueueRunning = false
  private processingInterval: NodeJS.Timeout | null = null
  private cleanupInterval: NodeJS.Timeout | null = null
  private stats = {
    totalProcessed: 0,
    totalFailed: 0,
    totalRetries: 0,
    startTime: Date.now(),
    lastProcessedTime: Date.now()
  }
  private lastUtxoGateCheckedAt = 0
  private lastUtxoGateOk = true
  private lastUtxoPauseLogAt = 0
  private lastProcessQueueSkipLogAt = 0
  private queueSkipLogAtByReason = new Map<string, number>()
  private utxoPauseState: 'ok' | 'paused' = 'ok'
  private queuedCountSinceLastSample = 0
  private processedCountSinceLastSample = 0
  private failedCountSinceLastSample = 0
  private retryScheduledCount = 0
  private lastGateInfo: QueueGateInfo = {
    paused: false,
    minRequired: 0,
    minConfirmed: 0,
    okWallets: 0,
    totalWallets: 0,
    source: 'legacy',
    wallets: [],
  }

  constructor() {
    // Don't auto-start processing - let it be started manually when needed
  }

  private getLane(data: BSVTransactionData): 'throughput' | 'coverage' {
    return data.queueLane === 'throughput' ? 'throughput' : 'coverage'
  }

  private countItemsForScope(data: BSVTransactionData): number {
    const datasetId = data.datasetId
    const providerId = data.providerId
    const match = (item: QueueItem) => {
      if (datasetId) return item.data.datasetId === datasetId
      if (providerId) return item.data.providerId === providerId
      return false
    }
    return [
      ...this.highPriorityQueue,
      ...this.normalPriorityQueue,
      ...this.processingQueue,
    ].filter(match).length
  }

  private canAcceptItem(data: BSVTransactionData): boolean {
    const maxInFlight = data.maxInFlight
    if (!maxInFlight || maxInFlight <= 0) return true
    const current = this.countItemsForScope(data)
    if (current < maxInFlight) return true

    const scopeKey = data.datasetId || data.providerId || 'unknown'
    const now = Date.now()
    const lastLog = this.backpressureLogAt.get(scopeKey) || 0
    if (now - lastLog > 30000) {
      console.warn(`⏸️ Queue backpressure: holding ${scopeKey} at ${current}/${maxInFlight} in-flight items`)
      this.backpressureLogAt.set(scopeKey, now)
    }
    return false
  }

  private takeNextItem(queue: QueueItem[], priority: 'high' | 'normal'): QueueItem | null {
    if (queue.length === 0) return null
    const lastLane = priority === 'high' ? this.lastServedHighLane : this.lastServedNormalLane
    const preferredLane = lastLane === 'coverage' ? 'throughput' : 'coverage'
    const preferredIndex = queue.findIndex(item => item.lane === preferredLane)
    const index = preferredIndex >= 0 ? preferredIndex : 0
    const [item] = queue.splice(index, 1)
    if (priority === 'high') this.lastServedHighLane = item.lane
    else this.lastServedNormalLane = item.lane
    return item || null
  }

  public addToQueue(data: BSVTransactionData, priority: 'high' | 'normal' = 'normal'): string | null {
    // Global queue ceiling. bsvConfig.queue.maxQueueSize was parsed from
    // BSV_MAX_QUEUE_SIZE but never enforced anywhere, which is how a funding
    // outage grew worker_queue without bound — it reached 3.1M rows / 3.3 GB
    // with nothing able to drain it, and once the backlog dominated the table
    // the hydration and retention statements could no longer complete at all.
    // Bounding the in-memory queues bounds the table, because every enqueue
    // persists a row, and it costs no extra query on this hot path.
    const queuedTotal =
      this.highPriorityQueue.length +
      this.normalPriorityQueue.length +
      this.processingQueue.length
    if (queuedTotal >= bsvConfig.queue.maxQueueSize) {
      if (this.shouldLogQueueSkip('maxQueueSize')) {
        console.warn(
          `⏸️ Queue at capacity (${queuedTotal}/${bsvConfig.queue.maxQueueSize}); rejecting enqueue`,
        )
      }
      throughputObservability.recordQueueBackpressured({
        family: data.family,
        providerId: data.providerId,
        datasetId: data.datasetId,
        queueLane: data.queueLane,
      })
      return null
    }
    if (!this.canAcceptItem(data)) {
      throughputObservability.recordQueueBackpressured({
        family: data.family,
        providerId: data.providerId,
        datasetId: data.datasetId,
        queueLane: data.queueLane,
      })
      return null
    }
    const id = this.generateItemId(data)
    const item: QueueItem = {
      id,
      priority,
      lane: this.getLane(data),
      data,
      timestamp: Date.now(),
      retryCount: 0,
      maxRetries: bsvConfig.transaction.maxRetries,
      // Not yet owned in the DB; processQueue claims it before it is used.
      dbClaimed: false,
    }

    if (priority === 'high') {
      this.highPriorityQueue.push(item)
    } else {
      this.normalPriorityQueue.push(item)
    }

    // Persist to DB so the queue survives restarts
    enqueueQueueItem({ id, priority, data, timestamp: item.timestamp, retry_count: 0, max_retries: item.maxRetries }).catch(() => {})
    this.queuedCountSinceLastSample++
    throughputObservability.recordQueueEnqueued({
      family: data.family,
      providerId: data.providerId,
      datasetId: data.datasetId,
      queueLane: data.queueLane,
    })
    if (bsvConfig.logging.level === 'debug') {
      console.log(`📥 Added ${priority}/${item.lane} queue item: ${id}`)
    }
    return id
  }

  public getQueueStats(): QueueStats {
    const now = Date.now()
    const totalItems = this.highPriorityQueue.length + this.normalPriorityQueue.length + this.processingQueue.length
    const throughputLaneItems = [
      ...this.highPriorityQueue,
      ...this.normalPriorityQueue,
      ...this.processingQueue,
    ].filter(item => item.lane === 'throughput').length
    const coverageLaneItems = totalItems - throughputLaneItems
    
    const processingRate = this.stats.totalProcessed > 0 
      ? this.stats.totalProcessed / ((now - this.stats.startTime) / 1000)
      : 0

    // Wait time was previously computed as `item.timestamp - item.timestamp`,
    // which is always zero. Nothing records enqueue time on the item, so this
    // stays zero rather than presenting a fabricated measurement.
    const averageWaitTime = 0

    const errorRate = this.stats.totalProcessed > 0
      ? this.stats.totalFailed / this.stats.totalProcessed
      : 0

    return {
      totalItems,
      highPriorityItems: this.highPriorityQueue.length,
      normalPriorityItems: this.normalPriorityQueue.length,
      throughputLaneItems,
      coverageLaneItems,
      processingItems: this.processingQueue.length,
      completedItems: this.completedCount,
      failedItems: this.failedItems.length,
      processingRate,
      averageWaitTime,
      errorRate
    }
  }

  public getQueueStatus(): {
    highPriority: number
    normalPriority: number
    processing: number
    completed: number
    failed: number
  } {
    return {
      highPriority: this.highPriorityQueue.length,
      normalPriority: this.normalPriorityQueue.length,
      processing: this.processingQueue.length,
      completed: this.completedCount,
      failed: this.failedItems.length
    }
  }

  public startProcessing(): void {
    const mutatorControl = getMutatorControlState()
    if (!mutatorControl.mutatorsEnabled) {
      logMutatorSkip('worker-queue')
      return
    }
    if (this.isProcessing) return

    this.isProcessing = true
    console.log('🔄 Starting worker queue processing...')

    // Reclaim items abandoned by a previous run, then atomically claim work for
    // this worker. Claiming rather than reading means two workers can never load
    // the same item; see claimPendingQueueItems for why the predicate is a single
    // status and why the old form could not complete.
    const hydrate = async (): Promise<boolean> => {
      const reclaimed = await reclaimStuckQueueItems()
      if (reclaimed > 0) {
        console.log(`♻️  Reclaimed ${reclaimed} stuck processing item(s)`)
      }
      // Claiming while writes are paused would park rows in `processing` that
      // this worker will not act on, and a later worker start would reclaim and
      // double-hold them. Wait for funding instead.
      if (isWritePausedForFunding()) {
        console.warn('⏸️  Deferring queue claim: writes paused (wallet funding dry)')
        return false
      }
      const claimed = await claimPendingQueueItems()
      // The DB returns them oldest-first; push preserving priority per row.
      for (const r of claimed) {
        const q: QueueItem = {
          id: r.id,
          priority: (r.priority === 'high' ? 'high' : 'normal'),
          lane: ((r.data as any)?.queueLane === 'throughput' ? 'throughput' : 'coverage'),
          data: r.data as any,
          timestamp: Number(r.timestamp) || Date.now(),
          retryCount: Number(r.retry_count) || 0,
          maxRetries: Number(r.max_retries) || bsvConfig.transaction.maxRetries,
          // claimPendingQueueItems has already moved these rows to processing.
          dbClaimed: true,
        }
        if (q.priority === 'high') this.highPriorityQueue.push(q)
        else this.normalPriorityQueue.push(q)
      }
      console.log(`💾 Claimed ${claimed.length} queued item(s) from DB`)
      return true
    }

    ensureQueueTable().then(async () => {
      try {
        if (await hydrate()) return
        // Funding outage: retry until the wallet holds spendable inventory again.
        const retry = setInterval(() => {
          hydrate()
            .then((done) => { if (done) clearInterval(retry) })
            .catch((e) => console.warn('Queue claim error:', e))
        }, 60_000)
      } catch (e) {
        console.warn('Queue hydration error:', e)
      }
    }).catch(() => {})

    this.processingInterval = setInterval(async () => {
      await this.processQueue()
    }, bsvConfig.queue.processingIntervalMs)

    // Periodic cleanup of old failed items (keep 24h for debugging)
    this.cleanupInterval = setInterval(async () => {
      try {
        await cleanupOldFailedItems(24)
      } catch {}
    }, 60 * 60 * 1000)

    // Run an initial delayed cleanup shortly after startup
    setTimeout(async () => {
      try {
        await cleanupOldFailedItems(24)
      } catch {}
    }, 5 * 60 * 1000)
  }

  private shouldLogQueueSkip(reason: string): boolean {
    const now = Date.now()
    const last = this.queueSkipLogAtByReason.get(reason) ?? 0
    if (now - last < 60000) return false
    this.queueSkipLogAtByReason.set(reason, now)
    return true
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessQueueRunning) {
      const totalItems = this.highPriorityQueue.length + this.normalPriorityQueue.length
      if (totalItems > 0 && this.shouldLogQueueSkip('tickAlreadyRunning')) {
        console.warn(`🔍 [queue-debug] Skipping processQueue: previous tick still running (items=${totalItems})`)
      }
      return
    }

    this.isProcessQueueRunning = true
    try {
      const totalItems = this.highPriorityQueue.length + this.normalPriorityQueue.length
      if (totalItems === 0) {
        return
      }

      // Readiness gate: writes go through `blockchainService.writeToChain`,
      // which needs a signing key and therefore a usable wallet manager.
      // `bsvTransactionService` was never on that path — it is a deprecated
      // façade kept alive only for `/api/bsv/stats`, so gating on it meant the
      // queue could stall on a service that performs no work.
      if (!walletManager.isReady()) {
        if (this.shouldLogQueueSkip('walletNotReady')) {
          console.warn(`🔍 [queue-debug] Skipping processQueue: walletManager not ready (items=${totalItems})`)
        }
        return
      }

      // Funding outage guard. Unlike the collectors (which drop and re-collect),
      // queued items are already-accepted work, so they are held in place —
      // draining them now would only convert them into failed retries.
      if (isWritePausedForFunding()) {
        if (this.shouldLogQueueSkip('writeDryMode')) {
          console.warn(
            `⏸️  [queue] holding ${totalItems} item(s): writes paused (wallet funding dry)`,
          )
        }
        return
      }

      const nowTs = Date.now()
      if (nowTs - this.lastUtxoGateCheckedAt > 30000) {
        this.lastUtxoGateCheckedAt = nowTs
        try {
          this.lastUtxoGateOk = await this.hasSufficientConfirmedUtxos()
        } catch (e) {
          this.lastUtxoGateOk = true
        }
      }
      if (!this.lastUtxoGateOk) {
        if (this.shouldLogQueueSkip('utxoGatePaused')) {
          const gate = this.lastGateInfo
          console.warn(`🔍 [queue-debug] Skipping processQueue: UTXO gate paused (items=${totalItems}, okWallets=${gate.okWallets}/${gate.totalWallets}, minConf=${gate.minConfirmed}/${gate.minRequired})`)
        }
        return
      }

      // Default 2 (matches env.template). Unset used to fall back to 25 — that deepens mempool chains and
      // triggers ARC 460 / WoC missing-inputs under overlay + parallel spends.
      const concurrency = Math.max(1, Number(process.env.BSV_QUEUE_CONCURRENCY || 2))
      const maxItemsPerBatch = Math.min(
        bsvConfig.queue.batchSize,
        bsvConfig.queue.maxTxPerSecond,
      )

      const batch: QueueItem[] = []
      while (this.highPriorityQueue.length > 0 && batch.length < maxItemsPerBatch) {
        const item = this.takeNextItem(this.highPriorityQueue, 'high')
        if (item) batch.push(item)
      }
      while (this.normalPriorityQueue.length > 0 && batch.length < maxItemsPerBatch) {
        const item = this.takeNextItem(this.normalPriorityQueue, 'normal')
        if (item) batch.push(item)
      }

      if (batch.length === 0) return

      // Rows hydrated in from the DB are already claimed. Anything pushed
      // straight into memory by addToQueue is not, so claim it here. The UPDATE
      // only matches rows still in 'queued', so if two workers collected the same
      // reading independently, exactly one of them takes it. Without this the
      // on-chain check downstream was the only thing preventing a duplicate
      // broadcast, and that check cannot see a concurrent broadcast in flight.
      const unclaimed = batch.filter(item => !item.dbClaimed)
      if (unclaimed.length > 0) {
        let ownedIds: string[]
        try {
          ownedIds = await markQueueItemsProcessing(unclaimed.map(item => item.id))
        } catch (e) {
          // Fail closed: put them back rather than risk processing without a claim.
          console.warn('Queue claim failed; returning the batch to the queue:', e)
          for (const item of unclaimed) {
            if (item.priority === 'high') this.highPriorityQueue.unshift(item)
            else this.normalPriorityQueue.unshift(item)
          }
          return
        }
        const owned = new Set(ownedIds)
        for (const item of unclaimed) {
          if (owned.has(item.id)) item.dbClaimed = true
        }
      }

      // A row another worker already claimed, or one that has already left the
      // queue, must not be processed here.
      const runnable = batch.filter(item => item.dbClaimed)
      const skipped = batch.length - runnable.length
      if (skipped > 0 && bsvConfig.logging.level === 'debug') {
        console.log(`⏭️  Skipped ${skipped} item(s) already claimed or gone`)
      }
      if (runnable.length === 0) return

      const batchStartTime = Date.now()
      let itemIndex = 0
      const workers = Array.from(
        { length: Math.min(concurrency, runnable.length) },
        async () => {
          while (true) {
            const idx = itemIndex++
            if (idx >= runnable.length) break
            await this.processItem(runnable[idx])
          }
        },
      )
      await Promise.all(workers)
      const processedCount = runnable.length

      const batchDuration = Date.now() - batchStartTime
      const minBatchDuration = (1000 / bsvConfig.queue.maxTxPerSecond) * processedCount
      if (batchDuration < minBatchDuration) {
        const delay = minBatchDuration - batchDuration
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    } finally {
      this.isProcessQueueRunning = false
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    try {
      // Use cached gate result to avoid spamming logs per item
      if (!this.lastUtxoGateOk) {
        // Requeue the item to the front to try again after maintainer tops up
        if (item.priority === 'high') {
          this.highPriorityQueue.unshift(item)
        } else {
          this.normalPriorityQueue.unshift(item)
        }
        // Keep it queued in DB (no state change)
        return
      }
      // Move to processing queue
      this.processingQueue.push(item)

      // Prefer direct on-chain write via blockchain service
      const stream = this.mapTypeToStream(item.data.family || item.data.type)
      const payload = this.buildPayloadFromItem(item)
      // Hard idempotency guard: if this reading already has a broadcast txid
      // recorded, skip it. Three sources of that record:
      //
      //   1. the queue row's own `broadcastTxid` — set the instant a broadcast
      //      returned, before the durable records below. Covers a crash in the
      //      window between the broadcast and those records.
      //   2. written_readings — covers all 17 families, written immediately
      //      after a successful broadcast, before the queue row is cleared.
      //   3. the four legacy per-family txid columns — still consulted for
      //      readings broadcast before written_readings existed, and as a
      //      backstop if the ledger write was lost.
      //
      // Any match means a txid already exists for this content, so broadcasting
      // again would pay twice for the same reading.

      // (1) is a local field, so it cannot fail and is checked outside the
      // try/catch below.
      const guardSourceHash = item.data.source_hash
      const broadcastTxid = (item.data as any)?.broadcastTxid
      if (typeof broadcastTxid === 'string' && TXID_PATTERN.test(broadcastTxid)) {
        if (typeof guardSourceHash === 'string' && guardSourceHash.length > 0) {
          // Backfill the durable records this row never got to write.
          try {
            await recordWrittenReading(stream, guardSourceHash, broadcastTxid)
          } catch {}
        }
        throughputObservability.recordAlreadyOnChainDropped({
          family: item.data.family || stream,
          providerId: item.data.providerId,
          datasetId: item.data.datasetId,
          queueLane: item.data.queueLane,
        })
        if (bsvConfig.logging.level !== 'error') {
          console.log(
            `⏭️  Item ${item.id} was already broadcast (${broadcastTxid.slice(0, 12)}...) before a crash; ` +
              `recording and completing without re-broadcasting`,
          )
        }
        this.completedCount++
        this.stats.totalProcessed++
        markQueueItemCompleted(item.id).catch(() => {})
        return
      }

      // (2) and (3) are database reads. They fail closed: if the lookup errors
      // for any reason other than the table not existing yet, the item is
      // retried rather than broadcast. The previous `catch {}` treated a failed
      // lookup as "not on chain", so a database blip during the check converted
      // straight into a duplicate broadcast that had already been paid for.
      if (typeof guardSourceHash === 'string' && guardSourceHash.length > 0) {
        try {
          let alreadyOnChain = await hasWrittenReading(stream, guardSourceHash)
          if (!alreadyOnChain) {
            if (stream === 'air_quality') alreadyOnChain = await hasAirQualityTxId(guardSourceHash)
            else if (stream === 'water_levels') alreadyOnChain = await hasWaterLevelTxId(guardSourceHash)
            else if (stream === 'seismic_activity') alreadyOnChain = await hasSeismicTxId(guardSourceHash)
            else if (stream === 'advanced_metrics') alreadyOnChain = await hasAdvancedTxId(guardSourceHash)
          }
          if (alreadyOnChain) {
            throughputObservability.recordAlreadyOnChainDropped({
              family: item.data.family || stream,
              providerId: item.data.providerId,
              datasetId: item.data.datasetId,
              queueLane: item.data.queueLane,
            })
            if (bsvConfig.logging.level === 'debug') {
              console.log(`⏭️  Skipping already-on-chain item ${item.id} for stream ${stream}`)
            }
            this.completedCount++
            this.stats.totalProcessed++
            markQueueItemCompleted(item.id).catch(() => {})
            return
          }
        } catch (guardErr) {
          const msg = guardErr instanceof Error ? guardErr.message : String(guardErr)
          console.warn(`⚠️ Idempotency lookup failed for item ${item.id}; not broadcasting: ${msg}`)
          await this.handleFailedItem(item, `Idempotency lookup failed: ${msg}`)
          return
        }
      }
      // writeToChain throwing is handled above, so reaching here means the call
      // returned. The old `wasBroadcast` flag and its else-branch were dead:
      // the flag was set on the line after the await, and the only way to skip
      // it was the throw that already returned.
      let resultTxid: string | null = null
      try {
        if (this.shouldLogQueueSkip('writeToChainEnter')) {
          console.log(`🔍 [queue-debug] Entering writeToChain for item ${item.id} (stream=${stream})`)
        }
        resultTxid = await blockchainService.writeToChain({
          stream,
          timestamp: item.data.timestamp,
          family: item.data.family,
          providerId: item.data.providerId,
          datasetId: item.data.datasetId,
          queueLane: item.data.queueLane,
          traceId: item.id,
          payload,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error'
        if (this.shouldLogQueueSkip('writeToChainError')) {
          console.warn(`🔍 [queue-debug] writeToChain failed for item ${item.id}: ${msg}`)
        }
        // Always re-queue failed transactions instead of using fallbacks
        await this.handleFailedItem(item, msg)
        return
      }

      // If no txid yet, the transaction failed and should be re-queued
      if (!resultTxid) {
        await this.handleFailedItem(item, 'Transaction broadcast failed - no txid returned')
        return
      }

      // A broadcast is only complete when the network returned a real 64-hex
      // transaction id. Anything else — 'blockchain-not-configured', a provider
      // error string, a truncated hash — is a failure that must retry, not a
      // success that marks the reading as written. Previously any non-empty
      // string counted as a completed broadcast, which recorded a reading as
      // on-chain when no transaction existed.
      if (!TXID_PATTERN.test(resultTxid)) {
        await this.handleFailedItem(
          item,
          `Broadcast returned a non-txid result (${String(resultTxid).slice(0, 64)})`,
        )
        return
      }

      // Mark this reading as broadcast before doing anything fallible.
      //
      // Two places, for two different reasons:
      //   - the in-memory item, so any retry within this process takes the
      //     broadcastTxid branch of the idempotency guard and completes rather
      //     than broadcasting a second, separately-paid transaction;
      //   - the queue row, so the same holds across a restart or another worker
      //     reclaiming the row.
      //
      // Awaited: if the row write fails we still hold the in-memory marker, and
      // logging it is enough — blocking completion here would trade one risk
      // (a duplicate broadcast) for a worse one (a reading broadcast but never
      // recorded).
      ;(item.data as any).broadcastTxid = resultTxid
      try {
        await setQueueItemBroadcastTxid(item.id, resultTxid)
      } catch (markErr) {
        console.warn(
          `⚠️ Could not record broadcast txid on queue row ${item.id}:`,
          markErr instanceof Error ? markErr.message : markErr,
        )
      }

      // Order matters. The durable records of "this reading is on-chain" are
      // written first: written_readings (all families) and the legacy
      // per-family txid column. Only then is the queue row removed.
      //
      // markQueueItemCompleted deletes the row, so doing it first leaves a
      // window where the row is gone and the reading is unrecorded. A crash
      // in that window loses the reading silently — the dedupe gate has
      // nothing to match, and the item cannot be re-collected because the
      // collector's dedupe store may still hold its key. In this order a
      // crash instead leaves the queue row for reclaim, which then sees the
      // recorded txid and skips the re-broadcast.
      try {
        const sourceHash = item.data.source_hash
        if (sourceHash && typeof sourceHash === 'string') {
          try {
            await recordWrittenReading(stream, sourceHash, resultTxid)
          } catch (ledgerErr) {
            // Do NOT complete the item on a ledger failure: without the
            // record, the reclaim path would broadcast this reading a second
            // time. Retry instead.
            const msg = ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr)
            await this.handleFailedItem(item, `written_readings record failed: ${msg}`)
            return
          }

          const providerLabel = resolveSourceLabel(
            item.data.providerId,
            item.data.datasetId,
            item.data.sourceLabel || item.data.measurement?.source || null,
          )
          const s = stream
          if (s === 'air_quality') {
            await setAirQualityTxId(sourceHash, resultTxid)
            try { const { upsertAirQualityOnchain } = await import('./repositories'); await upsertAirQualityOnchain(resultTxid, providerLabel, new Date(item.data.timestamp), item.data) } catch {}
          } else if (s === 'water_levels') {
            await setWaterLevelTxId(sourceHash, resultTxid)
            try { const { upsertWaterLevelsOnchain } = await import('./repositories'); await upsertWaterLevelsOnchain(resultTxid, providerLabel, new Date(item.data.timestamp), item.data) } catch {}
          } else if (s === 'seismic_activity') {
            await setSeismicTxId(sourceHash, resultTxid)
            try { const { upsertSeismicOnchain } = await import('./repositories'); await upsertSeismicOnchain(resultTxid, providerLabel, new Date(item.data.timestamp), item.data) } catch {}
          } else if (s === 'advanced_metrics') {
            await setAdvancedTxId(sourceHash, resultTxid)
            try { const { upsertAdvancedOnchain } = await import('./repositories'); await upsertAdvancedOnchain(resultTxid, providerLabel, new Date(item.data.timestamp), item.data) } catch {}
          }
        }
      } catch (linkErr) {
        console.warn('txid link (worker-queue) error:', linkErr)
      }

      // Success - the reading is recorded on-chain, so the queue row can go.
      this.completedCount++
      this.stats.totalProcessed++
      this.processedCountSinceLastSample++
      if (bsvConfig.logging.level === 'debug') {
        console.log(`✅ Processed transaction: ${item.id} -> ${resultTxid}`)
      }
      markQueueItemCompleted(item.id).catch(() => {})

    } catch (error) {
      await this.handleFailedItem(item, error instanceof Error ? error.message : 'Unknown error')
    } finally {
      // Remove from processing queue
      const index = this.processingQueue.findIndex(i => i.id === item.id)
      if (index > -1) {
        this.processingQueue.splice(index, 1)
      }
    }

    this.stats.lastProcessedTime = Date.now()
  }

  private async hasSufficientConfirmedUtxos(): Promise<boolean> {
    try {
      const addresses = walletManager.getAllWalletAddresses()
      if (!addresses || addresses.length === 0) return true
      const pauseMin = Number(process.env.BSV_UTXO_PAUSE_MIN || process.env.BSV_UTXO_MIN_WATERMARK || 10)
      const minConf = getQueueGateMinConfirmations()
      const gateSource = getOverlayFallbackConfig().queueGateSource
      const legacyProvider = gateSource === 'legacy'
        ? (await import('./utxo-provider')).getUnspentForAddress
        : null
      const results = await Promise.all(addresses.map(async (addr, walletIndex) => {
        try {
          if (gateSource === 'overlay') {
            const topic = getTreasuryTopicForWallet(walletIndex)
            const confirmed = await getSpendSourceForWallet(walletIndex).countSpendable({
              topic,
              minSatoshis: 0,
              excludeReserved: false,
              confirmedOnly: minConf > 0,
              allowDegradedStale: true,
            })
            return { addr, walletIndex, confirmed }
          }

          const list = legacyProvider ? await legacyProvider(addr, { allowDegradedStale: true }) : []
          const confirmed = Array.isArray(list)
            ? list.filter((u: any) => {
                const conf = (u.confirmations || 0) >= minConf
                const byHeight = typeof u.height === 'number' ? u.height > 0 : true
                return conf || byHeight
              }).length
            : 0
          return { addr, walletIndex, confirmed }
        } catch {
          return { addr, walletIndex, confirmed: 0 }
        }
      }))
      // Continue processing if at least one wallet is above the pause minimum.
      const anyOk = results.some(r => r.confirmed >= pauseMin)
      // Throttled, stateful logging
      const now = Date.now()
      if (!anyOk) {
        const minConfirmed = results.length ? Math.min(...results.map(r => r.confirmed)) : 0
        const atOrAboveMin = results.filter(r => r.confirmed >= pauseMin).length
        const shouldLog = (this.utxoPauseState !== 'paused') || (now - this.lastUtxoPauseLogAt > 60000)
        if (shouldLog) {
          console.log(`⏸️  Pausing writes: ${atOrAboveMin}/${results.length} wallets at/above minimum (source=${gateSource}, gateCountMin=${minConfirmed}, pauseMin=${pauseMin}, BSV_UTXO_MIN_CONFIRMATIONS=${minConf}). Checking every 30s.`)
          this.lastUtxoPauseLogAt = now
        }
        this.utxoPauseState = 'paused'
        this.lastGateInfo = {
          paused: true,
          minRequired: pauseMin,
          minConfirmed,
          okWallets: atOrAboveMin,
          totalWallets: results.length,
          source: gateSource,
          wallets: results.map(result => ({
            walletIndex: result.walletIndex,
            walletLabel: `W${result.walletIndex + 1}`,
            address: result.addr,
            confirmed: result.confirmed,
          })),
        }
      } else {
        if (this.utxoPauseState !== 'ok') {
          console.log(`▶️  Resuming writes: UTXO gate counts recovered across wallets (source=${gateSource}).`)
        }
        this.utxoPauseState = 'ok'
        const minConfirmed = results.length ? Math.min(...results.map(r => r.confirmed)) : 0
        const atOrAboveMin = results.filter(r => r.confirmed >= pauseMin).length
        this.lastGateInfo = {
          paused: false,
          minRequired: pauseMin,
          minConfirmed,
          okWallets: atOrAboveMin,
          totalWallets: results.length,
          source: gateSource,
          wallets: results.map(result => ({
            walletIndex: result.walletIndex,
            walletLabel: `W${result.walletIndex + 1}`,
            address: result.addr,
            confirmed: result.confirmed,
          })),
        }
      }
      return anyOk
    } catch {
      return true
    }
  }

  private mapTypeToStream(type: string): string {
    const family = normaliseDataFamily(type)
    if (family) return family
    switch (type) {
      case 'air-quality':
        return 'air_quality'
      case 'water-level':
        return 'water_levels'
      case 'seismic':
        return 'seismic_activity'
      case 'advanced':
        return 'advanced_metrics'
      default:
        return type
    }
  }

  private buildPayloadFromItem(item: QueueItem): any {
    const t = item.data
    const iso = new Date(t.timestamp).toISOString()
    return {
      location: t.location,
      timestamp: iso,
      ...(t.sourceLabel ? { source: t.sourceLabel } : {}),
      ...(t.coordinates ? { latitude: t.coordinates.lat, longitude: t.coordinates.lon } : {}),
      ...(t.stationId ? { station_id: t.stationId } : {}),
      ...t.measurement,
      ...(t.source_hash ? { source_hash: t.source_hash } : {}),
    }
  }

  private async handleFailedItem(item: QueueItem, error: string): Promise<void> {
    item.retryCount++
    this.stats.totalRetries++
    const errorUpper = String(error || '').toUpperCase()

    // The row is about to go back to 'queued' (retry) or 'failed' (terminal). In
    // both cases this worker's claim on it is over, so the flag must be cleared.
    //
    // Leaving it set was a live bug: processQueue treats dbClaimed=true as "I
    // already own this row" and skips markQueueItemsProcessing. A retried item
    // therefore re-entered the batch still claiming ownership of a row it no
    // longer held, and could be broadcast without ever re-winning the claim —
    // which is exactly the double-broadcast the claim exists to prevent.
    item.dbClaimed = false

    // A deterministic rejection must not consume the retry budget.
    //
    // `TERMINAL_BROADCAST_ERROR` means the broadcaster parsed the transaction
    // and judged it invalid — a bad script, a bad signature, a competing spend.
    // Every host validates the same bytes against the same consensus rules, so
    // the identical transaction cannot become valid on a later attempt.
    // Retrying it burns attempts, delays the queue behind it, and buries the
    // real cause under retry noise. It goes straight to the permanent-failure
    // branch, where the durable row keeps the full error text.
    //
    // Classification comes from `lib/blockchain.ts` rather than a second copy of
    // the tags, so the producer and the consumer of these errors cannot drift.
    const terminalRejection = isTerminalBroadcastError(error)

    if (!terminalRejection && item.retryCount <= item.maxRetries) {
      // Determine retry strategy based on error type
      let delay = bsvConfig.transaction.retryDelayMs * Math.pow(2, item.retryCount - 1)
      let shouldForceUtxoRefresh = false
      let retryMessage = ''

      const feeTooLow = isFeeTooLowBroadcastError(error)
      const endpointBackoff = isEndpointBackoffError(error)

      // Enhanced error-specific retry strategies
      if (feeTooLow) {
        // The transaction was rebuilt once at a higher multiplier and still
        // under-paid, so the policy rate moved again. A longer backoff lets the
        // cached rate expire; the next attempt rebuilds from a fresh read.
        delay = Math.max(delay, 60000)
        shouldForceUtxoRefresh = false
        retryMessage = 'fee below broadcaster policy, waiting for the rate to settle'
      } else if (endpointBackoff) {
        // The endpoint asked for a delay. Nothing was learned about the
        // transaction, so the input reservation must stay intact.
        delay = Math.max(delay, 30000)
        shouldForceUtxoRefresh = false
        retryMessage = 'broadcaster backpressure, retrying after its requested delay'
      } else if (/MEMPOOL_CONFLICT|TXN-MEMPOOL-CONFLICT|DOUBLE_SPEND|DOUBLE_SPEND_ATTEMPTED/.test(errorUpper)) {
        // Mempool conflict: wait longer and force UTXO refresh to use different inputs
        delay = Math.max(delay, 30000) // At least 30 seconds
        shouldForceUtxoRefresh = true
        retryMessage = 'UTXO conflict detected, forcing UTXO refresh'
      } else if (/BROADCAST_RATE_LIMITED|TOO MANY REQUESTS|FAILED \(429\)|HTTP 429|RATE LIMIT/.test(errorUpper)) {
        // Endpoint rate limiting: wait substantially longer and avoid pointless UTXO churn
        delay = Math.max(delay, 60000) // At least 60 seconds
        shouldForceUtxoRefresh = false
        retryMessage = 'broadcast rate-limited, waiting for endpoint recovery'
      } else if (/BROADCAST_ENDPOINT_UNAVAILABLE|FETCH FAILED|ENDPOINT_BACKOFF|ECONN|ENOTFOUND|ETIMEDOUT|TIMED OUT|NETWORK/.test(errorUpper)) {
        // Temporary network outage / endpoint cooldown: back off, but keep current UTXO reservations intact
        delay = Math.max(delay, 30000) // At least 30 seconds
        shouldForceUtxoRefresh = false
        retryMessage = 'broadcast endpoint unavailable, backing off'
      } else if (errorUpper.includes('ALREADY_KNOWN')) {
        // Transaction already in mempool/blockchain - don't retry
        console.log(`ℹ️  Transaction ${item.id} already known to network - marking as completed`)
        this.completedCount++
        this.stats.totalProcessed++
        markQueueItemCompleted(item.id).catch(() => {})
        return
      } else if (errorUpper.includes('LOW_FEE')) {
        // Insufficient fee: wait for mempool to clear or increase retry delay
        delay = Math.max(delay, 60000) // At least 60 seconds
        retryMessage = 'low fee, waiting for mempool to clear'
      } else if (errorUpper.includes('HEAP_PRESSURE_BACKOFF')) {
        // Heap pressure guard triggered: pause writes briefly to let GC recover.
        delay = Math.max(delay, 60000) // At least 60 seconds
        shouldForceUtxoRefresh = false
        retryMessage = 'heap pressure backoff, waiting for memory recovery'
      } else if (error.includes('No UTXOs available') || error.includes('No reservable UTXO')) {
        // UTXO exhaustion: wait longer for UTXOs to confirm
        delay = Math.max(delay, 45000) // At least 45 seconds
        shouldForceUtxoRefresh = true
        retryMessage = 'UTXO exhaustion, waiting for confirmations'
      } else if (error.includes('already reserved')) {
        // UTXO lock conflict: short delay and refresh
        delay = Math.max(delay, 5000) // At least 5 seconds
        shouldForceUtxoRefresh = true
        retryMessage = 'UTXO lock conflict, refreshing UTXO pool'
      } else if (error.includes('ARC broadcast failed')) {
        // ARC broadcast failure: wait longer and force UTXO refresh
        delay = Math.max(delay, 30000) // At least 30 seconds
        shouldForceUtxoRefresh = true
        retryMessage = 'ARC broadcast failed, refreshing UTXOs and retrying'
      } else if (/MISSING INPUTS?/.test(errorUpper)) {
        // Missing inputs: wait longer and force UTXO refresh
        delay = Math.max(delay, 45000) // At least 45 seconds
        shouldForceUtxoRefresh = true
        retryMessage = 'missing inputs, refreshing UTXOs and retrying'
      } else {
        retryMessage = 'general error'
      }

      console.log(`🔄 Retrying item ${item.id} (attempt ${item.retryCount}/${item.maxRetries}) in ${(delay/1000).toFixed(1)}s [${retryMessage}]`)
      
      // Force UTXO lock cleanup if needed
      if (shouldForceUtxoRefresh) {
        try {
          // Clear any stale UTXO locks to free up previously reserved UTXOs
          const { releaseAllExpiredLocks } = await import('./utxo-locks')
          await releaseAllExpiredLocks()
          // Note: UTXO provider fetches fresh data on each call, no cache to clear
        } catch (e) {
          // Continue even if lock cleanup fails
        }
      }
      
      setTimeout(() => {
        if (item.priority === 'high') {
          this.highPriorityQueue.unshift(item) // Add back to front of queue
        } else {
          this.normalPriorityQueue.unshift(item)
        }
        this.retryScheduledCount = Math.max(0, this.retryScheduledCount - 1)
      }, delay)
      // Update retry count and keep queued in DB
      requeueQueueItem(item.id, item.retryCount, delay).catch(() => {})
      this.retryScheduledCount++
    } else {
      // Max retries exceeded - move to failed.
      //
      // Retained for diagnostics only, so it is bounded: the oldest entry is
      // dropped once the cap is reached. The durable record of the failure is
      // the worker_queue row, which markQueueItemFailed writes with the full
      // error text.
      this.failedItems.push(item)
      while (this.failedItems.length > MAX_FAILED_ITEMS_IN_MEMORY) {
        this.failedItems.shift()
      }
      this.stats.totalFailed++
      this.failedCountSinceLastSample++
      if (bsvConfig.logging.level !== 'error') {
        if (terminalRejection) {
          // Named once, with the code: this reading needs a code change or an
          // operator, not another attempt.
          console.error(
            `❌ Permanently rejected by the broadcaster (not retried, attempt ${item.retryCount}/${item.maxRetries}): ` +
              `${item.id}: ${error.substring(0, 400)}`,
          )
        } else {
          console.error(`❌ Failed item ${item.id} after ${item.maxRetries} retries: ${error}`)
        }
      }
      markQueueItemFailed(item.id, error).catch(() => {})
    }
  }

  public getAndResetSampleCounts(): { queued: number; processed: number; failed: number } {
    const q = this.queuedCountSinceLastSample
    const p = this.processedCountSinceLastSample
    const f = this.failedCountSinceLastSample
    this.queuedCountSinceLastSample = 0
    this.processedCountSinceLastSample = 0
    this.failedCountSinceLastSample = 0
    return { queued: q, processed: p, failed: f }
  }

  public getRetryScheduledCount(): number {
    return this.retryScheduledCount
  }

  public getGateInfo(): QueueGateInfo {
    return { ...this.lastGateInfo }
  }

  /**
   * Derive the queue id from the reading's own identity, not from the clock.
   *
   * The previous `${Date.now()}_${random}` form was unique by construction, so
   * `ON CONFLICT (id) DO NOTHING` in enqueueQueueItem could never fire. The only
   * gates before an enqueue were the in-memory dedupe store and the on-chain
   * check, and every restart empties the in-memory store, so each restart
   * re-enqueued every reading not yet written on-chain as a brand new row. That
   * is what grew worker_queue to 3.1M rows / 3.3 GB, and a sampled backlog was
   * 87% duplicate payloads (138,952 rows, 18,637 distinct).
   *
   * `source_hash` is the content identity the reading tables already key on
   * (`ON CONFLICT (source_hash)`) and the value checked against the chain before
   * enqueue, so it is the natural key here too. Namespacing by `type` stops two
   * readings of different families that happened to hash alike from colliding.
   *
   * Retries are unaffected: requeueQueueItem updates the existing row in place,
   * so the id is stable for the whole retry lifecycle.
   */
  private generateItemId(data: BSVTransactionData): string {
    const sourceHash = typeof data.source_hash === 'string' ? data.source_hash.trim() : ''
    if (sourceHash) {
      const namespace = data.type || data.family || 'unknown'
      return `${namespace}:${sourceHash}`
    }
    // No content identity: fall back to the previous scheme rather than let many
    // unrelated readings collapse onto a single key.
    const random = Math.random().toString(36).substring(2, 15)
    return `${Date.now()}_${random}`
  }

  public stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval)
      this.processingInterval = null
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.isProcessing = false
    console.log('🛑 Worker queue processing stopped')
  }

  public clearQueues(): void {
    this.highPriorityQueue = []
    this.normalPriorityQueue = []
    this.processingQueue = []
    this.completedCount = 0
    this.failedItems = []
    console.log('🧹 All queues cleared')
  }
}

// Persist singleton on globalThis to survive Next.js dev-mode module
// re-evaluations that would otherwise create duplicate queue processors.
const _wq = globalThis as any
if (!_wq.__GAIALOG_WORKER_QUEUE__) {
  _wq.__GAIALOG_WORKER_QUEUE__ = new WorkerQueue()
}
export const workerQueue: WorkerQueue = _wq.__GAIALOG_WORKER_QUEUE__
