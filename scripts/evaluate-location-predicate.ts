/**
 * Read-only evaluation of the location-page publication predicate.
 *
 * Note on a bug in the earlier diagnostics: `SELECT reading_count::text ...
 * ORDER BY reading_count DESC` binds ORDER BY to the *text* output column, so
 * it sorted lexicographically ('999' before '115140') and produced a misleading
 * "top locations" list. This script casts only in the output alias so the sort
 * stays numeric.
 *
 * The predicate under test decides which locations deserve a published page.
 * It requires substance (enough readings), a physical fix (coordinates), and a
 * name that is a place rather than a coordinate string, a provider station code
 * or an administrative list.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()

/**
 * Name shape rules. Excludes, rather than includes, so a plausible name is not
 * rejected merely for being unfamiliar.
 */
const NAME_IS_PLACE_LIKE = `
  length(display_location) BETWEEN 2 AND 48
  AND display_location ~ '^[A-Za-z]'
  AND display_location NOT LIKE '%(%'
  AND display_location NOT LIKE '%;%'
  AND display_location NOT LIKE '%[%'
  AND display_location NOT LIKE '%]%'
  AND display_location !~ '[0-9]'
  AND display_location !~* '(^|[^a-z])(km|latitude|longitude|lagrange|orbit)([^a-z]|$)'
`

async function run() {
  const { dbPool } = await import('@/lib/db')
  const client = await dbPool.connect()
  try {
    await client.query('SET statement_timeout = 0')

    console.log('=== genuine top 25 by reading count (numeric sort) ===')
    const top = await client.query<{ n: string; d: string; has_geo: boolean }>(
      `SELECT reading_count::text AS n, display_location AS d,
              (avg_lat IS NOT NULL AND avg_lon IS NOT NULL) AS has_geo
         FROM overlay_explorer_location_keys
        ORDER BY reading_count DESC
        LIMIT 25`,
    )
    for (const r of top.rows) {
      console.log(`  ${r.n.padStart(7)}  geo=${r.has_geo ? 'y' : 'n'}  ${r.d}`)
    }

    for (const min of [50, 100]) {
      const base = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM overlay_explorer_location_keys
          WHERE reading_count >= $1 AND avg_lat IS NOT NULL AND avg_lon IS NOT NULL`,
        [min],
      )
      const combined = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM overlay_explorer_location_keys
          WHERE reading_count >= $1
            AND avg_lat IS NOT NULL AND avg_lon IS NOT NULL
            AND ${NAME_IS_PLACE_LIKE}`,
        [min],
      )
      console.log(
        `\n>= ${min} readings & has coordinates: ${base.rows[0].c}` +
          `  ->  after name filter: ${combined.rows[0].c}`,
      )
    }

    console.log('\n=== sample of PUBLISHED candidates, by count ===')
    const keep = await client.query<{ n: string; d: string }>(
      `SELECT reading_count::text AS n, display_location AS d
         FROM overlay_explorer_location_keys
        WHERE reading_count >= 50
          AND avg_lat IS NOT NULL AND avg_lon IS NOT NULL
          AND ${NAME_IS_PLACE_LIKE}
        ORDER BY reading_count DESC
        LIMIT 30`,
    )
    for (const r of keep.rows) console.log(`  KEEP ${r.n.padStart(6)}  ${r.d}`)

    console.log('\n=== sample of EXCLUDED names by the filter (would have qualified on count) ===')
    const drop = await client.query<{ n: string; d: string }>(
      `SELECT reading_count::text AS n, display_location AS d
         FROM overlay_explorer_location_keys
        WHERE reading_count >= 50
          AND avg_lat IS NOT NULL AND avg_lon IS NOT NULL
          AND NOT (${NAME_IS_PLACE_LIKE})
        ORDER BY reading_count DESC
        LIMIT 30`,
    )
    for (const r of drop.rows) console.log(`  DROP ${r.n.padStart(6)}  ${r.d}`)
  } finally {
    client.release()
    await dbPool.end()
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
