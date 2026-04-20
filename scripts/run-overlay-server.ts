import dotenv from 'dotenv'
import path from 'path'

const repoRoot = path.resolve(__dirname, '..')
dotenv.config({ path: path.join(repoRoot, '.env.local') })
dotenv.config({ path: path.join(repoRoot, '.env'), override: true })

import { getOverlayServerConfig } from '@/lib/overlay-config'
import { createOverlayApp } from '@/lib/overlay-server'

// Belt-and-braces process-level safety nets. The fix for the actual root
// cause (per-client pg error listeners) lives in lib/db.ts and
// lib/overlay-repository.ts. These handlers are an additional guarantee that
// any *future* missing-listener regression in this codebase or a third-party
// dependency cannot trigger a silent PM2 crash loop. They DELIBERATELY do
// not call process.exit — fail loud, keep serving, let the explicit SIGINT/
// SIGTERM path own termination.
process.on('uncaughtException', (err) => {
  const stack = err instanceof Error ? err.stack || err.message : String(err)
  console.error(`🛡️  [uncaughtException] suppressed (overlay continues): ${stack}`)
})
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? reason.stack || reason.message : String(reason)
  console.error(`🛡️  [unhandledRejection] suppressed (overlay continues): ${detail}`)
})

// Exponential-backoff retry schedule for createOverlayApp(). Startup touches
// the DB (ensureConnected, schema verification, wallet manager init); if
// Supavisor's circuit breaker is transiently open or the network blips, an
// immediate PM2 crash-loop would re-trip the breaker and prolong the outage.
// Total worst-case wait before giving up: ~8 minutes.
const STARTUP_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function createOverlayAppWithRetry(): Promise<Awaited<ReturnType<typeof createOverlayApp>>> {
  const maxAttempts = STARTUP_RETRY_DELAYS_MS.length + 1
  let lastError: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const app = await createOverlayApp()
      if (attempt > 0) {
        console.log(`✅ Overlay startup recovered on attempt ${attempt + 1}/${maxAttempts}`)
      }
      return app
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const isFinalAttempt = attempt >= STARTUP_RETRY_DELAYS_MS.length
      if (isFinalAttempt) {
        console.error(`❌ Overlay startup failed after ${attempt + 1}/${maxAttempts} attempts: ${message}`)
        throw error
      }
      const delayMs = STARTUP_RETRY_DELAYS_MS[attempt]
      console.warn(
        `⚠️  Overlay startup attempt ${attempt + 1}/${maxAttempts} failed: ${message}. ` +
        `Retrying in ${Math.round(delayMs / 1000)}s...`
      )
      await sleep(delayMs)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'unknown overlay startup error'))
}

async function main() {
  try {
    const config = getOverlayServerConfig()
    const app = await createOverlayAppWithRetry()
    const server = app.listen(config.port, config.bindHost, () => {
      console.log(`🧩 Overlay server listening on http://${config.bindHost}:${config.port} (${config.hostId})`)
    })

    // Surface listener errors (e.g. EADDRINUSE) without leaving the process
    // in a half-started state. PM2 will restart cleanly.
    server.on('error', (error) => {
      console.error('❌ Overlay HTTP listener error:', error)
      process.exit(1)
    })

    const shutdown = (signal: string) => {
      console.log(`\n🛑 Shutting down overlay server (${signal})...`)
      server.close((error?: Error) => {
        if (error) {
          console.error('Overlay server shutdown failed:', error)
          process.exit(1)
        }
        console.log('✅ Overlay server shut down cleanly.')
        process.exit(0)
      })
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  } catch (error) {
    console.error('❌ Failed to start overlay server:', error)
    process.exit(1)
  }
}

main()
