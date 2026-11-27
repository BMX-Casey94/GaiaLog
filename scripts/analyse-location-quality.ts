/**
 * Read-only quality analysis of the location index.
 *
 * Ordering location pages by reading count surfaced station codes, coordinate
 * strings, spacecraft and administrative lists rather than places. This measures
 * how much of the corpus that affects, so the page-selection rule can be based
 * on evidence instead of a guess.
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

    const maxCount = await client.query<{ mx: string; mn: string }>(
      'SELECT MAX(reading_count)::text AS mx, MIN(reading_count)::text AS mn FROM overlay_explorer_location_keys',
    )
    console.log(`reading_count range: ${maxCount.rows[0].mn} .. ${maxCount.rows[0].mx}`)

    // Classify by shape. Each predicate is independent so the counts overlap
    // only where a name genuinely has two problems.
    const shapes: Array<[string, string]> = [
      ['contains parentheses (coordinate string)', `display_location LIKE '%(%)%'`],
      ['contains semicolon (list)', `display_location LIKE '%;%'`],
      ['contains comma (may be fine)', `display_location LIKE '%,%'`],
      ['all upper case', `display_location = UPPER(display_location) AND display_location ~ '[A-Z]'`],
      ['short code (<=6 chars, no space)', `length(display_location) <= 6 AND display_location NOT LIKE '% %'`],
      ['contains digit', `display_location ~ '[0-9]'`],
      ['very long (>60 chars)', `length(display_location) > 60`],
      ['km-direction descriptor', `display_location ~* '^[0-9]+ ?km '`],
      ['latitude/longitude words', `display_location ~* '(latitude|longitude|lagrange|orbit)'`],
    ]

    console.log('\n=== shape of ALL location keys ===')
    for (const [label, predicate] of shapes) {
      const r = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM overlay_explorer_location_keys WHERE ${predicate}`,
      )
      console.log(`  ${String(r.rows[0].c).padStart(6)}  ${label}`)
    }

    console.log('\n=== shape among locations with >= 50 readings ===')
    for (const [label, predicate] of shapes) {
      const r = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM overlay_explorer_location_keys
          WHERE reading_count >= 50 AND ${predicate}`,
      )
      console.log(`  ${String(r.rows[0].c).padStart(6)}  ${label}`)
    }

    // A conservative "looks like a place name" predicate.
    const PLACE_LIKE = `
      length(display_location) BETWEEN 3 AND 40
      AND display_location ~ '^[A-Za-z]'
      AND display_location NOT LIKE '%(%'
      AND display_location NOT LIKE '%;%'
      AND display_location NOT LIKE '%0%'
      AND display_location NOT LIKE '%1%'
      AND display_location NOT LIKE '%2%'
      AND display_location NOT LIKE '%3%'
      AND display_location NOT LIKE '%4%'
      AND display_location NOT LIKE '%5%'
      AND display_location NOT LIKE '%6%'
      AND display_location NOT LIKE '%7%'
      AND display_location NOT LIKE '%8%'
      AND display_location NOT LIKE '%9%'
    `
    for (const min of [1, 50, 100]) {
      const r = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM overlay_explorer_location_keys
          WHERE reading_count >= $1 AND ${PLACE_LIKE}`,
        [min],
      )
      console.log(`\nplace-like locations with >= ${min} readings: ${r.rows[0].c}`)
    }

    console.log('\n=== sample place-like, ordered by count ===')
    const sample = await client.query<{ display_location: string; reading_count: string }>(
      `SELECT display_location, reading_count::text
         FROM overlay_explorer_location_keys
        WHERE reading_count >= 50 AND ${PLACE_LIKE}
        ORDER BY reading_count DESC LIMIT 25`,
    )
    for (const r of sample.rows) {
      console.log(`  ${r.reading_count.padStart(5)}  ${r.display_location}`)
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
