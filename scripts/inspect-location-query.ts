/**
 * Read-only inspection of the location-page query plan and the nature of the
 * "locations" in the index.
 *
 * Two questions:
 *   1. Does the families query need the composite index, or is something else
 *      making it slow?
 *   2. How many of the top locations are actual places? `dscovr l1 lagrange
 *      point` is a spacecraft, and publishing a page for it as if it were a
 *      geographic location would be misleading.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()

async function run() {
  const { dbPool } = await import('@/lib/db')
  const client = await dbPool.connect()
  try {
    await client.query('SET statement_timeout = 0')

    const sample = 'dscovr l1 lagrange point'
    console.log(`=== counts for ${JSON.stringify(sample)} ===`)
    const counts = await client.query<{ data_family: string; c: string }>(
      `SELECT data_family, COUNT(*)::text AS c
         FROM overlay_explorer_readings
        WHERE normalized_location = $1
        GROUP BY data_family`,
      [sample],
    )
    for (const r of counts.rows) console.log(`  ${r.data_family}: ${r.c}`)

    console.log('\n=== EXPLAIN (no execution) ===')
    const plan = await client.query(
      `EXPLAIN SELECT data_family, COUNT(*)
         FROM overlay_explorer_readings
        WHERE normalized_location = $1
        GROUP BY data_family`,
      [sample],
    )
    for (const r of plan.rows) console.log('  ' + r['QUERY PLAN'])

    console.log('\n=== existing indexes on overlay_explorer_readings ===')
    const idx = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'overlay_explorer_readings' ORDER BY indexname`,
    )
    for (const r of idx.rows) console.log(`  ${r.indexname}: ${r.indexdef}`)

    console.log('\n=== top 40 locations by reading count ===')
    const top = await client.query<{ display_location: string; reading_count: string }>(
      `SELECT display_location, reading_count::text
         FROM overlay_explorer_location_keys
        ORDER BY reading_count DESC LIMIT 40`,
    )
    for (const r of top.rows) console.log(`  ${r.reading_count.padStart(9)}  ${r.display_location}`)
  } finally {
    client.release()
    await dbPool.end()
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
