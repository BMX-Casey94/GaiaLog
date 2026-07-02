/**
 * Client-side helpers for the admin dashboard panels.
 *
 * Computes real aggregate statistics (average / max / min / count / alerts)
 * from the internal /api/db/* endpoints instead of placeholder values.
 * Aggregates are calculated over rows collected in the last 24 hours,
 * bounded by the API's 500-row page cap (most recent first).
 */

export interface FamilyAggregates {
  average: number
  max: number
  min: number
  totalReadings: number
  alerts: number
  sampleTruncated: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

interface AggregateOptions {
  /** API route, e.g. /api/db/air-quality */
  endpoint: string
  /** Extracts the numeric metric used for avg/max/min from a DB row. */
  valueOf: (row: Record<string, any>) => number | null
  /** Returns true when a row should count as an alert. */
  isAlert?: (row: Record<string, any>) => boolean
}

export async function fetchFamilyAggregates({
  endpoint,
  valueOf,
  isAlert,
}: AggregateOptions): Promise<FamilyAggregates | null> {
  const res = await fetch(`${endpoint}?limit=500&sort=collected_at_desc`)
  if (!res.ok) return null

  const data = await res.json()
  if (!data?.success || !Array.isArray(data.items)) return null

  const cutoff = Date.now() - DAY_MS
  const recent = data.items.filter((row: Record<string, any>) => {
    const ts = row.collected_at ? Date.parse(row.collected_at) : NaN
    return Number.isFinite(ts) && ts >= cutoff
  })

  const values: number[] = []
  let alerts = 0
  for (const row of recent) {
    const v = valueOf(row)
    if (typeof v === 'number' && Number.isFinite(v)) values.push(v)
    if (isAlert?.(row)) alerts++
  }

  if (values.length === 0) {
    return {
      average: 0,
      max: 0,
      min: 0,
      totalReadings: recent.length,
      alerts,
      sampleTruncated: data.items.length >= 500,
    }
  }

  const sum = values.reduce((a, b) => a + b, 0)
  return {
    average: sum / values.length,
    max: Math.max(...values),
    min: Math.min(...values),
    totalReadings: recent.length,
    alerts,
    sampleTruncated: data.items.length >= 500,
  }
}

export function toNumber(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
