/**
 * Presentation helpers for location pages.
 *
 * Readings carry a free-form `metrics_preview` JSONB whose keys vary by
 * provider (for example `pm25`, `temperature_c`, `air_quality_index`). These
 * helpers turn those into readable labels without inventing units that the
 * underlying payload did not supply.
 */

/** Units implied by a metric key suffix. Only applied where the suffix is unambiguous. */
const SUFFIX_UNITS: Array<[RegExp, string]> = [
  [/_c$/, "°C"],
  [/_f$/, "°F"],
  [/_pct$/, "%"],
  [/_percent$/, "%"],
  [/_km$/, "km"],
  [/_m$/, "m"],
  [/_mb$/, "hPa"],
  [/_hpa$/, "hPa"],
  [/_ppm$/, "ppm"],
  [/_ppb$/, "ppb"],
  [/_ugm3$/, "µg/m³"],
  [/_kmh$/, "km/h"],
  [/_ms$/, "m/s"],
  [/_mm$/, "mm"],
]

/** Acronyms and short forms that should render in upper case. */
const ACRONYMS = new Set([
  "aqi", "pm25", "pm10", "pm1", "uv", "co", "co2", "no2", "so2", "o3", "ch4",
  "ph", "ec", "tds", "lat", "lon", "id", "no", "nh3", "voc", "psi", "rssi",
])

/**
 * Turn a metric key into a human label.
 *
 * `air_quality_index` → "Air quality index"
 * `pm25`              → "PM25"
 * `temperature_c`     → "Temperature (°C)"
 */
export function formatMetricLabel(key: string): string {
  const unit = SUFFIX_UNITS.find(([pattern]) => pattern.test(key))
  const base = unit ? key.replace(unit[0], "") : key

  const words = base
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase()
      if (ACRONYMS.has(lower)) return lower.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })

  const label = words.join(" ")
  return unit ? `${label} (${unit[1]})` : label
}

/**
 * Format a metric value for display.
 *
 * Numbers are rounded by magnitude so a reading does not print fifteen decimal
 * places, and `null`/`undefined` are omitted by the caller rather than shown as
 * "null".
 */
export function formatMetricValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    if (Number.isInteger(value)) return value.toLocaleString("en-GB")
    const abs = Math.abs(value)
    const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 4
    return value.toLocaleString("en-GB", { maximumFractionDigits: digits })
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => formatMetricValue(v)).filter(Boolean)
    return parts.length > 0 ? parts.join(", ") : null
  }
  if (typeof value === "object") return null
  return String(value)
}

import { getKeyMetrics } from "@/lib/family-metrics"

/** Coordinates used to derive a location identifier are not useful as metrics. */
const NON_MEASUREMENT_KEYS = new Set([
  // Coordinates — the location is already named on the page.
  "lat", "lon", "latitude", "longitude",
  // Structural / provenance metadata.
  "family", "provider_id", "providerid", "source", "unit_name", "parameter",
  "qualifier", "dataset_id", "family_id",
  // Record identifiers used by upstream providers.
  "station_id", "station_reference", "measure_id", "application_ref",
  "icao24", "id", "ref", "reference",
  // Names already conveyed by the page heading or the family label.
  "station_name", "town", "river_name", "catchment_name", "flood_area",
  "proposal", "origin_country", "phylum", "kingdom",
])

/**
 * Select the metrics worth showing for one reading.
 *
 * Delegates to `getKeyMetrics`, which already holds a per-family builder
 * (`lib/family-metrics.ts`) with correct units and labels — for example
 * `river_level_m` → "River Level 1.23 m". Reimplementing that here would
 * duplicate knowledge that already exists and would drift from the explorer.
 *
 * The generic path below is only reached when a family has no builder and no
 * recognised metrics, which is why it filters identifiers and metadata keys.
 */
export function pickDisplayMetrics(
  metrics: Record<string, unknown>,
  max = 4,
  dataType?: string,
): Array<{ label: string; value: string }> {
  if (dataType) {
    const familyMetrics = getKeyMetrics(dataType, metrics as Record<string, any>, max)
    if (familyMetrics.length > 0) {
      return familyMetrics.map((metric) => ({ label: metric.label, value: metric.value }))
    }
  }

  const numeric: Array<{ label: string; value: string }> = []
  const textual: Array<{ label: string; value: string }> = []

  for (const key of Object.keys(metrics)) {
    if (NON_MEASUREMENT_KEYS.has(key.toLowerCase())) continue

    const raw = metrics[key]
    const value = formatMetricValue(raw)
    if (value == null) continue

    // Long free text is prose, not a metric, and would break the grid.
    if (typeof raw === "string" && raw.length > 60) continue

    const entry = { label: formatMetricLabel(key), value }
    if (typeof raw === "number") {
      numeric.push(entry)
    } else {
      textual.push(entry)
    }
  }

  return [...numeric, ...textual].slice(0, max)
}

/** Format an ISO timestamp as a UK-English date and time. */
export function formatReadingTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })
}

/** Trailing window description derived from the oldest live reading. */
export function describeCoverage(firstIso: string | null, lastIso: string): string {
  const last = new Date(lastIso)
  if (Number.isNaN(last.getTime())) return "the current index window"
  if (!firstIso) return "the current reading"
  const first = new Date(firstIso)
  if (Number.isNaN(first.getTime())) return "the current index window"
  const days = Math.max(0, Math.round((last.getTime() - first.getTime()) / 86_400_000))
  if (days === 0) return "the last 24 hours"
  if (days === 1) return "the last day"
  if (days < 60) return `the last ${days} days`
  if (days < 730) return `the last ${Math.round(days / 30)} months`
  return `the last ${Math.round(days / 365)} years`
}
