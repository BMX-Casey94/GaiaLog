"use client"

import { useState, useEffect, useCallback } from "react"
import {
  apiClient,
  type AirQualityData,
  type WaterLevelData,
  type SeismicData,
  type AdvancedMetricsData,
} from "@/lib/api-client"
import { useBlockchain } from "@/hooks/use-blockchain"

export function useEnvironmentalData() {
  const [airQuality, setAirQuality] = useState<AirQualityData | null>(null)
  const [waterLevels, setWaterLevels] = useState<WaterLevelData | null>(null)
  const [seismicData, setSeismicData] = useState<SeismicData | null>(null)
  const [advancedMetrics, setAdvancedMetrics] = useState<AdvancedMetricsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const { recordData } = useBlockchain()

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

      try {
        await Promise.all([
          recordData("air_quality", airQualityData),
          recordData("water_levels", waterLevelData),
          recordData("seismic_activity", seismicDataResult),
          recordData("advanced_metrics", advancedMetricsData),
        ])
      } catch (blockchainError) {
        console.error("Failed to record data on blockchain:", blockchainError)
        // Don't fail the entire operation if blockchain recording fails
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch environmental data")
    } finally {
      setLoading(false)
    }
  }, [recordData])

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
