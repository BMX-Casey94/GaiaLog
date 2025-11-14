import 'dotenv/config'
import dotenv from 'dotenv'
// Prefer .env.local (Next-style) so workers match the app environment
dotenv.config({ path: '.env.local' })
// Fallback to default .env if needed
dotenv.config()

console.log('🚀 Starting GaiaLog worker service...')
// Mark this process as the worker process so API routes can gate chain writes
process.env.GAIALOG_WORKER_PROCESS = '1'

async function main() {
  try {
    // Import after env is loaded to ensure modules read correct values at init time
    const { workerManager } = await import('../lib/worker-threads')
    const { workerQueue } = await import('../lib/worker-queue')
    const { startUtxoMaintainer } = await import('../lib/utxo-maintainer')
    const { initializeProviderBudgets } = await import('../lib/provider-registry')
    const { blockchainService } = await import('../lib/blockchain')
    const fs = await import('fs')
    const path = await import('path')
    const os = await import('os')

    // Apply provider budgets from env
    await initializeProviderBudgets()
    // Log DB target for visibility
    try {
      const { getDbInfo } = await import('../lib/db')
      const info = getDbInfo()
      console.log(`🗄️ DB connected: host=${info.host} db=${info.database} ssl=${info.ssl ? 'on' : 'off'}`)
      if ((info.host || '').toLowerCase() === 'localhost') {
        console.warn('⚠️ DB host is localhost; if you expect Supabase, set DATABASE_URL or SUPABASE_DB_URL in .env.local for workers.')
      }
    } catch {}

    workerManager.startAll()
    // Start UTXO maintainer first to prioritize split at boot
    startUtxoMaintainer()
    // Slight delay to let maintainer kick off before queue
    setTimeout(() => {
      workerQueue.startProcessing()
    }, 3000)
    console.log('✅ Workers and queue started. Service is running.')

    setInterval(() => {
      const stats = workerQueue.getQueueStats()
      const ws = workerManager.getWorkerStats()
      const running = ws.filter(w => w.isRunning).length
      const broadcasted = blockchainService.getAndResetBroadcastCount()
      const sample = workerQueue.getAndResetSampleCounts()
      const retryScheduled = workerQueue.getRetryScheduledCount()
      const gate = workerQueue.getGateInfo()
      const gateStr = gate.totalWallets > 0 ? `gate=${gate.paused ? 'paused' : 'ok'} okWallets=${gate.okWallets}/${gate.totalWallets} minConf=${gate.minConfirmed}/${gate.minRequired}` : 'gate=na'
      const hint = (stats.totalItems > 0 && sample.processed === 0 && !gate.paused) ? ' hint=paused_by_lock?' : ''
      console.log(`📈 Queue items=${stats.totalItems} +${sample.queued} proc+${sample.processed} fail+${sample.failed} retryScheduled=${retryScheduled} workersRunning=${running} broadcastedLast10s=${broadcasted} ${gateStr}${hint}`)
    }, 10000)

    // Optional DB ingestion throughput (debug only; COUNT(*) can be expensive on large tables)
    if (process.env.BSV_LOG_LEVEL === 'debug' && process.env.GAIALOG_NO_DB !== 'true') {
      let lastTxCount = 0
      setInterval(async () => {
        try {
          const { query } = await import('../lib/db')
          const r = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM tx_log`)
          const total = Number(r.rows?.[0]?.c || '0')
          const delta = total - lastTxCount
          lastTxCount = total
          console.log(`🗄️ tx_log total=${total} (+${delta}/min)`) 
        } catch {}
      }, 60000)
    }

    // Write cross-process worker status every 5s for Next.js API to read
    const statusDir = os.tmpdir()
    const statusFile = path.join(statusDir, 'gaialog_worker_status.json')
    setInterval(() => {
      try {
        const ws = workerManager.getWorkerStats()
        const payload = {
          success: true,
          workers: ws,
          totalWorkers: ws.length,
          runningWorkers: ws.filter(w => w.isRunning).length,
          updatedAt: Date.now(),
        }
        fs.writeFileSync(statusFile, JSON.stringify(payload))
        // Optional debug: uncomment to see where the file is
        // console.log(`📝 wrote worker status: ${statusFile}`)
      } catch (e) {
        // swallow
      }
    }, 5000)

    // Update tx_log statistics every 30 seconds for near real-time count updates
    if (process.env.GAIALOG_NO_DB !== 'true') {
      setInterval(async () => {
        try {
          const { updateTxLogStats } = await import('../lib/tx-stats-updater')
          await updateTxLogStats()
        } catch (err) {
          console.error('Stats update failed:', err)
        }
      }, 30000) // 30 seconds
    }

    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down GaiaLog worker service...')
      workerManager.stopAll()
      workerQueue.stop()
      process.exit(0)
    })
  } catch (e) {
    console.error('❌ Failed to start worker service:', e)
    process.exit(1)
  }
}

main()
