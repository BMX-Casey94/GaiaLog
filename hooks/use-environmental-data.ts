"use client"

import { useState, useEffect, useCallback } from "react"
import {
  apiClient,
  type AirQualityData,
  type WaterLevelData,
  type SeismicData,
  type AdvancedMetricsData,
} from "@/lib/api-client"

export function useEnvironmentalData() {
  const [airQuality, setAirQuality] = useState<AirQualityData | null>(null)
  const [waterLevels, setWaterLevels] = useState<WaterLevelData | null>(null)
  const [seismicData, setSeismicData] = useState<SeismicData | null>(null)
  const [advancedMetrics, setAdvancedMetrics] = useState<AdvancedMetricsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchAllData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const [airQualityData, waterLevelData, seismicDataResult, advancedMetricsData] = await Promise.all([
        apiClient.fetchAirQuality(),
        apiClient.fetchWaterLevels(),
        apiClient.fetchSeismicData(),
        apiClient.fetchAdvancedMetrics(),
      ])

      setAirQuality(airQualityData)
      setWaterLevels(waterLevelData)
      setSeismicData(seismicDataResult)
      setAdvancedMetrics(advancedMetricsData)
      setLastUpdated(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch environmental data")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAllData()

    // Set up polling every 15 minutes (900000ms)
    const interval = setInterval(fetchAllData, 900000)

    return () => clearInterval(interval)
  }, [fetchAllData])

  return {
    airQuality,
    waterLevels,
    seismicData,
    advancedMetrics,
    loading,
    error,
    lastUpdated,
    refetch: fetchAllData,
  }
}
