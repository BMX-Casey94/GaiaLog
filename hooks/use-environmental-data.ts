"use client"

/**
 * Read-only access to the newest persisted reading for each environmental
 * family.
 *
 * These endpoints (`/api/air-quality`, `/api/water-levels`, `/api/seismic`,
 * `/api/advanced-metrics`) only serve rows the collector workers have already
 * written. They never trigger collection or an on-chain write, so polling them
 * is safe from an unauthenticated page.
 */

import { useCallback, useEffect, useRef, useState } from "react"

export interface AirQualityReading {
  collectedAt: string
  location: string | null
  aqi: number | null
  pm25: number | null
  pm10: number | null
  o3: number | null
  no2: number | null
  so2: number | null
  co: number | null
  temperatureC: number | null
  humidityPct: number | null
  pressureMb: number | null
  windKph: number | null
  windDeg: number | null
  source: string | null
}

export interface WaterLevelReading {
  collectedAt: string
  location: string | null
  stationCode: string | null
  levelM: number | null
  tideHeightM: number | null
  waveHeightM: number | null
  salinityPsu: number | null
  dissolvedOxygenMgL: number | null
  turbidityNtu: number | null
  currentSpeedMs: number | null
  currentDirectionDeg: number | null
  windKph: number | null
  windDeg: number | null
  source: string | null
}

export interface SeismicEvent {
  eventId: string | null
  magnitude: number | null
  depthKm: number | null
  location: string | null
  lat: number | null
  lon: number | null
  time: string | null
}

export interface SeismicReading {
  collectedAt: string
  events: SeismicEvent[]
  source: string | null
}

export interface AdvancedReading {
  collectedAt: string
  location: string | null
  soilMoisturePct: number | null
  uvIndex: number | null
  wildfireRisk: number | null
  environmentalScore: number | null
  temperatureC: number | null
  humidityPct: number | null
  pressureMb: number | null
  windKph: number | null
  windDeg: number | null
  lat: number | null
  lon: number | null
  source: string | null
}

export interface EnvironmentalSnapshot {
  airQuality: AirQualityReading | null
  waterLevels: WaterLevelReading | null
  seismic: SeismicReading | null
  advanced: AdvancedReading | null
}

export interface EnvironmentalDataState extends EnvironmentalSnapshot {
  loading: boolean
  error: string | null
  lastUpdated: number | null
  refetch: () => Promise<void>
}

const REFRESH_MS = 5 * 60 * 1000

function num(value: unknown): number | null {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(path, { cache: "no-store" })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    throw new Error(text(body?.error) || `${path} failed (${res.status})`)
  }
  return body
}

function mapAirQuality(json: any): AirQualityReading | null {
  if (!json || json.available === false || !json.timestamp) return null
  return {
    collectedAt: String(json.timestamp),
    location: text(json.location),
    aqi: num(json.aqi),
    pm25: num(json.pm25),
    pm10: num(json.pm10),
    o3: num(json.o3),
    no2: num(json.no2),
    so2: num(json.so2),
    co: num(json.co),
    temperatureC: num(json.temperature),
    humidityPct: num(json.humidity),
    pressureMb: num(json.pressure),
    windKph: num(json.windSpeed),
    windDeg: num(json.windDirection),
    source: text(json.source),
  }
}

function mapWaterLevels(json: any): WaterLevelReading | null {
  if (!json || !json.timestamp) return null
  const station = Array.isArray(json.stations) && json.stations.length > 0 ? json.stations[0] : null
  if (!station) return null
  return {
    collectedAt: String(json.timestamp),
    location: text(station.name),
    stationCode: text(station.id),
    levelM: num(station.level),
    tideHeightM: num(station.tide_height),
    waveHeightM: num(station.wave_height),
    salinityPsu: num(station.salinity),
    dissolvedOxygenMgL: num(station.dissolved_oxygen),
    turbidityNtu: num(station.turbidity),
    currentSpeedMs: num(station.current_speed),
    currentDirectionDeg: num(station.current_direction),
    windKph: num(station.wind_speed),
    windDeg: num(station.wind_direction),
    source: text(json.source),
  }
}

function mapSeismic(json: any): SeismicReading | null {
  if (!json || json.available === false || !json.timestamp) return null
  const events: SeismicEvent[] = Array.isArray(json.recent_events)
    ? json.recent_events.map((event: any) => ({
        eventId: text(event?.id),
        magnitude: num(event?.magnitude),
        depthKm: num(event?.depth),
        location: text(event?.location),
        lat: num(event?.coordinates?.lat),
        lon: num(event?.coordinates?.lon),
        time: text(event?.time),
      }))
    : []
  return {
    collectedAt: String(json.timestamp),
    events,
    source: text(json.source),
  }
}

function mapAdvanced(json: any): AdvancedReading | null {
  if (!json || json.available === false || !json.timestamp) return null
  return {
    collectedAt: String(json.timestamp),
    location: text(json.location),
    soilMoisturePct: num(json.soil_moisture?.value),
    uvIndex: num(json.uv_index?.value),
    wildfireRisk: num(json.wildfire_risk?.level),
    environmentalScore: num(json.environmental_score),
    temperatureC: num(json.temperature_c),
    humidityPct: num(json.humidity_pct),
    pressureMb: num(json.pressure_mb),
    windKph: num(json.wind_kph),
    windDeg: num(json.wind_deg),
    lat: num(json.coordinates?.lat),
    lon: num(json.coordinates?.lon),
    source: text(json.source),
  }
}

/**
 * Loads all four families. A failure in one family does not blank the others;
 * the first error message is surfaced so the operator knows the view is partial.
 */
async function loadSnapshot(): Promise<{ snapshot: EnvironmentalSnapshot; error: string | null }> {
  const [air, water, seismic, advanced] = await Promise.allSettled([
    getJson("/api/air-quality"),
    getJson("/api/water-levels"),
    getJson("/api/seismic"),
    getJson("/api/advanced-metrics"),
  ])

  const errors: string[] = []
  const unwrap = <T,>(result: PromiseSettledResult<T>, label: string): T | null => {
    if (result.status === "fulfilled") return result.value
    errors.push(`${label}: ${result.reason instanceof Error ? result.reason.message : "unavailable"}`)
    return null
  }

  const airJson = unwrap(air, "Air quality")
  const waterJson = unwrap(water, "Water levels")
  const seismicJson = unwrap(seismic, "Seismic")
  const advancedJson = unwrap(advanced, "Advanced metrics")

  return {
    snapshot: {
      airQuality: mapAirQuality(airJson),
      waterLevels: mapWaterLevels(waterJson),
      seismic: mapSeismic(seismicJson),
      advanced: mapAdvanced(advancedJson),
    },
    error: errors.length > 0 ? errors.join("; ") : null,
  }
}

export function useEnvironmentalData(): EnvironmentalDataState {
  const [snapshot, setSnapshot] = useState<EnvironmentalSnapshot>({
    airQuality: null,
    waterLevels: null,
    seismic: null,
    advanced: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const mountedRef = useRef(true)

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const { snapshot: next, error: nextError } = await loadSnapshot()
      if (!mountedRef.current) return
      setSnapshot(next)
      setError(nextError)
      setLastUpdated(Date.now())
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : "Failed to load environmental data")
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refetch()
    const id = setInterval(() => void refetch(), REFRESH_MS)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [refetch])

  return { ...snapshot, loading, error, lastUpdated, refetch }
}
