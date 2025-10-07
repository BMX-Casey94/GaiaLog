import { bsvTransactionService, BSVTransactionData } from './bsv-transaction-service'
import { blockchainService } from './blockchain'
import { bsvConfig } from './bsv-config'
import { walletManager } from './wallet-manager'
import { setAdvancedTxId, setAirQualityTxId, setSeismicTxId, setWaterLevelTxId, hasAirQualityTxId, hasWaterLevelTxId, hasSeismicTxId, hasAdvancedTxId } from './repositories'
import { ensureQueueTable, enqueueQueueItem, loadPendingQueueItems, markQueueItemCompleted, markQueueItemFailed, markQueueItemProcessing, requeueQueueItem, cleanupOldFailedItems } from './queue-repository'

export interface QueueItem {
  id: string
  priority: 'high' | 'normal'
  data: BSVTransactionData
  timestamp: number
  retryCount: number
  maxRetries: number
}

export interface QueueStats {
  totalItems: number
  highPriorityItems: number
  normalPriorityItems: number
  processingItems: number
  completedItems: number
  failedItems: number
  processingRate: number
  averageWaitTime: number
  errorRate: number
}

export class WorkerQueue {
  private highPriorityQueue: QueueItem[] = []
  private normalPriorityQueue: QueueItem[] = []
  private processingQueue: QueueItem[] = []
  private completedItems: QueueItem[] = []
  private failedItems: QueueItem[] = []
  private isProcessing = false
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
  private utxoPauseState: 'ok' | 'paused' = 'ok'
  private queuedCountSinceLastSample = 0
  private processedCountSinceLastSample = 0
  private failedCountSinceLastSample = 0
  private retryScheduledCount = 0
  private lastGateInfo: { paused: boolean; minRequired: number; minConfirmed: number; okWallets: number; totalWallets: number } = { paused: false, minRequired: 0, minConfirmed: 0, okWallets: 0, totalWallets: 0 }

  constructor() {
    // Don't auto-start processing - let it be started manually when needed
  }

  public addToQueue(data: BSVTransactionData, priority: 'high' | 'normal' = 'normal'): string {
    const id = this.generateItemId()
    const item: QueueItem = {
      id,
      priority,
      data,
      timestamp: Date.now(),
      retryCount: 0,
      maxRetries: bsvConfig.transaction.maxRetries
    }

    if (priority === 'high') {
      this.highPriorityQueue.push(item)
    } else {
      this.normalPriorityQueue.push(item)
    }

    // Persist to DB so the queue survives restarts
    enqueueQueueItem({ id, priority, data, timestamp: item.timestamp, retry_count: 0, max_retries: item.maxRetries }).catch((e) => {
      if (process.env.DEBUG_DB_WRITES === '1') {
        try { console.error('enqueueQueueItem error:', e) } catch {}
      }
    })
    this.queuedCountSinceLastSample++
    if (bsvConfig.logging.level === 'debug') {
      console.log(`📥 Added ${priority} priority item to queue: ${id}`)
    }
    return id
  }

  public getQueueStats(): QueueStats {
    const now = Date.now()
    const totalItems = this.highPriorityQueue.length + this.normalPriorityQueue.length + this.processingQueue.length
    
    const processingRate = this.stats.totalProcessed > 0 
      ? this.stats.totalProcessed / ((now - this.stats.startTime) / 1000)
      : 0

    const averageWaitTime = this.completedItems.length > 0
      ? this.completedItems.reduce((sum, item) => sum + (item.timestamp - item.timestamp), 0) / this.completedItems.length
      : 0

    const errorRate = this.stats.totalProcessed > 0
      ? this.stats.totalFailed / this.stats.totalProcessed
      : 0

    return {
      totalItems,
      highPriorityItems: this.highPriorityQueue.length,
      normalPriorityItems: this.normalPriorityQueue.length,
      processingItems: this.processingQueue.length,
      completedItems: this.completedItems.length,
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
      completed: this.completedItems.length,
      failed: this.failedItems.length
    }
  }

