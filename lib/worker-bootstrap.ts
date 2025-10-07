/**
 * Worker Bootstrap Module
 * 
 * This module automatically initializes workers when imported.
 * It's designed to be imported in strategic places to ensure
 * workers start as soon as the application loads.
 */

import { autoInitializeWorkers } from './worker-auto-init'

// Track if we've attempted bootstrap
let bootstrapAttempted = false

/**
 * Bootstrap workers asynchronously
 * This runs in the background without blocking application startup
 */
async function bootstrapWorkers() {
  if (bootstrapAttempted) {
    return
  }
  
  bootstrapAttempted = true
  
  // Small delay to let the app fully initialize
  setTimeout(async () => {
    try {
      console.log('🌱 Bootstrapping workers on application startup...')
      const result = await autoInitializeWorkers()
      
      if (result.success) {
        console.log('✅ Worker bootstrap completed successfully')
      } else {
        console.warn('⚠️ Worker bootstrap failed:', result.error)
        console.warn('⚠️ Workers can be manually started via /api/workers/auto-start')
      }
    } catch (error) {
      console.error('❌ Worker bootstrap error:', error)
      console.warn('⚠️ Workers can be manually started via /api/workers/auto-start')
    }
  }, 2000) // 2 second delay to allow app initialization
}

// Only bootstrap in Node.js environment (not in edge runtime)
if (typeof process !== 'undefined' && process.versions?.node) {
  // Only bootstrap if not in build process
  if (process.env.NEXT_PHASE !== 'phase-production-build') {
    // Mirror standalone worker behavior so API gates allow writes
    try { process.env.GAIALOG_WORKER_PROCESS = '1' } catch {}
    bootstrapWorkers()
  }
}

export { bootstrapWorkers }

