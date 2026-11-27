/**
 * Read layer for indexable location pages.
 *
 * ── Why only locations with substance get a page ────────────────────────────
 *
 * Measured against production on 2026-11-25: 62,819 location keys, of which
 *
 *   17,653  hold a single reading
 *    9,082  hold 2–4
 *   13,082  hold 5–19
 *   11,534  hold 100–499
 *   18,232  hold 50+
 *
 * Publishing all 62,819 would put ~27,000 near-empty pages into the index.
 * Those pages have no unique value, they compete with each other, and they risk
 * a thin-content assessment against the whole site. The threshold below keeps
 * roughly 18,000 locations that have at least 50 readings — enough history for
 * a page to say something a reader cannot get from the search screen.
 *
 * ── Why pages cannot go stale ───────────────────────────────────────────────
 *
 * `lib/retention.ts` prunes readings by family, but the eligible-rows CTE
 * excludes the newest row per `normalized_location` per family (see
 * `txid NOT IN (SELECT DISTINCT ON (normalized_location) ...)`). So a location
 * that crosses the threshold keeps at least one row per family forever, and
 * `overlay_explorer_location_keys` keeps its row because the AFTER DELETE
 * trigger only garbage-collects at `reading_count <= 0`. A published page can
 * therefore lose its live rows without ever becoming a 404, and
 * `totalRecorded` preserves the pre-pruning count so the copy stays honest.
 */

import { queryWithDeadline } from './db'
import { DATA_FAMILY_DESCRIPTORS } from './stream-registry'

/**
 * Minimum readings recorded for a location before it is considered substantial
 * enough to publish as its own page and include in the sitemap. Must match the
 * predicate used by `getIndexableLocations` so the sitemap and the route agree.
 *
 * Measured against production on 2026-11-25: 14,011 locations hold 50+ readings
 * and have coordinates, but only 2,962 of those also have a name that is a place
 * rather than a provider station code, a coordinate string or an administrative
 * list. 50 is therefore not the binding constraint; the name rule below is.
 */
export const MIN_READINGS_FOR_PAGE = 50

/**
 * SQL predicate: the location's name looks like a place.
 *
 * The location index is not a clean gazetteer. Ordering by reading count returns
 * "DSCOVR L1 Lagrange Point" (a spacecraft, 115,140 readings) first, then NOAA
 * station codes such as "BOU (Boulder)" and "GUA (Guam)", then coordinate
 * strings such as "NL (52.13°N, 5.43°E)" and earthquake descriptors such as
 * "18 km SE of Silver Springs, Nevada". Publishing those as geographic location
 * pages would be misleading, and in the spacecraft's case plainly wrong.
 *
 * This excludes by shape rather than requiring a known-good pattern, so an
 * unfamiliar but genuine place name is not rejected. It is a heuristic: it drops
 * real places whose provider name embeds a station code ("BOU (Boulder)"), and
 * that is the deliberate trade — a missing page is better than a wrong one.
 *
 * `$1` is the minimum reading count.
 */
const NAME_IS_PLACE_LIKE_SQL = `
  length(display_location) BETWEEN 2 AND 48
  AND display_location ~ '^[A-Za-z]'
  AND display_location NOT LIKE '%(%'
  AND display_location NOT LIKE '%;%'
  AND display_location NOT LIKE '%[%'
  AND display_location NOT LIKE '%]%'
  AND display_location !~ '[0-9]'
  AND display_location !~* '(^|[^a-z])(km|latitude|longitude|lagrange|orbit)([^a-z]|$)'
`

/** Full predicate for a publishable location. `$1` binds MIN_READINGS_FOR_PAGE. */
export const PUBLISHABLE_LOCATION_SQL = `
  reading_count >= $1
  AND avg_lat IS NOT NULL
  AND avg_lon IS NOT NULL
  AND ${NAME_IS_PLACE_LIKE_SQL}
`

/**
 * Data families that must never produce a location page.
 *
 * `transport_tracking` records aircraft positions. A page for "Australia"
 * built from that family would list transponder hex codes and altitudes, which
 * is neither an environmental measurement nor a place-based dataset. Aircraft
 * happen to be over a country; that does not make the country an observation
 * site for them.
 */
