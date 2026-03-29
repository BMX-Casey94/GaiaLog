/**
 * Worker Auto-Initialization Module
 * 
 * This module handles automatic initialization and management of workers
 * for serverless environments like Vercel. It ensures workers start
 * automatically and remain running throughout the application lifecycle.
 */

import { workerManager } from './worker-threads'
import { workerQueue } from './worker-queue'
import { startUtxoMaintainer } from './utxo-maintainer'
import { initializeProviderBudgets, recomputeProviderConfigs } from './provider-registry'
import { walletManager } from './wallet-manager'
import { bsvConfig } from './bsv-config'
import { getMutatorControlState, logMutatorSkip } from './mutator-control'
import { getRuntimeControlState, logWorkerProcessSkip } from './runtime-control'
import { spendSourceObservability } from './spend-source-observability'
import { buildRolloutGateStatus } from './rollout-controls'
import { getSpendSourceStatus } from './spend-source'
import { throughputObservability } from './throughput-observability'

// Persist init state on globalThis to survive Next.js dev-mode module
// re-evaluations (HMR, route compilations) that would otherwise reset
// these flags and spawn duplicate workers / timers.
const _g = globalThis as any
if (!_g.__GAIALOG_INIT_STATE__) {
  _g.__GAIALOG_INIT_STATE__ = {
    isInitialized: false,
    isInitializing: false,
    initializationError: null as Error | null,
    initializationAttempts: 0,
  }
}
const _initState: {
  isInitialized: boolean
  isInitializing: boolean
  initializationError: Error | null
  initializationAttempts: number
} = _g.__GAIALOG_INIT_STATE__
const MAX_INIT_ATTEMPTS = 3

/**
 * Initialize all worker services automatically
 * This is safe to call multiple times - it will only initialize once
 */
export async function autoInitializeWorkers(): Promise<{
  success: boolean
  message: string
  status?: any
  error?: string
}> {
  // Return immediately if already initialized
  if (_initState.isInitialized) {
    return {
      success: true,
      message: 'Workers already initialized and running',
      status: getWorkerStatus()
    }
  }

  // Prevent multiple concurrent initializations
  if (_initState.isInitializing) {
    return {
      success: false,
      message: 'Initialization already in progress',
      error: 'Concurrent initialization attempt blocked'
    }
  }

  // Check if we've exceeded max attempts
  if (_initState.initializationAttempts >= MAX_INIT_ATTEMPTS && _initState.initializationError) {
    return {
      success: false,
      message: 'Maximum initialization attempts exceeded',
      error: _initState.initializationError.message
    }
  }

  const runtimeControl = getRuntimeControlState()
  if (!runtimeControl.workerProcessEnabled) {
    logWorkerProcessSkip('worker-auto-init')
    return {
      success: true,
      message: 'Background workers disabled for this runtime',
      status: getWorkerStatus()
    }
  }

  const mutatorControl = getMutatorControlState()
  if (!mutatorControl.mutatorsEnabled) {
    logMutatorSkip('worker-auto-init')
    return {
      success: true,
      message: 'Background mutators delegated to the primary run-workers process',
      status: getWorkerStatus()
    }
  }

  _initState.isInitializing = true
  _initState.initializationAttempts++

  try {
    console.log('🚀 Auto-initializing GaiaLog workers...')
    
    // Step 1: Recompute configs from current env then apply budgets
    recomputeProviderConfigs()
    await initializeProviderBudgets()
    console.log('✅ Provider budgets initialized')

    // Step 2: Check configuration
    const hasPrivateKeys = bsvConfig.wallets.privateKeys.length > 0
    const hasArcKey = bsvConfig.api.arcApiKey.length > 0
    
    console.log(`📋 Configuration Status:`)
    console.log(`   Private Keys: ${hasPrivateKeys ? '✅ Loaded' : '⚠️ Missing'}`)
    console.log(`   ARC API Key: ${hasArcKey ? '✅ Loaded' : '⚠️ Missing'}`)
    console.log(`   Network: ${bsvConfig.network}`)

    // Step 3: Initialize wallet manager
    if (!walletManager.isReady()) {
      console.log('💼 Initializing wallet manager...')

      if (!hasPrivateKeys) {
        throw new Error('No BSV wallet private keys configured for the worker process')
      }
      
      walletManager.forceInitialize()
      console.log('✅ Wallet manager initialized')
    }

    // Step 4: Initialize worker manager
    if (!workerManager.isReady()) {
      console.log('👥 Initializing worker manager...')
      workerManager.forceInitialize()
    }
    console.log('✅ Worker manager ready')

    // Step 5: Start worker threads
    const workerStats = workerManager.getWorkerStats()
    const runningWorkers = workerStats.filter(w => w.isRunning).length
    
    if (runningWorkers === 0) {
      console.log('🚀 Starting worker threads...')
      workerManager.startAll()
      console.log('✅ Worker threads started')
    } else {
      console.log(`✅ ${runningWorkers} worker(s) already running`)
    }

    // Step 6: Start UTXO maintainer
    console.log('🔧 Starting UTXO maintainer...')
    startUtxoMaintainer()
    console.log('✅ UTXO maintainer started')

    // Step 7: Start queue processing
    console.log('🔄 Starting queue processing...')
    workerQueue.startProcessing()
    console.log('✅ Queue processing started')

    // Mark as successfully initialized
    _initState.isInitialized = true
    _initState.isInitializing = false
    _initState.initializationError = null

    const finalStatus = getWorkerStatus()
    
    console.log('✅ Worker auto-initialization completed successfully')
    console.log('📊 Final Status:', finalStatus)

    return {
      success: true,
      message: 'Workers initialized and running',
      status: finalStatus
    }

  } catch (error) {
    console.error('❌ Worker auto-initialization failed:', error)
    _initState.isInitializing = false
    _initState.initializationError = error instanceof Error ? error : new Error(String(error))

    return {
      success: false,
      message: 'Worker initialization failed',
      error: _initState.initializationError.message
    }
  }
}

