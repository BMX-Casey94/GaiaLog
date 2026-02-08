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
import { initializeProviderBudgets } from './provider-registry'
import { walletManager } from './wallet-manager'
import { bsvConfig } from './bsv-config'

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

  _initState.isInitializing = true
  _initState.initializationAttempts++

  try {
    console.log('🚀 Auto-initializing GaiaLog workers...')
    
    // Step 1: Apply provider budgets from environment
    await initializeProviderBudgets()
    console.log('✅ Provider budgets initialized')

    // Step 2: Check configuration
    const hasPrivateKeys = bsvConfig.wallets.privateKeys.length > 0
    const hasArcKey = bsvConfig.api.arcApiKey.length > 0
    
    console.log(`📋 Configuration Status:`)
    console.log(`   Private Keys: ${hasPrivateKeys ? '✅ Loaded' : '⚠️ Missing (will use test keys)'}`)
    console.log(`   ARC API Key: ${hasArcKey ? '✅ Loaded' : '⚠️ Missing'}`)
    console.log(`   Network: ${bsvConfig.network}`)

    // Step 3: Initialize wallet manager
    if (!walletManager.isReady()) {
      console.log('💼 Initializing wallet manager...')
      
      // If no private keys in production, log warning but continue with test keys
      if (!hasPrivateKeys) {
        console.warn('⚠️ No private keys found in environment')
        console.warn('⚠️ Using test keys - DO NOT USE IN PRODUCTION WITH REAL FUNDS')
        
        // Use test private keys for development/testing
        const testPrivateKeys = [
          'KxAayTuE6JcLfb8hTpvQKahP64wmqE2RRokSv4GF2mTnUvgkeRYc',
          'L24kCohkqdz9suKmvavLCzJKVL2VzcPQVgB2mPXXA9Sdsh79TShu',
          'L2EBxsRWif1QPUaAVRrJ3zorsVA7Wj3Ls9xHwhQ3v5PLztncMKNV'
        ]
        bsvConfig.wallets.privateKeys = testPrivateKeys
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
    
    return {
      initialized: _initState.isInitialized,
      walletManager: walletManager.isReady(),
      workerManager: workerManager.isReady(),
      walletCount: walletManager.getWalletCount(),
      workersRunning: workerStats.filter(w => w.isRunning).length,
      totalWorkers: workerStats.length,
      queueSize: queueStats.totalItems,
      queueProcessing: queueStats.processingItems,
      queueCompleted: queueStats.completedItems,
      queueFailed: queueStats.failedItems,
      hasPrivateKeys: bsvConfig.wallets.privateKeys.length > 0,
      hasArcKey: bsvConfig.api.arcApiKey.length > 0,
      network: bsvConfig.network
    }
  } catch (error) {
    return {
      initialized: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Check if workers are initialized
 */
export function areWorkersInitialized(): boolean {
  return _initState.isInitialized
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

