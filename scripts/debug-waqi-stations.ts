import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

import { query, dbPool } from '@/lib/db'

async function main() {
  console.log('🔍 Debugging WAQI stations...\n')
  
  try {
    // Count total WAQI stations
    const total = await query(`SELECT COUNT(*) as count FROM stations WHERE provider = 'waqi'`)
    console.log(`Total WAQI stations: ${total.rows[0].count}`)
    
    // Check first 10 stations
    const first10 = await query(`
      SELECT station_code, name, country, lat, lon
      FROM stations
      WHERE provider = 'waqi'
      ORDER BY station_code
      LIMIT 10
    `)
    
    console.log('\nFirst 10 WAQI stations:')
    console.table(first10.rows)
    
    // Check country distribution
    const byCountry = await query(`
      SELECT country, COUNT(*) as count
      FROM stations
      WHERE provider = 'waqi'
      GROUP BY country
      ORDER BY count DESC
      LIMIT 20
    `)
    
    console.log('\nTop 20 countries by station count:')
    console.table(byCountry.rows)
    
    // Test the exact query the worker uses
    const workerQuery = await query(`
      SELECT station_code, name, country, lat, lon
      FROM stations
      WHERE provider = $1
      ORDER BY station_code
      LIMIT $2
      OFFSET $3
    `, ['waqi', 150, 0])
    
    console.log(`\nWorker query returned: ${workerQuery.rows.length} stations`)
    if (workerQuery.rows.length > 0) {
      console.log('Sample:')
      console.table(workerQuery.rows.slice(0, 5))
    }
    
  } catch (error) {
    console.error('❌ Error:', error)
  }
  
  await dbPool.end()
}

main()

