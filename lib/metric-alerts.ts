/**
 * Shared severity scoring for genuine sensor metrics (air / water / seismic /
 * environmental). Intentionally excludes on-chain priority / event families
 * (volcanic, natural_events, etc.) — those belong on the On-chain card only.
 */

export type MetricAlertType = 'air' | 'water' | 'seismic' | 'environmental'
export type MetricSeverity = 'low' | 'moderate' | 'high' | 'critical'

export const SEVERITY_RANK: Record<MetricSeverity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
}

export const METRIC_ALERT_LABELS: Record<MetricAlertType, string> = {
  air: 'Air Quality',
  water: 'Water Levels',
  seismic: 'Seismic',
  environmental: 'Environmental',
}

export interface MetricAlert {
  type: MetricAlertType
  severity: MetricSeverity
  value: number
  location: string
  timestamp: string
  source: string
  details: string
}

export interface MetricEnvironmentalData {
  airQuality: {
    aqi: number | null
    pm25: number | null
    location: string
    timestamp: string
    source: string
  } | null
  waterLevels: {
    river_level: number
    location: string
    timestamp: string
    source: string
  } | null
  seismic: {
    magnitude: number | null
    depth: number | null
    location: string
    timestamp: string
    source: string
  } | null
  advancedMetrics: {
    environmental_quality_score: number | null
    scoreDisplay: number | null
    uv_index: number | null
    uvDisplay: number | null
    location: string
    timestamp: string
    source: string
  } | null
}

type LatestReading = {
  family: string
  location: string
  timestamp: string
  provider?: string
  metrics: Record<string, unknown>
}

function toFixed(n: unknown, digits = 1): string {
  const num = Number(n)
  if (!Number.isFinite(num)) return ''
  return num.toFixed(digits)
}

/** Map overlay latest-readings rows into the shape used by dashboard / hero. */
export function readingsToEnvironmentalData(
  readings: LatestReading[],
): MetricEnvironmentalData {
  const byFamily = (f: string) => readings.find((r) => r.family === f) ?? null

  const airRow = byFamily('air_quality')
  const waterRow = byFamily('water_levels')
  const seismicRow = byFamily('seismic_activity')
  const advRow = byFamily('advanced_metrics')

  return {
    airQuality: airRow
      ? {
          aqi: (airRow.metrics.aqi ?? airRow.metrics.air_quality_index ?? null) as number | null,
          pm25: (airRow.metrics.pm25 ?? airRow.metrics.fine_particulate_matter_pm25 ?? null) as number | null,
          location: airRow.location,
          timestamp: airRow.timestamp,
          source: airRow.provider ?? 'overlay',
        }
      : null,
    waterLevels: waterRow
      ? {
          river_level: Number(
            waterRow.metrics.river_level ?? waterRow.metrics.sea_level ?? waterRow.metrics.level ?? 0,
          ),
          location: waterRow.location,
          timestamp: waterRow.timestamp,
          source: waterRow.provider ?? 'overlay',
        }
      : null,
    seismic: seismicRow
      ? {
          magnitude: (seismicRow.metrics.magnitude ?? null) as number | null,
          depth: (seismicRow.metrics.depth ?? seismicRow.metrics.depth_km ?? null) as number | null,
          location: seismicRow.location,
          timestamp: seismicRow.timestamp,
          source: seismicRow.provider ?? 'overlay',
        }
      : null,
    advancedMetrics: advRow
      ? (() => {
          const rawScore =
            advRow.metrics.environmental_quality_score ?? advRow.metrics.environmental_score
          const normalized =
            typeof rawScore === 'number' && rawScore <= 1 ? rawScore * 100 : (rawScore as number | null)
          return {
            environmental_quality_score: normalized ?? null,
            scoreDisplay: typeof normalized === 'number' ? normalized : null,
            uv_index: (advRow.metrics.uv_index ?? null) as number | null,
            uvDisplay: typeof advRow.metrics.uv_index === 'number' ? advRow.metrics.uv_index : null,
            location: advRow.location,
            timestamp: advRow.timestamp,
            source: advRow.provider ?? 'overlay',
          }
        })()
      : null,
  }
}

