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

// Global state to track initialization
let isInitialized = false
let isInitializing = false
let initializationError: Error | null = null
let initializationAttempts = 0
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
  if (isInitialized) {
    return {
      success: true,
      message: 'Workers already initialized and running',
      status: getWorkerStatus()
    }
  }

  // Prevent multiple concurrent initializations
  if (isInitializing) {
    return {
      success: false,
      message: 'Initialization already in progress',
      error: 'Concurrent initialization attempt blocked'
    }
  }

  // Check if we've exceeded max attempts
  if (initializationAttempts >= MAX_INIT_ATTEMPTS && initializationError) {
    return {
      success: false,
      message: 'Maximum initialization attempts exceeded',
      error: initializationError.message
    }
  }

  isInitializing = true
  initializationAttempts++

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
    isInitialized = true
    isInitializing = false
    initializationError = null

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
    isInitializing = false
    initializationError = error instanceof Error ? error : new Error(String(error))

    return {
      success: false,
      message: 'Worker initialization failed',
      error: initializationError.message
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
      initialized: isInitialized,
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
  return isInitialized
}

/**
 * Reset initialization state (useful for testing or manual restarts)
 */
export function resetInitialization(): void {
  isInitialized = false
  isInitializing = false
  initializationError = null
  initializationAttempts = 0
  console.log('🔄 Worker initialization state reset')
}

/**
 * Gracefully shutdown all workers
 */
export function shutdownWorkers(): void {
  if (!isInitialized) {
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

  isInitialized = false
}

