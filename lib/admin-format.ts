/**
 * Formatting helpers shared by the admin panels.
 *
 * Every formatter pins the locale to en-GB so the same input always produces
 * the same string. Anything that depends on the wall clock (for example the
 * "3m ago" labels) must only be rendered after a client-side fetch: the server
 * and the browser clock will never agree, and rendering them during hydration
 * is exactly what produces React error #418.
 */

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

export const MISSING = "—"

type DateInput = number | string | Date | null | undefined

function toDate(value: DateInput): Date | null {
  if (value == null || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "16:13:26" in en-GB, or an em dash when the value is missing/invalid. */
export function formatTime(value: DateInput): string {
  const date = toDate(value)
  return date ? timeFormatter.format(date) : MISSING
}

/** "25 Nov 2026, 16:13" in en-GB, or an em dash when missing/invalid. */
export function formatDateTime(value: DateInput): string {
  const date = toDate(value)
  return date ? dateTimeFormatter.format(date) : MISSING
}

/**
 * Time of day when the value falls on the current local date, otherwise the full
 * date and time.
 *
 * A reading from March rendered as "17:00:00" reads as today's data. Including
 * the date whenever it differs from today keeps a stale reading visible instead
 * of disguised as current.
 */
export function formatReadingTime(value: DateInput, now: number | null = Date.now()): string {
  const date = toDate(value)
  if (!date) return MISSING
  if (now == null) return dateTimeFormatter.format(date)
  const reference = new Date(now)
  const sameDay =
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  return sameDay ? timeFormatter.format(date) : dateTimeFormatter.format(date)
}

/** Age of a reading in milliseconds, or null when the value cannot be parsed. */
export function ageMs(value: DateInput, now: number = Date.now()): number | null {
  const date = toDate(value)
  if (!date) return null
  return now - date.getTime()
}

/**
 * "Just now", "4m ago", "2h ago" or "3d ago".
 *
 * Reads the current clock, so only call this after a client-side fetch.
 */
export function formatTimeAgo(value: DateInput): string {
  const date = toDate(value)
  if (!date) return MISSING
  const diffMs = Date.now() - date.getTime()
  if (!Number.isFinite(diffMs)) return MISSING
  if (diffMs < 0) return "Just now"
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Groups thousands with en-GB separators; returns an em dash when not finite. */export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return MISSING
  return value.toLocaleString("en-GB", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** Formats a measurement with its unit, or an em dash when there is no reading. */
export function formatMetric(
  value: number | null | undefined,
  unit: string,
  digits = 0,
): string {
  if (value == null || !Number.isFinite(value)) return MISSING
  return `${formatNumber(value, digits)}${unit ? ` ${unit}` : ""}`
}

/** Converts kilometres per hour to miles per hour. */
export function kphToMph(kph: number | null | undefined): number | null {
  if (kph == null || !Number.isFinite(kph)) return null
  return kph * 0.621371
}

/** Converts metres to miles. */
export function metresToMiles(metres: number | null | undefined): number | null {
  if (metres == null || !Number.isFinite(metres)) return null
  return metres / 1609.344
}

/** Clamps a value to a 0-100 percentage for use with <Progress />. */
export function toPercent(value: number | null | undefined, max: number): number {
  if (value == null || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.min(100, Math.max(0, (value / max) * 100))
}