/** Build moderate+ alerts from genuine sensor metrics only. */
export function processDataIntoAlerts(data: MetricEnvironmentalData): MetricAlert[] {
  const alerts: MetricAlert[] = []

  if (data.airQuality) {
    const aqi = data.airQuality.aqi
    const pm25 = Number(data.airQuality.pm25)
    let severity: MetricSeverity = 'low'

    if (Number.isFinite(aqi as number)) {
      const aqiNum = aqi as number
      if (aqiNum >= 0 && aqiNum <= 5) {
        if (aqiNum >= 5) severity = 'critical'
        else if (aqiNum >= 4) severity = 'high'
        else if (aqiNum >= 3) severity = 'moderate'
      } else {
        if (aqiNum > 150) severity = 'critical'
        else if (aqiNum > 100) severity = 'high'
        else if (aqiNum > 50) severity = 'moderate'
      }
    }

    if (Number.isFinite(pm25)) {
      const pmSeverity: MetricSeverity =
        pm25 > 55.4 ? 'critical' : pm25 > 35.4 ? 'high' : pm25 > 12 ? 'moderate' : 'low'
      if (SEVERITY_RANK[pmSeverity] > SEVERITY_RANK[severity]) severity = pmSeverity
    }

    if (severity !== 'low') {
      alerts.push({
        type: 'air',
        severity,
        value: Number(aqi),
        location: data.airQuality.location,
        timestamp: data.airQuality.timestamp,
        source: data.airQuality.source,
        details: `AQI: ${aqi} • PM2.5: ${toFixed(data.airQuality.pm25, 1)} μg/m³`,
      })
    }
  }

  if (data.waterLevels) {
    const level = data.waterLevels.river_level
    let severity: MetricSeverity = 'low'
    if (level > 8) severity = 'critical'
    else if (level > 6) severity = 'high'
    else if (level > 4) severity = 'moderate'

    if (severity !== 'low') {
      alerts.push({
        type: 'water',
        severity,
        value: level,
        location: data.waterLevels.location,
        timestamp: data.waterLevels.timestamp,
        source: data.waterLevels.source,
        details: `Level: ${toFixed(level, 2)}m`,
      })
    }
  }

  if (data.seismic) {
    const magnitude = Number(data.seismic.magnitude)
    let severity: MetricSeverity = 'low'
    if (magnitude >= 6) severity = 'critical'
    else if (magnitude >= 4.5) severity = 'high'
    else if (magnitude >= 3) severity = 'moderate'

    if (severity !== 'low' && Number.isFinite(magnitude)) {
      alerts.push({
        type: 'seismic',
        severity,
        value: magnitude,
        location: data.seismic.location,
        timestamp: data.seismic.timestamp,
        source: data.seismic.source,
        details: `Magnitude: ${toFixed(magnitude, 1)}M • Depth: ${
          data.seismic.depth != null ? `${toFixed(data.seismic.depth, 1)} (km)` : 'Unknown (km)'
        }`,
      })
    }
  }

  if (data.advancedMetrics) {
    const rawScore = data.advancedMetrics.environmental_quality_score
    const score =
      typeof rawScore === 'number' && rawScore <= 1 ? rawScore * 100 : Number(rawScore)
    let severity: MetricSeverity = 'low'
    if (Number.isFinite(score)) {
      if (score < 30) severity = 'critical'
      else if (score < 50) severity = 'high'
      else if (score < 70) severity = 'moderate'
    }

    if (severity !== 'low' && Number.isFinite(score)) {
      alerts.push({
        type: 'environmental',
        severity,
        value: score,
        location: data.advancedMetrics.location,
        timestamp: data.advancedMetrics.timestamp,
        source: data.advancedMetrics.source,
        details: `Score: ${toFixed(score, 1)}/100 • UV: ${toFixed(data.advancedMetrics.uv_index, 1)}`,
      })
    }
  }

  return alerts
}

/** Highest-severity genuine metric alert (critical preferred). */
export function pickTopMetricAlert(alerts: MetricAlert[]): MetricAlert | null {
  if (alerts.length === 0) return null
  return alerts.reduce((best, a) =>
    SEVERITY_RANK[a.severity] > SEVERITY_RANK[best.severity] ? a : best,
  )
}

export function metricAlertToHeroDisplay(alert: MetricAlert): {
  label: string
  value: string
  location: string
  timestamp: string
} {
  return {
    label: METRIC_ALERT_LABELS[alert.type],
    value: alert.severity.toUpperCase(),
    location: alert.location,
    timestamp: alert.timestamp,
  }
}
