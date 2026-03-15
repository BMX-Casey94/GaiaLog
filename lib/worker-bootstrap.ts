/**
 * Worker Bootstrap Module
 * 
 * This module automatically initializes workers when imported.
 * It's designed to be imported in strategic places to ensure
 * workers start as soon as the application loads.
 * 
 * IMPORTANT: Uses globalThis to survive Next.js dev-mode module
 * re-evaluations — without this, every HMR cycle would spawn
 * duplicate workers, timers and queue processors.
 */

import { autoInitializeWorkers } from './worker-auto-init'
import { getMutatorControlState, logMutatorSkip } from './mutator-control'
import { getRuntimeControlState, logWorkerProcessSkip } from './runtime-control'

// Persist the bootstrap guard on globalThis so Next.js dev-mode
// module re-evaluation does not reset it and re-run the bootstrap.
const BOOTSTRAP_KEY = '__GAIALOG_BOOTSTRAP_DONE__' as const

/**
 * Bootstrap workers asynchronously
 * This runs in the background without blocking application startup
 */
async function bootstrapWorkers() {
  if ((globalThis as any)[BOOTSTRAP_KEY]) {
    return
  }
  ;(globalThis as any)[BOOTSTRAP_KEY] = true
  
  // Small delay to let the app fully initialize
  setTimeout(async () => {
    try {
      console.log('🌱 Bootstrapping workers on application startup...')
      const result = await autoInitializeWorkers()
      
      if (result.success) {
        console.log('✅ Worker bootstrap completed successfully')
      } else {
        console.warn('⚠️ Worker bootstrap failed:', result.error)
        console.warn('⚠️ Start the dedicated worker via scripts/run-workers.ts or the VPS process manager.')
        // Allow retry on next module evaluation if it failed
        ;(globalThis as any)[BOOTSTRAP_KEY] = false
      }
    } catch (error) {
      console.error('❌ Worker bootstrap error:', error)
      console.warn('⚠️ Start the dedicated worker via scripts/run-workers.ts or the VPS process manager.')
      ;(globalThis as any)[BOOTSTRAP_KEY] = false
    }
  }, 2000) // 2 second delay to allow app initialization
}

// Only bootstrap in Node.js environment (not in edge runtime)
if (typeof process !== 'undefined' && process.versions?.node) {
  // Only bootstrap if not in build process
  if (process.env.NEXT_PHASE !== 'phase-production-build') {
    const runtimeControl = getRuntimeControlState()
    if (!runtimeControl.workerProcessEnabled) {
      logWorkerProcessSkip('worker-bootstrap')
    } else {
      const mutatorControl = getMutatorControlState()
      if (!mutatorControl.mutatorsEnabled) {
        logMutatorSkip('worker-bootstrap')
      } else {
        // Mirror standalone worker behaviour in combined Node runtimes
        // so background collectors are allowed to write on-chain.
        try { process.env.GAIALOG_WORKER_PROCESS = '1' } catch {}
        bootstrapWorkers()
      }
    }
  }
}

export { bootstrapWorkers }

