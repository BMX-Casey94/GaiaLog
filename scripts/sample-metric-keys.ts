/**
 * Read-only sample of `metrics_preview` keys per data family, used to decide
 * which metrics are worth showing on a location page.
 *
 * Some keys are identifiers rather than measurements (`icao24` is an aircraft
 * transponder hex code). Presenting those as environmental readings would be
 * misleading.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()

async function run() {
  const { dbPool } = await import('@/lib/db')
  const client = await dbPool.connect()
  try {
    await client.query('SET statement_timeout = 0')
    const families = await client.query<{ data_family: string; c: string }>(
      `SELECT data_family, COUNT(*)::text AS c
         FROM overlay_explorer_readings
        GROUP BY data_family ORDER BY COUNT(*) DESC`,
    )
    for (const family of families.rows) {
      const sample = await client.query<{ metrics_preview: any }>(
        `SELECT metrics_preview FROM overlay_explorer_readings
          WHERE data_family = $1 AND metrics_preview IS NOT NULL
          LIMIT 3`,
        [family.data_family],
      )
      console.log(`\n=== ${family.data_family} (${family.c} rows) ===`)
      for (const row of sample.rows) {
        const keys = Object.keys(row.metrics_preview ?? {})
        console.log(`  ${keys.join(', ')}`)
      }
    }
  } finally {
    client.release()
    await dbPool.end()
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
