#!/usr/bin/env tsx
import { config } from 'dotenv'
import { resolve } from 'path'
// Load .env.local explicitly (dotenv/config only loads .env by default)
config({ path: resolve(process.cwd(), '.env.local') })

import fs from 'fs'
import path from 'path'
import { upsertStation } from '@/lib/repositories'
import { dbPool } from '@/lib/db'

async function main() {
  const filePath = process.argv[2] || path.resolve(process.cwd(), 'app', 'api', 'data', 'city.list.json')
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }
  console.log(`Seeding OWM stations from: ${filePath}`)
  const raw = fs.readFileSync(filePath, 'utf8')
  let arr: any[]
  try {
    arr = JSON.parse(raw)
  } catch (e) {
    console.error('Failed to parse city.list.json:', e)
    process.exit(1)
  }

  let inserted = 0
  let skipped = 0
  const total = arr.length
  
  for (let i = 0; i < total; i++) {
    const c = arr[i]
    try {
      await upsertStation({
        provider: 'owm',
        station_code: String(c.id),
        name: c.name || null,
        city: c.name || null,
        country: c.country || null,
        lat: typeof c?.coord?.lat === 'number' ? c.coord.lat : null,
        lon: typeof c?.coord?.lon === 'number' ? c.coord.lon : null,
        metadata: null,
      })
      inserted++
      if (inserted % 5000 === 0) console.log(`✅ Upserted ${inserted}/${total}... (skipped: ${skipped})`)
    } catch (e) {
      skipped++
      // Log first error to see what's wrong
      if (skipped === 1) {
        console.error(`\n❌ First error details:`, e)
        console.error(`Station data:`, { provider: 'owm', station_code: String(c.id), name: c.name, country: c.country })
      }
      // Only log every 1000th error to avoid spam
      if (skipped % 1000 === 0) {
        console.warn(`⚠️ Errors encountered: ${skipped} (continuing...)`)
      }
      continue
    }
    
    // Add small delay every 1000 inserts to avoid overwhelming connection pool
    if (i % 1000 === 0 && i > 0) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  console.log(`\n✅ Completed: ${inserted}/${total} OWM stations successfully seeded.`)
  if (skipped > 0) {
    console.log(`⚠️ Skipped: ${skipped} stations due to errors (likely duplicates or connection issues)`)
  }
  console.log(`📊 Success rate: ${((inserted/total)*100).toFixed(1)}%`)
  await dbPool.end()
}

main().catch(async (e) => {
  console.error('Seed failed:', e)
  await dbPool.end().catch(() => {})
  process.exit(1)
})














