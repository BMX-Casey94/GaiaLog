/**
 * Read-only verification of the location-page data layer against the live DB.
 *
 * Checks that:
 *   1. A known substantial location resolves and returns sane counts.
 *   2. A location below the threshold is rejected (so it 404s rather than
 *      publishing a thin page).
 *   3. The slug round-trips through the real stored value.
 *   4. The sitemap query returns a bounded, ordered list.
 *
 * Run with: npx tsx scripts/verify-location-pages.ts
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()

async function run() {
  const { dbPool } = await import('@/lib/db')
  const { getLocationPage, getLocationReadings, getIndexableLocations, MIN_READINGS_FOR_PAGE, isPlaceLikeName, PUBLISHABLE_LOCATION_SQL } =
    await import('@/lib/location-pages')
  const { locationToSlug, slugToLocation } = await import('@/lib/location-slug')
  const { pickDisplayMetrics, describeCoverage, formatMetricLabel } = await import(
    '@/lib/location-format'
  )

  let failures = 0
  const fail = (msg: string) => {
    console.error(`FAIL: ${msg}`)
    failures++
  }

  const client = await dbPool.connect()
  let sample: string | null = null
  let thin: string | null = null
  try {
    // Pick a location that actually passes the publication rule, since the
    // highest-count location is deliberately excluded (it is a spacecraft).
    const big = await client.query<{ normalized_location: string }>(
      `SELECT normalized_location FROM overlay_explorer_location_keys
        WHERE ${PUBLISHABLE_LOCATION_SQL}
        ORDER BY reading_count DESC LIMIT 1`,
      [MIN_READINGS_FOR_PAGE],
    )
    sample = big.rows[0]?.normalized_location ?? null

    const small = await client.query<{ normalized_location: string }>(
      `SELECT normalized_location FROM overlay_explorer_location_keys
        WHERE reading_count > 0 AND reading_count < $1
        ORDER BY reading_count ASC LIMIT 1`,
      [MIN_READINGS_FOR_PAGE],
    )
    thin = small.rows[0]?.normalized_location ?? null
  } finally {
    client.release()
  }

  if (!sample) {
    console.error('No locations in the database; cannot verify.')
    await dbPool.end()
    process.exit(1)
  }

  console.log(`sample location: ${JSON.stringify(sample)}`)

  // 1. Slug round-trip on a real stored value.
  const slug = locationToSlug(sample)
  console.log(`  slug: ${slug}`)
  if (slugToLocation(slug) !== sample) fail(`slug did not round-trip for ${JSON.stringify(sample)}`)
  if (!/^[a-z0-9\-~]*$/.test(slug)) fail(`slug has unsafe characters: ${slug}`)

  // 2. Substantial location resolves.
  const page = await getLocationPage(sample)
  if (!page) {
    fail(`getLocationPage returned null for substantial location ${JSON.stringify(sample)}`)
  } else {
    console.log(`  display: ${page.displayLocation}`)
    console.log(`  totalRecorded: ${page.totalRecorded}, liveReadings: ${page.liveReadings}`)
    console.log(`  families: ${page.families.map((f) => `${f.label}=${f.count}`).join(', ')}`)
    console.log(`  coverage: ${describeCoverage(page.firstReading, page.lastReading)}`)
    if (page.totalRecorded < MIN_READINGS_FOR_PAGE) fail('totalRecorded below threshold')
    if (page.families.length === 0) fail('no families returned')
    if (Number.isNaN(new Date(page.lastReading).getTime())) fail('lastReading is not a valid date')
    if (page.totalRecorded < page.liveReadings) fail('totalRecorded is less than liveReadings')

    const readings = await getLocationReadings(sample, 5)
    if (readings.length === 0) fail('no readings returned for a substantial location')
    for (const r of readings) {
      if (!/^[0-9a-f]{64}$/i.test(r.txid)) fail(`txid does not look like a hash: ${r.txid}`)
      if (Number.isNaN(new Date(r.readingTs).getTime())) fail(`bad readingTs: ${r.readingTs}`)
      if (r.familyLabel.length === 0) fail('empty family label')
    }
    if (readings.length > 0) {
      for (const r of readings.slice(0, 3)) {
        const metrics = pickDisplayMetrics(r.metrics, 4, r.dataFamily)
        console.log(
          `  ${r.familyLabel}: ${metrics.map((m) => `${m.label}=${m.value}`).join(', ') || '(none)'}`,
        )
        for (const m of metrics) {
          if (/icao|heading|on ground|station id|provider/i.test(m.label)) {
            fail(`identifier/metadata leaked into display metrics: ${m.label}=${m.value}`)
          }
        }
      }
    }

    // Readings must be newest-first.
    const ts = readings.map((r) => new Date(r.readingTs).getTime())
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] > ts[i - 1]) fail('readings are not ordered newest first')
    }
  }

  // 3. Thin location is rejected.
  if (thin) {
    console.log(`thin location: ${JSON.stringify(thin)} (below threshold)`)
    const thinPage = await getLocationPage(thin)
    if (thinPage !== null) {
      fail(`getLocationPage published a sub-threshold location (${JSON.stringify(thin)})`)
    } else {
      console.log('  correctly rejected -> will 404')
    }
  }

  // 4. Nonexistent location is rejected.
  const missing = await getLocationPage('this-location-does-not-exist-xyz')
  if (missing !== null) fail('getLocationPage returned a page for a nonexistent location')

  // 5. Sitemap query is bounded and ordered.
  const indexable = await getIndexableLocations(50)
  console.log(`indexable sample size: ${indexable.length}`)
  if (indexable.length === 0) fail('getIndexableLocations returned nothing')
  for (const entry of indexable) {
    if (entry.displayLocation.length === 0) fail('empty displayLocation in sitemap entries')
    if (Number.isNaN(new Date(entry.lastReading).getTime())) fail('bad lastReading in sitemap entry')
    if (!/@|\./.test(entry.normalizedLocation) === false) {
      // Values containing @ or . must still encode to a safe slug.
      const s = locationToSlug(entry.normalizedLocation)
      if (!/^[a-z0-9\-~]*$/.test(s)) fail(`unsafe slug from sitemap entry: ${s}`)
    }
  }

  // 6. The SQL and JS name predicates must give the same verdict, or the sitemap
  //    and the route handler would disagree about which pages exist.
  const parity = await (async () => {
    const client2 = await dbPool.connect()
    try {
      const rows = await client2.query<{ display_location: string; sql_ok: boolean }>(
        `SELECT display_location,
                (length(display_location) BETWEEN 2 AND 48
                 AND display_location ~ '^[A-Za-z]'
                 AND display_location NOT LIKE '%(%'
                 AND display_location NOT LIKE '%;%'
                 AND display_location NOT LIKE '%[%'
                 AND display_location NOT LIKE '%]%'
                 AND display_location !~ '[0-9]'
                 AND display_location !~* '(^|[^a-z])(km|latitude|longitude|lagrange|orbit)([^a-z]|$)'
                ) AS sql_ok
           FROM overlay_explorer_location_keys
          ORDER BY reading_count DESC
          LIMIT 500`,
      )
      return rows.rows
    } finally {
      client2.release()
    }
  })()

  let mismatches = 0
  for (const row of parity) {
    const js = isPlaceLikeName(row.display_location)
    if (js !== row.sql_ok) {
      mismatches++
      if (mismatches <= 5) {
        console.error(
          `FAIL predicate mismatch: ${JSON.stringify(row.display_location)} sql=${row.sql_ok} js=${js}`,
        )
      }
    }
  }
  console.log(`predicate parity checked on ${parity.length} rows, ${mismatches} mismatch(es)`)
  if (mismatches > 0) failures += mismatches

  // 7. Label formatting sanity.
  const labels: Array<[string, string]> = [
    ['air_quality_index', 'Air Quality Index'],
    ['pm25', 'PM25'],
    ['temperature_c', 'Temperature (°C)'],
    ['water_level_m', 'Water Level (m)'],
  ]
  for (const [key, expected] of labels) {
    const actual = formatMetricLabel(key)
    if (actual !== expected) {
      console.error(`FAIL: formatMetricLabel(${key}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
      failures++
    }
  }

  await dbPool.end()
  console.log(failures === 0 ? 'PASS — location data layer verified' : `${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
