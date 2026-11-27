/**
 * Read-only diagnostic for the indexable-location-page design.
 *
 * Answers one question: how many locations would get a thin page if every row in
 * overlay_explorer_location_keys were published? Locations that hold only a
 * handful of readings produce near-empty pages, which risks a thin-content
 * penalty rather than earning rankings.
 *
 * Makes no writes and no schema changes.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()

async function run() {
  const { dbPool } = await import('@/lib/db')
  const client = await dbPool.connect()
  try {
    await client.query('SET statement_timeout = 0')

    const total = await client.query<{ c: string }>(
      'SELECT COUNT(*)::text AS c FROM overlay_explorer_location_keys',
    )
    console.log(`total location keys: ${total.rows[0].c}`)

    const dist = await client.query<{ bucket: string; c: string }>(
      `SELECT CASE
                WHEN reading_count >= 1000 THEN '1000+'
                WHEN reading_count >= 500  THEN '500-999'
                WHEN reading_count >= 100  THEN '100-499'
                WHEN reading_count >= 50   THEN '50-99'
                WHEN reading_count >= 20   THEN '20-49'
                WHEN reading_count >= 10   THEN '10-19'
                WHEN reading_count >= 5    THEN '5-9'
                WHEN reading_count >= 2    THEN '2-4'
                ELSE '1'
              END AS bucket,
              COUNT(*)::text AS c
         FROM overlay_explorer_location_keys
        GROUP BY 1`,
    )
    const order = ['1000+', '500-999', '100-499', '50-99', '20-49', '10-19', '5-9', '2-4', '1']
    const map = new Map(dist.rows.map((r) => [r.bucket, Number(r.c)]))
    for (const b of order) console.log(`  ${b.padEnd(8)} ${map.get(b) ?? 0}`)

    for (const min of [5, 10, 20, 50]) {
      const r = await client.query<{ c: string }>(
        'SELECT COUNT(*)::text AS c FROM overlay_explorer_location_keys WHERE reading_count >= $1',
        [min],
      )
      console.log(`locations with >= ${min} readings: ${r.rows[0].c}`)
    }

    // How many locations are shared across more than one family? A location page
    // that aggregates families is only honest if the same string means the same
    // place. Sample the worst offenders.
    const multi = await client.query<{ normalized_location: string; fams: string }>(
      `SELECT normalized_location, COUNT(DISTINCT data_family)::text AS fams
         FROM overlay_explorer_readings
        WHERE normalized_location IS NOT NULL AND normalized_location <> ''
        GROUP BY normalized_location
        HAVING COUNT(DISTINCT data_family) > 1
        ORDER BY COUNT(DISTINCT data_family) DESC
        LIMIT 10`,
    )
    console.log('\nlocations spanning multiple families (top 10):')
    for (const r of multi.rows) console.log(`  ${r.normalized_location} -> ${r.fams} families`)

    const multiCount = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM (
         SELECT normalized_location
           FROM overlay_explorer_readings
          WHERE normalized_location IS NOT NULL AND normalized_location <> ''
          GROUP BY normalized_location
         HAVING COUNT(DISTINCT data_family) > 1
       ) t`,
    )
    console.log(`total locations spanning >1 family: ${multiCount.rows[0].c}`)
  } finally {
    client.release()
    await dbPool.end()
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