  public startProcessing(): void {
    if (this.isProcessing) return

    this.isProcessing = true
    console.log('🔄 Starting worker queue processing...')

    // Hydrate in-memory queues from DB on start
    ensureQueueTable().then(async () => {
      try {
        const rows = await loadPendingQueueItems(10000)
        // Keep order by timestamp; push into normal queue (preserve priority per row)
        for (const r of rows) {
          const q: QueueItem = {
            id: r.id,
            priority: (r.priority === 'high' ? 'high' : 'normal'),
            data: r.data as any,
            timestamp: Number(r.timestamp) || Date.now(),
            retryCount: Number(r.retry_count) || 0,
            maxRetries: Number(r.max_retries) || bsvConfig.transaction.maxRetries,
          }
          if (q.priority === 'high') this.highPriorityQueue.push(q)
          else this.normalPriorityQueue.push(q)
        }
        console.log(`💾 Hydrated ${rows.length} queued item(s) from DB`)
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

  private async processQueue(): Promise<void> {
    // Skip processing if no items in queue
    if (this.highPriorityQueue.length === 0 && this.normalPriorityQueue.length === 0) {
      return
    }

    if (!bsvTransactionService.isReady()) {
      // Try lazy init and continue; avoid stalling the queue if wallet manager is ready
      return
    }

    // Gate by confirmed UTXOs per wallet to avoid stalling on unconfirmed change
    const nowTs = Date.now()
    if (nowTs - this.lastUtxoGateCheckedAt > 30000) { // check every 30s
      this.lastUtxoGateCheckedAt = nowTs
      try {
        this.lastUtxoGateOk = await this.hasSufficientConfirmedUtxos()
      } catch (e) {
        this.lastUtxoGateOk = true // don't hard-stop on errors
      }
    }
    if (!this.lastUtxoGateOk) {
      // Soft pause: wait for maintainer/splits to confirm
      return
    }

    const maxItemsPerBatch = Math.min(
      bsvConfig.queue.batchSize,
      bsvConfig.queue.maxTxPerSecond
    )

    let processedCount = 0
    const batchStartTime = Date.now()

    // Process high priority items first
    while (this.highPriorityQueue.length > 0 && processedCount < maxItemsPerBatch) {
      const item = this.highPriorityQueue.shift()!
      markQueueItemProcessing(item.id).catch(() => {})
      await this.processItem(item)
      processedCount++
    }

    // Then process normal priority items
    while (this.normalPriorityQueue.length > 0 && processedCount < maxItemsPerBatch) {
      const item = this.normalPriorityQueue.shift()!
      markQueueItemProcessing(item.id).catch(() => {})
      await this.processItem(item)
      processedCount++
    }

    // Rate limiting: ensure we don't exceed max transactions per second
    const batchDuration = Date.now() - batchStartTime
    const minBatchDuration = (1000 / bsvConfig.queue.maxTxPerSecond) * processedCount
    
    if (batchDuration < minBatchDuration) {
      const delay = minBatchDuration - batchDuration
      await new Promise(resolve => setTimeout(resolve, delay))
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
      const stream = this.mapTypeToStream(item.data.type)
      const payload = this.buildPayloadFromItem(item)
      // Hard idempotency guard: if DB already has a txid for this reading, skip
      try {
        const sourceHash = item.data.source_hash
        if (typeof sourceHash === 'string' && sourceHash.length > 0) {
          let alreadyOnChain = false
          if (stream === 'air_quality') alreadyOnChain = await hasAirQualityTxId(sourceHash)
          else if (stream === 'water_levels') alreadyOnChain = await hasWaterLevelTxId(sourceHash)
          else if (stream === 'seismic_activity') alreadyOnChain = await hasSeismicTxId(sourceHash)
          else if (stream === 'advanced_metrics') alreadyOnChain = await hasAdvancedTxId(sourceHash)
          if (alreadyOnChain) {
            if (bsvConfig.logging.level === 'debug') {
              console.log(`⏭️  Skipping already-on-chain item ${item.id} for stream ${stream}`)
            }
            this.completedItems.push(item)
            this.stats.totalProcessed++
      markQueueItemCompleted(item.id).catch((e) => {
        if (process.env.DEBUG_DB_WRITES === '1') {
          try { console.error('markQueueItemCompleted error:', e) } catch {}
        }
      })
            return
          }
        }
      } catch {}
      let resultTxid: string | null = null
      let wasBroadcast = false
      try {
        resultTxid = await blockchainService.writeToChain({
          stream,
          timestamp: item.data.timestamp,
          payload,
        })
        wasBroadcast = true
      } catch (e) {
        // Always re-queue failed transactions instead of using fallbacks
        await this.handleFailedItem(item, e instanceof Error ? e.message : 'Unknown error')
        return
      }

      // If no txid yet, the transaction failed and should be re-queued
      if (!resultTxid) {
        await this.handleFailedItem(item, 'Transaction broadcast failed - no txid returned')
        return
      }

      if (resultTxid && wasBroadcast) {
        // Success - move to completed
        this.completedItems.push(item)
        this.stats.totalProcessed++
        this.processedCountSinceLastSample++
        if (bsvConfig.logging.level === 'debug') {
          console.log(`✅ Processed transaction: ${item.id} -> ${resultTxid}`)
        }
        markQueueItemCompleted(item.id).catch(() => {})
        // Try to link txid back to reading row via source_hash when available
        try {
          const s = stream
          const sourceHash = item.data.source_hash
          if (sourceHash && typeof sourceHash === 'string') {
            if (s === 'air_quality') {
              await setAirQualityTxId(sourceHash, resultTxid)
              try { const { upsertAirQualityOnchain } = await import('./repositories'); await upsertAirQualityOnchain(resultTxid, String((item as any)?.measurement?.source || 'unknown'), new Date(item.data.timestamp), item.data) } catch {}
            } else if (s === 'water_levels') {
              await setWaterLevelTxId(sourceHash, resultTxid)
              try { const { upsertWaterLevelsOnchain } = await import('./repositories'); await upsertWaterLevelsOnchain(resultTxid, String((item as any)?.measurement?.source || 'unknown'), new Date(item.data.timestamp), item.data) } catch {}
            } else if (s === 'seismic_activity') {
              await setSeismicTxId(sourceHash, resultTxid)
              try { const { upsertSeismicOnchain } = await import('./repositories'); await upsertSeismicOnchain(resultTxid, String((item as any)?.measurement?.source || 'unknown'), new Date(item.data.timestamp), item.data) } catch {}
            } else if (s === 'advanced_metrics') {
              await setAdvancedTxId(sourceHash, resultTxid)
              try { const { upsertAdvancedOnchain } = await import('./repositories'); await upsertAdvancedOnchain(resultTxid, String((item as any)?.measurement?.source || 'unknown'), new Date(item.data.timestamp), item.data) } catch {}
            }
          }
        } catch (linkErr) {
          console.warn('txid link (worker-queue) error:', linkErr)
        }
      } else if (!wasBroadcast) {
        // Placeholder path used: schedule retry to attempt real broadcast later
        await this.handleFailedItem(item, 'placeholder_fallback_used')
        return
      } else {
        // Failed - handle retry logic
        await this.handleFailedItem(item, 'Unknown error')
      }

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
      const lowWater = Number(process.env.BSV_UTXO_LOW_WATERMARK || 50)
      const pauseMin = Number(process.env.BSV_UTXO_PAUSE_MIN || process.env.BSV_UTXO_MIN_WATERMARK || 10)
      const minConf = Number(process.env.BSV_UTXO_MIN_CONFIRMATIONS || 1)
      const { getUnspentForAddress } = await import('./utxo-provider')
      const results = await Promise.all(addresses.map(async (addr) => {
        try {
          const list = await getUnspentForAddress(addr)
          const confirmed = Array.isArray(list)
            ? list.filter((u: any) => {
                const conf = (u.confirmations || 0) >= minConf
                const byHeight = typeof u.height === 'number' ? u.height > 0 : true
                return conf || byHeight
              }).length
            : 0
          return { addr, confirmed }
        } catch {
          return { addr, confirmed: 0 }
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
          console.log(`⏸️  Pausing writes: ${atOrAboveMin}/${results.length} wallets at/above minimum (minConfirmed=${minConfirmed}, minRequired=${pauseMin}). Checking every 30s.`)
          this.lastUtxoPauseLogAt = now
        }
        this.utxoPauseState = 'paused'
        this.lastGateInfo = { paused: true, minRequired: pauseMin, minConfirmed, okWallets: atOrAboveMin, totalWallets: results.length }
      } else {
        if (this.utxoPauseState !== 'ok') {
          console.log('▶️  Resuming writes: confirmed UTXOs recovered across all wallets.')
        }
        this.utxoPauseState = 'ok'
        const minConfirmed = results.length ? Math.min(...results.map(r => r.confirmed)) : 0
        const atOrAboveMin = results.filter(r => r.confirmed >= pauseMin).length
        this.lastGateInfo = { paused: false, minRequired: pauseMin, minConfirmed, okWallets: atOrAboveMin, totalWallets: results.length }
      }
      return anyOk
    } catch {
      return true
    }
  }

  private mapTypeToStream(type: string): string {
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
      source: 'worker-queue',
      ...(t.coordinates ? { latitude: t.coordinates.lat, longitude: t.coordinates.lon } : {}),
      ...(t.stationId ? { station_id: t.stationId } : {}),
      ...t.measurement,
      source_hash: t.source_hash,
    }
  }

  private async handleFailedItem(item: QueueItem, error: string): Promise<void> {
    item.retryCount++
    this.stats.totalRetries++

    if (item.retryCount <= item.maxRetries) {
      // Determine retry strategy based on error type
      let delay = bsvConfig.transaction.retryDelayMs * Math.pow(2, item.retryCount - 1)
      let shouldForceUtxoRefresh = false
      let retryMessage = ''

      // Enhanced error-specific retry strategies
      if (error.includes('MEMPOOL_CONFLICT')) {
        // Mempool conflict: wait longer and force UTXO refresh to use different inputs
        delay = Math.max(delay, 30000) // At least 30 seconds
        shouldForceUtxoRefresh = true
        retryMessage = 'mempool conflict detected, forcing UTXO refresh'
      } else if (error.includes('ALREADY_KNOWN')) {
        // Transaction already in mempool/blockchain - don't retry
        console.log(`ℹ️  Transaction ${item.id} already known to network - marking as completed`)
        this.completedItems.push(item)
        this.stats.totalProcessed++
        markQueueItemCompleted(item.id).catch(() => {})
        return
      } else if (error.includes('LOW_FEE')) {
        // Insufficient fee: wait for mempool to clear or increase retry delay
        delay = Math.max(delay, 60000) // At least 60 seconds
        retryMessage = 'low fee, waiting for mempool to clear'
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
      } else if (error.includes('Missing inputs')) {
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
      // Max retries exceeded - move to failed
      this.failedItems.push(item)
      this.stats.totalFailed++
      this.failedCountSinceLastSample++
      if (bsvConfig.logging.level !== 'error') {
        console.error(`❌ Failed item ${item.id} after ${item.maxRetries} retries: ${error}`)
      }
      markQueueItemFailed(item.id, error).catch((e) => {
        if (process.env.DEBUG_DB_WRITES === '1') {
          try { console.error('markQueueItemFailed error:', e) } catch {}
        }
      })
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

  public getGateInfo(): { paused: boolean; minRequired: number; minConfirmed: number; okWallets: number; totalWallets: number } {
    return { ...this.lastGateInfo }
  }

  private generateItemId(): string {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 15)
    return `${timestamp}_${random}`
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
    this.completedItems = []
    this.failedItems = []
    console.log('🧹 All queues cleared')
  }
}

// Export singleton instance
export const workerQueue = new WorkerQueue()