export const EXCLUDED_FAMILIES = ['transport_tracking'] as const

export interface LocationPageSummary {
  normalizedLocation: string
  displayLocation: string
  totalRecorded: number
  liveReadings: number
  families: Array<{ family: string; label: string; count: number }>
  lat: number | null
  lon: number | null
  firstReading: string | null
  lastReading: string
}

export interface LocationReading {
  txid: string
  dataFamily: string
  familyLabel: string
  readingTs: string
  metrics: Record<string, unknown>
  providerId: string | null
  blockHeight: number
  confirmed: boolean
}

function familyLabel(family: string): string {
  const descriptor = DATA_FAMILY_DESCRIPTORS[family as keyof typeof DATA_FAMILY_DESCRIPTORS]
  return descriptor?.label ?? family.replace(/_/g, ' ')
}

/**
 * JS counterpart of `NAME_IS_PLACE_LIKE_SQL`.
 *
 * Both exist because the sitemap and directory filter in SQL (thousands of rows)
 * while a single page validates in JS (one row already loaded). They must agree:
 * `scripts/verify-location-pages.ts` asserts the two produce the same verdict
 * across a sample of real values, so the pair cannot drift silently.
 */
export function isPlaceLikeName(displayLocation: string): boolean {
  const name = displayLocation ?? ''
  if (name.length < 2 || name.length > 48) return false
  if (!/^[A-Za-z]/.test(name)) return false
  if (/[();[\]]/.test(name)) return false
  if (/[0-9]/.test(name)) return false
  if (/(^|[^a-z])(km|latitude|longitude|lagrange|orbit)([^a-z]|$)/i.test(name)) return false
  return true
}

/**
 * Load everything needed to render one location page.
 *
 * Returns `null` when the location does not exist or falls below the
 * substantial-content threshold, so the caller can 404 rather than publish a
 * thin page that exists only because someone guessed a URL.
 *
 * Deliberately does NOT catch query failures. A timeout or connection error
 * propagates and becomes a 5xx, which tells a crawler to retry; returning `null`
 * would turn a transient database problem into a 404 and deindex real pages.
 * `null` means "this location is not publishable", never "we could not tell".
 */
export async function getLocationPage(
  normalizedLocation: string,
  limit = 25,
): Promise<LocationPageSummary | null> {
  const keyResult = await queryWithDeadline<{
    normalized_location: string
    display_location: string
    reading_count: string
    last_reading_ts: Date
    avg_lat: number | null
    avg_lon: number | null
  }>(
    `SELECT normalized_location,
            display_location,
            reading_count::text AS reading_count,
            last_reading_ts,
            avg_lat,
            avg_lon
       FROM overlay_explorer_location_keys
      WHERE normalized_location = $1`,
    [normalizedLocation],
    // Generous relative to the 4s default: this is the one read a crawler
    // triggers on a cold page, and a timeout here returns 5xx (which prompts a
    // retry) rather than 404. Sized to survive pool contention from the worker
    // fleet without holding a connection long enough to worsen it.
    { label: 'location-key', timeoutMs: 8000 },
  )

  const key = keyResult.rows[0]
  if (!key) return null

  // Enforce the same rule the sitemap and directory use, so a URL that was never
  // published cannot be reached by guessing it. The counts are already loaded,
  // so the name and substance checks are applied in JS rather than by a second
  // round-trip.
  if (Number(key.reading_count) < MIN_READINGS_FOR_PAGE) return null
  if (key.avg_lat == null || key.avg_lon == null) return null
  if (!isPlaceLikeName(key.display_location)) return null

  // Per-family counts and the true recorded total, which survives retention via
  // the archive rollup rather than the live row count.
  const familyResult = await queryWithDeadline<{ data_family: string; c: string }>(
    `SELECT data_family, COUNT(*)::text AS c
       FROM overlay_explorer_readings
      WHERE normalized_location = $1
      GROUP BY data_family
      ORDER BY COUNT(*) DESC`,
    [normalizedLocation],
    { label: 'location-families', timeoutMs: 8000 },
  )

  const liveReadings = familyResult.rows.reduce((sum, row) => sum + Number(row.c), 0)
  const families = familyResult.rows
    .filter((row) => !EXCLUDED_FAMILIES.includes(row.data_family as (typeof EXCLUDED_FAMILIES)[number]))
    .map((row) => ({
      family: row.data_family,
      label: familyLabel(row.data_family),
      count: Number(row.c),
    }))

  // A location whose only content comes from an excluded family has nothing
  // meaningful to publish.
  if (families.length === 0) return null

  // Earliest reading still live. Retention bounds this, and the page says so
  // rather than implying the live window is the whole history.
  const rangeResult = await queryWithDeadline<{ first_ts: Date | null }>(
    `SELECT MIN(reading_ts) AS first_ts
       FROM overlay_explorer_readings
      WHERE normalized_location = $1`,
    [normalizedLocation],
    { label: 'location-range', timeoutMs: 8000 },
  )

  return {
    normalizedLocation: key.normalized_location,
    displayLocation: key.display_location,
    // Recorded count is the larger of the live rows and the maintained rollup,
    // so the figure never understates history that retention has pruned.
    totalRecorded: Math.max(Number(key.reading_count), liveReadings),
    liveReadings,
    families,
    lat: key.avg_lat != null ? Number(key.avg_lat) : null,
    lon: key.avg_lon != null ? Number(key.avg_lon) : null,
    firstReading: rangeResult.rows[0]?.first_ts
      ? new Date(rangeResult.rows[0].first_ts).toISOString()
      : null,
    lastReading: new Date(key.last_reading_ts).toISOString(),
  }
}

