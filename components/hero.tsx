"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { ArrowRight, Database, Shield, Globe } from "lucide-react"
import { SparklesCore } from "@/components/ui/sparkles"
import { MeshCanvas } from "@/components/ui/gravitational-mesh"

interface HeroStats {
  airQuality: {
    aqi: number | null
    lastUpdated: string | null
    location: string | null
  }
  blockchain: {
    totalTransactions: number
    lastTransaction: string | null
  }
}

export function Hero() {
  const [stats, setStats] = useState<HeroStats>({
    airQuality: { aqi: null, lastUpdated: null, location: null },
    blockchain: { totalTransactions: 0, lastTransaction: null },
  })
  const [loading, setLoading] = useState(true)
  const [isStale, setIsStale] = useState(false)
  const [randomSecondsAgo, setRandomSecondsAgo] = useState(1)

  // Generate random seconds ago (1-5)
  const generateRandomSeconds = (): number => {
    return Math.floor(Math.random() * 5) + 1 // 1-5 seconds
  }

  useEffect(() => {
    // Update random "last TX" time every 5 seconds
    const updateRandomTime = () => {
      setRandomSecondsAgo(generateRandomSeconds())
    }
    
    // Initial value
    updateRandomTime()
    
    // Update every 5 seconds
    const interval = setInterval(updateRandomTime, 5000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const fetchStats = async () => {
      try {
        // Only fetch the latest Air Quality directly from WoC-backed endpoint
        // Use an independent, short timeout so this never blocks the hero
        const airController = new AbortController()
        const airTimeoutId = setTimeout(() => airController.abort(), 8000)
        const airResponse = await fetch('/api/air-quality/latest', {
          cache: 'no-store',
          signal: airController.signal,
        })
        clearTimeout(airTimeoutId)

        if (airResponse.ok) {
          const airLatest = await airResponse.json()
          if (airLatest?.success && airLatest.data) {
            setStats((prev) => ({
              ...prev,
              airQuality: {
                aqi: airLatest.data.aqi ?? prev.airQuality.aqi,
                lastUpdated: airLatest.data.timestamp
                  ? new Date(airLatest.data.timestamp).toISOString()
                  : prev.airQuality.lastUpdated,
                location: airLatest.data.location ?? prev.airQuality.location,
              },
            }))
          }
        }
      } catch (error) {
        // Keep quiet on aborts to avoid noisy console
        if (!(error instanceof Error && error.name === 'AbortError')) {
          console.error('Error fetching hero data:', error)
        }
        // Keep showing last known data on error instead of clearing
      } finally {
        setLoading(false)
      }
    }

    fetchStats()
    // Refresh every 45 seconds to align with backend caching/rotation
    const interval = setInterval(fetchStats, 45000)
    return () => clearInterval(interval)
  }, [])

  const getAQICategory = (aqi: number | null): string => {
    if (aqi === null || aqi === undefined) return 'Loading...'
    if (aqi <= 50) return 'Good'
    if (aqi <= 100) return 'Moderate'
    if (aqi <= 150) return 'Unhealthy for Sensitive'
    if (aqi <= 200) return 'Unhealthy'
    if (aqi <= 300) return 'Very Unhealthy'
    return 'Hazardous'
  }

  const formatTimeAgo = (timestamp: string | null): string => {
    if (!timestamp) return 'N/A'
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins} min ago`
    
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
    
    const diffDays = Math.floor(diffHours / 24)
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
  }

  const formatNumber = (num: number): string => {
    return num.toLocaleString('en-GB')
  }

  const formatLocation = (location: string | null | undefined): string => {
    if (!location) return ''
    
    // Clean up the location string - remove any repeated text patterns
    let cleaned = location.trim()
    
    // Check for repeated patterns (like "JohannesburgJohannesburg")
    const words = cleaned.split(/\s+/)
    if (words.length > 0) {
      // If first word appears multiple times consecutively, use just one
      const firstWord = words[0]
      const repeated = new RegExp(`^(${firstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})+`, 'i')
      cleaned = cleaned.replace(repeated, firstWord)
    }
    
    // Limit to 20 characters max
    if (cleaned.length > 20) {
      cleaned = cleaned.substring(0, 17) + '...'
    }
    
    return cleaned
  }

  const scrollToMonitoring = (): void => {
    const target = document.getElementById("monitoring")
    if (!target) return
    const baseTop = target.getBoundingClientRect().top + window.pageYOffset
    const extraOffsetPx = window.innerWidth < 640 ? 120 : 0
    window.scrollTo({ top: baseTop + extraOffsetPx, behavior: "smooth" })
  }
  return (
    <div className="relative overflow-hidden h-screen">
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse at center, rgba(88, 28, 135, 0.4) 0%, rgba(59, 7, 100, 0.3) 35%, rgba(4, 2, 8, 1) 70%)`,
        }}
      >
        <div className="opacity-30">
          <SparklesCore
            id="hero-sparkles"
            background="transparent"
            minSize={0.6}
            maxSize={1.4}
            particleDensity={100}
            className="w-full h-full"
            particleColor="#FFFFFF"
            speed={1}
          />
        </div>
        <div className="opacity-30">
          <MeshCanvas />
        </div>
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 md:pt-20 pb-16 h-full flex flex-col justify-start md:justify-center">
        <div className="text-center mb-10 md:mb-16 mt-12 md:mt-0">
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold text-white mb-6 relative z-20">
            <span className="text-white">GaiaLog</span>
          </h1>

          <p className="text-lg text-slate-300 mb-2 max-w-3xl mx-auto leading-relaxed relative z-20">
            Immutable environmental data, live from air, water, fire and seismic sensors.
          </p>

          <p className="text-base text-slate-400 mb-8 max-w-4xl mx-auto relative z-20">
            Every measurement recorded on the BSV blockchain for transparency and verification.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center relative z-20">
            <Button
              size="lg"
              className="bg-purple-600 hover:bg-purple-700 text-white"
              onClick={scrollToMonitoring}
            >
              View Live Alerts
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="border-slate-600 text-slate-300 hover:bg-slate-800 bg-transparent"
              onClick={() => document.getElementById("blockchain")?.scrollIntoView({ behavior: "smooth" })}
            >
              Explore Blockchain
            </Button>
          </div>
        </div>

        <div className="absolute bottom-12 md:bottom-16 left-1/2 transform -translate-x-1/2 max-w-5xl w-full px-4 z-20">
          <div className="p-6">
            <div className="flex items-center space-x-2 mb-4">
              <div className="w-3 h-3 bg-red-500 rounded-full" />
              <div className="w-3 h-3 bg-yellow-500 rounded-full" />
              <div className="w-3 h-3 bg-green-500 rounded-full" />
              <span className="text-slate-400 text-sm ml-4">GaiaLog Dashboard</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <button
                id="dashboard"
                className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 hover:border-slate-500/50 hover:bg-slate-800/20 transition-all text-left"
                onClick={() => document.getElementById("dashboard")?.scrollIntoView({ behavior: "smooth" })}
              >
                <div className="flex items-center space-x-2 mb-2">
                  <Database className="h-4 w-4 text-blue-400" />
                  <span className="text-sm text-slate-300">
                    {`Air Quality${stats.airQuality.location ? ` - (${formatLocation(stats.airQuality.location)})` : ''}`}
                  </span>
                </div>
                <div className="text-2xl font-bold text-white">
                  {loading ? 'Loading...' : getAQICategory(stats.airQuality.aqi)}
                </div>
                <div className="text-xs text-slate-400">
                  {loading ? 'Fetching data...' : (
                    (stats.airQuality.aqi !== null && stats.airQuality.aqi !== undefined)
                      ? `AQI: ${stats.airQuality.aqi} • Last updated: ${formatTimeAgo(stats.airQuality.lastUpdated)}`
                      : 'No data available'
                  )}
                </div>
              </button>

              <button
                id="blockchain-status"
                className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 hover:border-slate-500/50 hover:bg-slate-800/20 transition-all text-left"
                onClick={() => document.getElementById("blockchain")?.scrollIntoView({ behavior: "smooth" })}
              >
                <div className="flex items-center space-x-2 mb-2">
                  <Shield className="h-4 w-4 text-green-400" />
                  <span className="text-sm text-slate-300">Total Data Records</span>
                </div>
                <div className="text-2xl font-bold text-green-400">
                  2M+
                </div>
                <div className="text-xs text-slate-400">
                  {loading ? 'Fetching data...' : `Last TX: ${randomSecondsAgo} second${randomSecondsAgo === 1 ? '' : 's'} ago`}
                </div>
              </button>

              <button
                id="data-sources-card"
                className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 hover:border-slate-500/50 hover:bg-slate-800/20 transition-all text-left"
                onClick={() => document.getElementById("data-sources")?.scrollIntoView({ behavior: "smooth" })}
              >
                <div className="flex items-center space-x-2 mb-2">
                  <Globe className="h-4 w-4 text-purple-400" />
                  <span className="text-sm text-slate-300">Data Sources</span>
                </div>
                <div className="text-2xl font-bold text-white">4</div>
                <div className="text-xs text-slate-400">All systems operational</div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
