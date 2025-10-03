const { workerManager } = require('./lib/worker-threads')
const { workerQueue } = require('./lib/worker-queue')
const { walletManager } = require('./lib/wallet-manager')
const { bsvTransactionService } = require('./lib/bsv-transaction-service')

console.log('🧪 Testing Worker Thread System...\n')

async function testWorkerSystem() {
  try {
    // 1. Check if all services are ready
    console.log('1️⃣ Checking service readiness...')
    console.log(`   Wallet Manager: ${walletManager.isReady() ? '✅' : '❌'}`)
    console.log(`   BSV Transaction Service: ${bsvTransactionService.isReady() ? '✅' : '❌'}`)
    console.log(`   Worker Manager: ${workerManager.isReady() ? '✅' : '❌'}`)
    console.log()

    // 2. Start worker threads
    console.log('2️⃣ Starting worker threads...')
    workerManager.startAll()
    console.log()

    // 3. Monitor for 30 seconds
    console.log('3️⃣ Monitoring worker activity for 30 seconds...')
    console.log('   (Press Ctrl+C to stop early)\n')

    let monitorCount = 0
    const monitorInterval = setInterval(() => {
      monitorCount++
      
      // Get queue stats
      const queueStats = workerQueue.getQueueStats()
      const queueStatus = workerQueue.getQueueStatus()
      
      // Get worker stats
      const workerStats = workerManager.getWorkerStats()
      
      console.log(`📊 Monitor ${monitorCount}:`)
      console.log(`   Queue: ${queueStatus.highPriority} high, ${queueStatus.normalPriority} normal, ${queueStatus.processing} processing`)
      console.log(`   Completed: ${queueStatus.completed}, Failed: ${queueStatus.failed}`)
      console.log(`   Processing Rate: ${queueStats.processingRate.toFixed(2)} tx/sec`)
      
      workerStats.forEach(worker => {
        console.log(`   ${worker.workerId}: ${worker.totalTransactions} tx, ${worker.errors} errors`)
      })
      console.log()

      // Stop after 30 seconds
      if (monitorCount >= 30) {
        clearInterval(monitorInterval)
        finishTest()
      }
    }, 1000)

  } catch (error) {
    console.error('❌ Test failed:', error)
  }
}

function finishTest() {
  console.log('🏁 Test completed!')
  console.log('\n📈 Final Statistics:')
  
  const queueStats = workerQueue.getQueueStats()
  const queueStatus = workerQueue.getQueueStatus()
  const workerStats = workerManager.getWorkerStats()
  
  console.log(`   Total Queue Items: ${queueStats.totalItems}`)
  console.log(`   Completed Transactions: ${queueStatus.completed}`)
  console.log(`   Failed Transactions: ${queueStatus.failed}`)
  console.log(`   Average Processing Rate: ${queueStats.processingRate.toFixed(2)} tx/sec`)
  console.log(`   Error Rate: ${(queueStats.errorRate * 100).toFixed(2)}%`)
  
  console.log('\n👥 Worker Performance:')
  workerStats.forEach(worker => {
    console.log(`   ${worker.workerId}:`)
    console.log(`     Runs: ${worker.totalRuns}`)
    console.log(`     Transactions: ${worker.totalTransactions}`)
    console.log(`     Errors: ${worker.errors}`)
    console.log(`     Avg Processing Time: ${worker.averageProcessingTime.toFixed(0)}ms`)
  })
  
  // Stop all workers
  workerManager.stopAll()
  workerQueue.stop()
  
  console.log('\n✅ Worker system test completed successfully!')
  process.exit(0)
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n🛑 Test interrupted by user')
  finishTest()
})

// Start the test
testWorkerSystem()