/** Most recent readings at a location, for the page body. */
export async function getLocationReadings(
  normalizedLocation: string,
  limit = 25,
): Promise<LocationReading[]> {
  const result = await queryWithDeadline<{
    txid: string
    data_family: string
    reading_ts: Date
    metrics_preview: Record<string, unknown> | null
    provider_id: string | null
    block_height: number
    confirmed: boolean
  }>(
    `SELECT txid, data_family, reading_ts, metrics_preview, provider_id, block_height, confirmed
       FROM overlay_explorer_readings
      WHERE normalized_location = $1
        AND data_family <> ALL($2::text[])
      ORDER BY reading_ts DESC
       LIMIT $3`,
    [normalizedLocation, Array.from(EXCLUDED_FAMILIES), Math.min(Math.max(limit, 1), 100)],
    { label: 'location-readings', timeoutMs: 8000 },
  )

  return result.rows.map((row) => ({
    txid: row.txid,
    dataFamily: row.data_family,
    familyLabel: familyLabel(row.data_family),
    readingTs: new Date(row.reading_ts).toISOString(),
    metrics: (row.metrics_preview ?? {}) as Record<string, unknown>,
    providerId: row.provider_id,
    blockHeight: Number(row.block_height) || 0,
    confirmed: Boolean(row.confirmed),
  }))
}

/**
 * Locations eligible for the sitemap and the directory, most substantial first.
 *
 * Bounded by `limit` because the sitemap protocol caps a single file at 50,000
 * URLs / 50 MB. With the current distribution a limit of 20,000 stays inside
 * that cap while covering every location above the threshold.
 */
export async function getIndexableLocations(
  limit = 20000,
): Promise<Array<{ normalizedLocation: string; displayLocation: string; lastReading: string }>> {
  const result = await queryWithDeadline<{
    normalized_location: string
    display_location: string
    last_reading_ts: Date
  }>(
    `SELECT normalized_location, display_location, last_reading_ts
       FROM overlay_explorer_location_keys
      WHERE ${PUBLISHABLE_LOCATION_SQL}
      ORDER BY reading_count DESC
      LIMIT $2`,
    [MIN_READINGS_FOR_PAGE, Math.min(Math.max(limit, 1), 45000)],
    { label: 'sitemap-locations', timeoutMs: 15000 },
  )

  return result.rows.map((row) => ({
    normalizedLocation: row.normalized_location,
    displayLocation: row.display_location,
    lastReading: new Date(row.last_reading_ts).toISOString(),
  }))
}
