// Load env from .env.local if available (best-effort)
try { require('dotenv').config({ path: '.env.local' }) } catch (_) {}
// Enable TypeScript requires
try { require('ts-node/register/transpile-only') } catch (_) {}
const { workerManager } = require('../lib/worker-threads.ts')
const { workerQueue } = require('../lib/worker-queue.ts')

console.log('🚀 Starting GaiaLog worker service...')

function start() {
  try {
    workerManager.startAll()
    workerQueue.startProcessing()
    console.log('✅ Workers and queue started. Service is running.')
  } catch (e) {
    console.error('❌ Failed to start worker service:', e)
    process.exit(1)
  }
}

start()

// Keep process alive
setInterval(() => {
  const stats = workerQueue.getQueueStats()
  const ws = workerManager.getWorkerStats()
  const running = ws.filter(w => w.isRunning).length
  console.log(`📈 Queue items=${stats.totalItems} processed=${stats.completedItems || 0} failed=${stats.failedItems || 0} workersRunning=${running}`)
}, 10000)

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down GaiaLog worker service...')
  workerManager.stopAll()
  workerQueue.stop()
  process.exit(0)
})


