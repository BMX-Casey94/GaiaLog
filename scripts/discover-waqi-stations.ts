import { config } from 'dotenv'
import { resolve } from 'path'
// Load .env.local explicitly (dotenv/config only loads .env by default)
config({ path: resolve(process.cwd(), '.env.local') })

import { ensureWaqiStationIndex } from '../lib/data-collector'

async function main() {
  console.log('🌍 Discovering WAQI stations globally...')
  console.log('This will scan the world map and persist stations to the database.')
  
  try {
    // Scan 100 tiles (should cover most of the world)
    await ensureWaqiStationIndex(100)
    console.log('✅ WAQI station discovery complete!')
    console.log('Workers can now collect air quality data from discovered stations.')
  } catch (error) {
    console.error('❌ Error discovering WAQI stations:', error)
    process.exit(1)
  }
}

main()

