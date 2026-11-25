/**
 * Threshold bands for the admin dashboard.
 *
 * These are the published, citable scales (US EPA AQI bands and the Richter
 * magnitude classes). Nothing here is derived from placeholder data: every
 * helper returns "Unknown" rather than guessing when it has no reading.
 */

export interface MetricCategory {
  /** Stable key, useful for tests and analytics. */
  key: string
  /** Text shown to the operator. */
  label: string
  /** Tailwind background for a filled Badge. */
  className: string
}

const UNKNOWN: MetricCategory = {
  key: "unknown",
  label: "Unknown",
  className: "bg-gray-500 text-white",
}

/** US EPA AQI bands, as used by WAQI and OpenWeatherMap. */
export function getAqiCategory(aqi: number | null | undefined): MetricCategory {
  if (aqi == null || !Number.isFinite(aqi)) return UNKNOWN
  if (aqi <= 50) return { key: "good", label: "Good", className: "bg-green-600 text-white" }
  if (aqi <= 100) return { key: "moderate", label: "Moderate", className: "bg-yellow-600 text-white" }
  if (aqi <= 150)
    return {
      key: "sensitive",
      label: "Unhealthy for sensitive groups",
      className: "bg-orange-600 text-white",
    }
  if (aqi <= 200) return { key: "unhealthy", label: "Unhealthy", className: "bg-red-600 text-white" }
  if (aqi <= 300) return { key: "very-unhealthy", label: "Very unhealthy", className: "bg-purple-600 text-white" }
  return { key: "hazardous", label: "Hazardous", className: "bg-red-900 text-white" }
}

/** Richter magnitude classes. */
export function getMagnitudeCategory(magnitude: number | null | undefined): MetricCategory {
  if (magnitude == null || !Number.isFinite(magnitude)) return UNKNOWN
  if (magnitude < 2) return { key: "micro", label: "Micro", className: "bg-green-600 text-white" }
  if (magnitude < 3) return { key: "minor", label: "Minor", className: "bg-blue-600 text-white" }
  if (magnitude < 4) return { key: "light", label: "Light", className: "bg-yellow-600 text-white" }
  if (magnitude < 5) return { key: "moderate", label: "Moderate", className: "bg-orange-600 text-white" }
  if (magnitude < 6) return { key: "strong", label: "Strong", className: "bg-red-600 text-white" }
  if (magnitude < 7) return { key: "major", label: "Major", className: "bg-purple-600 text-white" }
  return { key: "great", label: "Great", className: "bg-red-900 text-white" }
}

/** Beaufort-style wind bands, in miles per hour. */
export function getWindCategory(mph: number | null | undefined): MetricCategory {
  if (mph == null || !Number.isFinite(mph)) return UNKNOWN
  if (mph < 12) return { key: "light", label: "Light", className: "bg-sky-600 text-white" }
  if (mph < 25) return { key: "moderate", label: "Moderate", className: "bg-blue-600 text-white" }
  if (mph < 39) return { key: "strong", label: "Strong", className: "bg-orange-600 text-white" }
  return { key: "gale", label: "Gale", className: "bg-red-600 text-white" }
}

/** Environmental score bands for the stored `environmental_score` (0-100). */
export function getScoreCategory(score: number | null | undefined): MetricCategory {
  if (score == null || !Number.isFinite(score)) return UNKNOWN
  if (score >= 80) return { key: "excellent", label: "Excellent", className: "bg-green-600 text-white" }
  if (score >= 60) return { key: "good", label: "Good", className: "bg-blue-600 text-white" }
  if (score >= 40) return { key: "moderate", label: "Moderate", className: "bg-yellow-600 text-white" }
  if (score >= 20) return { key: "poor", label: "Poor", className: "bg-orange-600 text-white" }
  return { key: "critical", label: "Critical", className: "bg-red-600 text-white" }
}

/**
 * Where the current reading sits inside its own 24-hour range (0-100).
 * Returns null when there is not enough data to place it.
 */
export function rangePosition(
  current: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
): number | null {
  if (current == null || min == null || max == null) return null
  if (!Number.isFinite(current) || !Number.isFinite(min) || !Number.isFinite(max)) return null
  const span = max - min
  if (span <= 0) return null
  return Math.min(100, Math.max(0, ((current - min) / span) * 100))
}

/**
 * Position within a 24-hour band, described in words.
 */
export function describeRangePosition(
  current: number | null | undefined,
  average: number | null | undefined,
): MetricCategory {
  if (current == null || average == null) return UNKNOWN
  if (!Number.isFinite(current) || !Number.isFinite(average)) return UNKNOWN
  if (current > average) return { key: "above", label: "Above 24h average", className: "bg-blue-600 text-white" }
  if (current < average) return { key: "below", label: "Below 24h average", className: "bg-sky-600 text-white" }
  return { key: "at", label: "At 24h average", className: "bg-green-600 text-white" }
}