/**
 * Get current status of all worker services
 */
export function getWorkerStatus() {
  try {
    const workerStats = workerManager.getWorkerStats()
    const queueStats = workerQueue.getQueueStats()
    const throughput = throughputObservability.getSnapshot(60)
    const rollout = buildRolloutGateStatus(
      throughput.overall.projectedAcceptedPerDay,
      throughput.overall.projectedConfirmedPerDay,
    )
    
    return {
      initialized: _initState.isInitialized,
      runtimeControl: getRuntimeControlState(),
      mutatorControl: getMutatorControlState(),
      spendSource: getSpendSourceStatus(),
      spendSourceMetrics: spendSourceObservability.snapshot(),
      walletManager: walletManager.isReady(),
      workerManager: workerManager.isReady(),
      walletCount: walletManager.getWalletCount(),
      workersRunning: workerStats.filter(w => w.isRunning).length,
      totalWorkers: workerStats.length,
      queueSize: queueStats.totalItems,
      queueThroughputLane: queueStats.throughputLaneItems,
      queueCoverageLane: queueStats.coverageLaneItems,
      queueProcessing: queueStats.processingItems,
      queueCompleted: queueStats.completedItems,
      queueFailed: queueStats.failedItems,
      projectedAcceptedPerDay: throughput.overall.projectedAcceptedPerDay,
      projectedConfirmedPerDay: throughput.overall.projectedConfirmedPerDay,
      requestedRolloutGate: rollout.requestedGate,
      highestUnlockedGate: rollout.highestUnlockedGate,
      hasPrivateKeys: bsvConfig.wallets.privateKeys.length > 0,
      hasArcKey: bsvConfig.api.arcApiKey.length > 0,
      network: bsvConfig.network
    }
  } catch (error) {
    return {
      initialized: false,
      runtimeControl: getRuntimeControlState(),
      mutatorControl: getMutatorControlState(),
      spendSource: getSpendSourceStatus(),
      spendSourceMetrics: spendSourceObservability.snapshot(),
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Check if workers are initialized
 */
export function areWorkersInitialized(): boolean {
  return !getRuntimeControlState().workerProcessEnabled || !getMutatorControlState().mutatorsEnabled || _initState.isInitialized
}

/**
 * Reset initialization state (useful for testing or manual restarts)
 */
export function resetInitialization(): void {
  _initState.isInitialized = false
  _initState.isInitializing = false
  _initState.initializationError = null
  _initState.initializationAttempts = 0
  // Also reset the bootstrap guard so bootstrapWorkers() can re-run
  ;(globalThis as any).__GAIALOG_BOOTSTRAP_DONE__ = false
  console.log('🔄 Worker initialization state reset')
}

/**
 * Gracefully shutdown all workers
 */
export function shutdownWorkers(): void {
  if (!_initState.isInitialized) {
    console.log('⚠️ Workers not initialized, nothing to shutdown')
    return
  }

  console.log('🛑 Shutting down workers...')
  
  try {
    workerManager.stopAll()
    // Note: workerQueue doesn't have a stop method, but the interval will be cleared
    console.log('✅ Workers shutdown complete')
  } catch (error) {
    console.error('❌ Error during worker shutdown:', error)
  }

  _initState.isInitialized = false
}

