import 'dotenv/config'
import dotenv from 'dotenv'
import { applyPrimaryMutatorRole, getMutatorControlState } from '../lib/mutator-control'
// Load .env.local only in development; production/VPS uses .env only to avoid brc104 override
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: '.env.local' })
}
dotenv.config()

applyPrimaryMutatorRole()

console.log('🚀 Starting GaiaLog worker service...')
// Log heap limit for debugging OOM (expect 8192 MB on workers)
try {
  const v8 = require('v8')
  const stats = v8.getHeapStatistics()
  const limitMB = Math.round((stats.heap_size_limit || 0) / 1024 / 1024)
  console.log(`📦 Node heap limit: ${limitMB} MB`)
} catch {}
// Mark this process as the worker process so API routes can gate chain writes
process.env.GAIALOG_WORKER_PROCESS = '1'
const mutatorControl = getMutatorControlState()
if (mutatorControl.mode !== 'off') {
  console.log(`🧭 Single-writer mode: ${mutatorControl.mode} (role=${mutatorControl.role})`)
}

// Log the next scheduled cron_restart boundary (:00 or :30) so it is visible in logs
function logNextScheduledRestart(): void {
  const now = new Date()
  const next = new Date(now)
  if (now.getMinutes() < 30) {
    next.setMinutes(30, 0, 0)
  } else {
    next.setHours(now.getHours() + 1, 0, 0, 0)
  }
  const diffMin = Math.round((next.getTime() - now.getTime()) / 60000)
  console.log(`🔁 Scheduled restart: next recycle in ~${diffMin} min at ${next.toISOString().substring(11, 16)} UTC (cron_restart every 30 min)`)
}

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
    try {
      const { getSpendSourceStatus } = await import('../lib/spend-source')
      const { getOverlayFallbackConfig } = await import('../lib/overlay-config')
      const spendSource = getSpendSourceStatus()
      const gate = getOverlayFallbackConfig()
      const overlayWallets = spendSource.wallets
        .filter(wallet => wallet.overlaySelected)
        .map(wallet => wallet.walletLabel)
        .join(',')
      const traceMode = process.env.BSV_LOG_LEVEL === 'debug' ? 'debug' : 'slow-only'
      console.log(
        `💸 Spend source: mode=${spendSource.mode} active=${spendSource.activeImplementation} gate=${gate.queueGateSource} ` +
        `overlayLookup=${spendSource.overlayLookupConfigured ? 'on' : 'off'} overlaySubmit=${spendSource.overlaySubmitConfigured ? 'on' : 'off'} ` +
        `overlayWallets=${overlayWallets || 'none'}`
      )
      console.log(
        `📡 Broadcast config: fee=${Number(process.env.BSV_TX_FEE_RATE || 0.105)} sat/B ` +
        `timeout=${Math.max(3000, Number(process.env.BSV_BROADCAST_TIMEOUT_MS || 15000))}ms ` +
        `minConf=${Number(process.env.BSV_MIN_SPEND_CONFIRMATIONS ?? 0)} ` +
        `utxoPool=${process.env.BSV_ENABLE_UTXO_POOL === 'true' ? 'on' : 'off'} ` +
        `dbLocks=${process.env.BSV_ENABLE_UTXO_DB_LOCKS === 'true' ? 'on' : 'off'} ` +
        `trace=${traceMode}`
      )
    } catch {}

    workerManager.startAll()
    // Start UTXO maintainer first to prioritize split at boot
    startUtxoMaintainer()
    // Slight delay to let maintainer kick off before queue
    setTimeout(() => {
      workerQueue.startProcessing()
    }, 3000)
    console.log('✅ Workers and queue started. Service is running.')
    logNextScheduledRestart()

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
      const lanes = `lanes=throughput:${stats.throughputLaneItems}/coverage:${stats.coverageLaneItems}`
      console.log(`📈 Queue items=${stats.totalItems} +${sample.queued} proc+${sample.processed} fail+${sample.failed} retryScheduled=${retryScheduled} workersRunning=${running} broadcastedLast10s=${broadcasted} ${lanes} ${gateStr}${hint}`)
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

    const gracefulShutdown = (signal: string) => {
      console.log(`\n🛑 Shutting down GaiaLog worker service (${signal})...`)
      // Stop workers so no new collection cycles start
      workerManager.stopAll()
      // Stop queue processing interval — in-flight DB-persisted items are
      // automatically reclaimed as 'queued' after 2 minutes on next startup
      workerQueue.stop()
      console.log('✅ Worker service shut down cleanly.')
      process.exit(0)
    }

    // SIGINT  — manual Ctrl-C or pm2 stop
    // SIGTERM — sent by PM2 on cron_restart, pm2 reload, and some OS signals
    process.on('SIGINT', () => gracefulShutdown('SIGINT'))
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  } catch (e) {
    console.error('❌ Failed to start worker service:', e)
    process.exit(1)
  }
}

main()
