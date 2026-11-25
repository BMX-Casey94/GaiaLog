/**
 * Client-side helpers for the admin dashboard panels.
 *
 * Each panel needs two things from the same table: the newest row, and real
 * aggregate statistics over the last 24 hours. Both are derived from a single
 * `/api/db/*` request so the headline reading and the statistics can never
 * disagree, and each panel only issues one request per refresh.
 *
 * The `/api/db/*` routes cap a page at 500 rows, so aggregates are computed
 * from the 500 most recent rows and flagged with `sampleTruncated` when that
 * cap was hit.
 */

export interface FamilyAggregates {
  /** Mean of the sampled values over the window, or null when there are none. */
  average: number | null
  max: number | null
  min: number | null
  /** Rows whose `collected_at` falls inside the window. */
  totalReadings: number
  /** Rows inside the window that matched `isAlert`. */
  alerts: number
  /** True when the API page cap was reached, so aggregates are a sample. */
  sampleTruncated: boolean
  /** Sampled metric values, newest first. Used for distributions and ranges. */
  values: number[]
}

export interface FamilySample {
  /** Newest row across all time, or null when the table is empty. */
  latest: Record<string, any> | null
  aggregates: FamilyAggregates
  /**
   * The identity the aggregates were restricted to (for example one station),
   * or null when they cover every station.
   */
  groupKey: string | null
  /** Epoch milliseconds at which the sample was received. */
  fetchedAt: number
}

interface SampleOptions {
  /** API route, e.g. /api/db/air-quality */
  endpoint: string
  /** Extracts the numeric metric used for avg/max/min from a DB row. */
  valueOf: (row: Record<string, any>) => number | null
  /** Returns true when a row should count as an alert. */
  isAlert?: (row: Record<string, any>) => boolean
  /** Aggregation window. Defaults to 24 hours. */
  windowMs?: number
  /**
   * Restricts aggregates to the same series as the newest row (one station, one
   * city). Returns the value to pass as the endpoint's `q` filter.
   *
   * Without this, a page of 500 rows spanning many stations would be averaged
   * together. That is wrong for water levels in particular, because every tide
   * gauge has its own datum, so the range would be meaningless.
   */
  narrowTo?: (row: Record<string, any>) => string | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_LIMIT = 500

async function fetchPage(endpoint: string, query?: string | null): Promise<Record<string, any>[]> {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT), sort: 'collected_at_desc' })
  if (query) params.set('q', query)

  const res = await fetch(`${endpoint}?${params.toString()}`, { cache: 'no-store' })

  if (!res.ok) {
    let detail = `Request failed (${res.status})`
    try {
      const body = await res.json()
      if (body?.error) detail = String(body.error)
    } catch {
      // The body was not JSON; keep the status-based message.
    }
    throw new Error(detail)
  }

  const data = await res.json()
  if (data?.success === false) {
    throw new Error(typeof data?.error === 'string' ? data.error : 'Request failed')
  }
  if (!Array.isArray(data?.items)) {
    throw new Error('Unexpected response from the data API')
  }
  return data.items as Record<string, any>[]
}

/**
 * Fetches the newest rows for a data family and derives the aggregates.
 * Throws with a readable message when the endpoint is unhealthy, so callers can
 * show the failure instead of a wall of zeros.
 */
export async function fetchFamilySample({
  endpoint,
  valueOf,
  isAlert,
  windowMs = DAY_MS,
  narrowTo,
}: SampleOptions): Promise<FamilySample> {
  const firstPage = await fetchPage(endpoint)
  const latest = firstPage.length > 0 ? firstPage[0] : null

  if (!latest) {
    return {
      latest: null,
      aggregates: {
        average: null,
        max: null,
        min: null,
        totalReadings: 0,
        alerts: 0,
        sampleTruncated: false,
        values: [],
      },
      groupKey: null,
      fetchedAt: Date.now(),
    }
  }

  // A narrowed request gives one series a dense window, but it costs a second
  // round trip on endpoints that can take tens of seconds. Only pay that when
  // the first page is too thinly spread across series to be useful, and fall
  // back to the unfiltered page if the filtered request fails or matches
  // nothing (the endpoint may not search the column the caller passed).
  const groupKey = narrowTo ? narrowTo(latest) : null
  const MIN_GROUP_ROWS = 20
  let rows = firstPage
  if (groupKey && narrowTo) {
    const matching = firstPage.filter((row) => narrowTo(row) === groupKey).length
    if (matching < MIN_GROUP_ROWS) {
      try {
        const narrowed = await fetchPage(endpoint, groupKey)
        if (narrowed.length > 0) rows = narrowed
      } catch {
        // Keep the unfiltered page.
      }
    }
  }

  const cutoff = Date.now() - windowMs
  const values: number[] = []
  let inWindow = 0
  let alerts = 0

  for (const row of rows) {
    const ts = row?.collected_at ? Date.parse(row.collected_at) : NaN
    if (!Number.isFinite(ts) || ts < cutoff) continue
    inWindow++
    const value = valueOf(row)
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
    if (isAlert?.(row)) alerts++
  }

  return {
    latest,
    aggregates: {
      average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      max: values.length ? Math.max(...values) : null,
      min: values.length ? Math.min(...values) : null,
      totalReadings: inWindow,
      alerts,
      sampleTruncated: rows.length >= PAGE_LIMIT,
      values,
    },
    groupKey,
    fetchedAt: Date.now(),
  }
}

/** Counts values into `[lower, upper)` buckets; the last bucket is inclusive. */
export function bucketValues(
  values: number[],
  buckets: Array<{ label: string; lower: number; upper: number }>,
): Array<{ label: string; count: number; share: number }> {
  const total = values.length
  return buckets.map((bucket, index) => {
    const isLast = index === buckets.length - 1
    const count = values.filter((v) =>
      isLast ? v >= bucket.lower && v <= bucket.upper : v >= bucket.lower && v < bucket.upper,
    ).length
    return {
      label: bucket.label,
      count,
      share: total > 0 ? (count / total) * 100 : 0,
    }
  })
}

/** Parses a Postgres numeric/string value into a finite number, or null. */
export function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Trims and nulls an arbitrary DB text column. */
export function toText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
