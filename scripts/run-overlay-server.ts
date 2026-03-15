import 'dotenv/config'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

import { getOverlayServerConfig } from '@/lib/overlay-config'
import { createOverlayApp } from '@/lib/overlay-server'

async function main() {
  try {
    const config = getOverlayServerConfig()
    const app = await createOverlayApp()
    const server = app.listen(config.port, config.bindHost, () => {
      console.log(`🧩 Overlay server listening on http://${config.bindHost}:${config.port} (${config.hostId})`)
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
