#!/usr/bin/env tsx
import 'dotenv/config'
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
      if (inserted % 5000 === 0) console.log(`Upserted ${inserted}/${total}...`)
    } catch (e) {
      // Log and continue
      if (inserted % 1000 === 0) console.warn(`Error at index ${i}:`, (e as any)?.message || e)
      continue
    }
  }
  console.log(`Completed upserting ${inserted}/${total} OWM stations.`)
  await dbPool.end()
}

main().catch(async (e) => {
  console.error('Seed failed:', e)
  await dbPool.end().catch(() => {})
  process.exit(1)
})









