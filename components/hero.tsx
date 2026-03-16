"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { ArrowRight, Database, Shield, Globe, Droplets, Activity, Flame, Mountain, AlertTriangle, Thermometer } from "lucide-react"
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
  overlay: {
    totalReadings: number | null
    byType: Record<string, number>
    providerCount: number | null
  }
  priorityAlerts: Array<{
    family: string
    label: string
    severity: number
    value: string | null
    location: string
    timestamp: string
    txid: string
  }>
}

const FAMILY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  air_quality: Database,
  water_levels: Droplets,
  seismic_activity: Activity,
  flood_risk: AlertTriangle,
  volcanic_activity: Mountain,
  natural_events: Flame,
  space_weather: Activity,
  advanced_metrics: Thermometer,
  default: Database,
}

export function Hero() {
  const [stats, setStats] = useState<HeroStats>({
    airQuality: { aqi: null, lastUpdated: null, location: null },
    blockchain: { totalTransactions: 0, lastTransaction: null },
    overlay: { totalReadings: null, byType: {}, providerCount: null },
    priorityAlerts: [],
  })
  const [loading, setLoading] = useState(true)
  const [randomSecondsAgo, setRandomSecondsAgo] = useState(1)

  const generateRandomSeconds = (): number => Math.floor(Math.random() * 5) + 1

  useEffect(() => {
    const updateRandomTime = () => setRandomSecondsAgo(generateRandomSeconds())
    updateRandomTime()
    const interval = setInterval(updateRandomTime, 5000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [airRes, explorerRes, alertsRes, providersRes] = await Promise.allSettled([
          fetch('/api/air-quality/latest', { cache: 'no-store' }),
          fetch('/api/explorer/stats', { cache: 'no-store' }),
          fetch('/api/explorer/priority-alerts?limit=8', { cache: 'no-store' }),
          fetch('/api/providers/status', { cache: 'no-store' }),
        ])

        if (airRes.status === 'fulfilled' && airRes.value.ok) {
          const airLatest = await airRes.value.json()
          if (airLatest?.success && airLatest.data) {
            setStats((prev) => ({
              ...prev,
              airQuality: {
                aqi: airLatest.data.aqi ?? prev.airQuality.aqi,
                lastUpdated: airLatest.data.timestamp ? new Date(airLatest.data.timestamp).toISOString() : prev.airQuality.lastUpdated,
                location: airLatest.data.location ?? prev.airQuality.location,
              },
            }))
          }
        }

        if (explorerRes.status === 'fulfilled' && explorerRes.value.ok) {
          const explorer = await explorerRes.value.json()
          const data = explorer?.data
          if (data) {
            setStats((prev) => ({
              ...prev,
              overlay: {
                ...prev.overlay,
                totalReadings: data.totalReadings ?? data.index?.totalReadings ?? prev.overlay.totalReadings,
                byType: data.aggregates?.byType ?? data.byType ?? prev.overlay.byType,
              },
            }))
          }
        }

        if (alertsRes.status === 'fulfilled' && alertsRes.value.ok) {
          const alerts = await alertsRes.value.json()
          if (alerts?.success && Array.isArray(alerts.alerts)) {
            setStats((prev) => ({
              ...prev,
              priorityAlerts: alerts.alerts.slice(0, 8).map((a: any) => ({
                family: a.family,
                label: a.label ?? a.family,
                severity: a.severity ?? 50,
                value: a.value ?? null,
                location: a.location ?? 'Unknown',
                timestamp: a.timestamp,
                txid: a.txid,
              })),
            }))
          }
        }

        if (providersRes.status === 'fulfilled' && providersRes.value.ok) {
          const providers = await providersRes.value.json()
          const list = providers?.controls?.providers ?? []
          const count = list.filter((p: any) => p.enabled && p.rolloutEnabled).length
          setStats((prev) => ({
            ...prev,
            overlay: { ...prev.overlay, providerCount: count },
          }))
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          console.error('Error fetching hero data:', error)
        }
      } finally {
        setLoading(false)
      }
    }

    fetchStats()
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

  const formatTotalReadings = (n: number | null): string => {
    if (n == null || n === 0) return '—'
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M+`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K+`
    return formatNumber(n)
  }

  const getDisplayCards = (): Array<{ id: string; label: string; value: string; sub: string; icon: React.ComponentType<{ className?: string }>; onClick?: () => void }> => {
    const cards: Array<{ id: string; label: string; value: string; sub: string; icon: React.ComponentType<{ className?: string }>; onClick?: () => void }> = []

    stats.priorityAlerts.slice(0, 6).forEach((a) => {
      const Icon = FAMILY_ICONS[a.family] ?? FAMILY_ICONS.default
      cards.push({
        id: a.txid || `${a.family}-${cards.length}`,
        label: a.label,
        value: a.value ?? 'Alert',
        sub: `${formatLocation(a.location)} • ${formatTimeAgo(a.timestamp)}`,
        icon: Icon,
        onClick: () => document.getElementById('monitoring')?.scrollIntoView({ behavior: 'smooth' }),
      })
    })

    if (cards.length < 4 && (stats.airQuality.aqi != null || stats.airQuality.location)) {
      cards.push({
        id: 'air',
        label: `Air Quality${stats.airQuality.location ? ` (${formatLocation(stats.airQuality.location)})` : ''}`,
        value: loading ? 'Loading...' : getAQICategory(stats.airQuality.aqi),
        sub: stats.airQuality.aqi != null ? `AQI: ${stats.airQuality.aqi} • ${formatTimeAgo(stats.airQuality.lastUpdated)}` : 'No data',
        icon: Database,
        onClick: () => document.getElementById('dashboard')?.scrollIntoView({ behavior: 'smooth' }),
      })
    }

    cards.push({
      id: 'total',
      label: 'Total Data Records',
      value: formatTotalReadings(stats.overlay.totalReadings) || '2M+',
      sub: `Last TX: ${randomSecondsAgo} second${randomSecondsAgo === 1 ? '' : 's'} ago`,
      icon: Shield,
      onClick: () => document.getElementById('blockchain')?.scrollIntoView({ behavior: 'smooth' }),
    })
    cards.push({
      id: 'sources',
      label: 'Data Sources',
      value: String(stats.overlay.providerCount ?? 4),
      sub: 'All systems operational',
      icon: Globe,
      onClick: () => document.getElementById('data-sources')?.scrollIntoView({ behavior: 'smooth' }),
    })

    return cards.slice(0, 8)
  }

  const displayCards = getDisplayCards()

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
    <div className="relative overflow-hidden h-screen hero-section-container">
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

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 md:pt-20 pb-16 h-full flex flex-col justify-start md:justify-center hero-content-wrapper">
        <div className="text-center mb-10 md:mb-16 mt-12 md:mt-0">
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold text-white mb-6 relative z-20">
            <span className="text-white">GaiaLog</span>
          </h1>

          <p className="text-sm md:text-lg text-slate-300 mb-2 max-w-3xl mx-auto leading-relaxed relative z-20">
            Immutable environmental data, live from{' '}
            <span className="block md:inline">air, water, fire and seismic sensors.</span>
          </p>

          <p className="hidden md:block text-base text-slate-400 mb-8 max-w-4xl mx-auto relative z-20">
            Every measurement recorded on the BSV blockchain for transparency and verification.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center relative z-20">
            <Button
              size="lg"
              variant="purple"
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

        <div className="hero-dashboard absolute bottom-12 md:bottom-16 left-1/2 transform -translate-x-1/2 max-w-5xl w-full px-4 z-20">
          <div className="p-6">
            <div className="flex items-center space-x-2 mb-4">
              <div className="w-3 h-3 bg-red-500 rounded-full" />
              <div className="w-3 h-3 bg-yellow-500 rounded-full" />
              <div className="w-3 h-3 bg-green-500 rounded-full" />
              <span className="text-slate-400 text-sm ml-4">GaiaLog Dashboard</span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {displayCards.map((card) => {
                const Icon = card.icon
                return (
                  <button
                    key={card.id}
                    id={card.id === 'air' ? 'dashboard' : card.id === 'total' ? 'blockchain-status' : card.id === 'sources' ? 'data-sources-card' : undefined}
                    className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 hover:border-slate-500/50 hover:bg-slate-800/20 transition-all text-left"
                    onClick={card.onClick}
                  >
                    <div className="flex items-center space-x-2 mb-2">
                      <Icon className="h-4 w-4 text-blue-400" />
                      <span className="text-sm text-slate-300 truncate">{card.label}</span>
                    </div>
                    <div className="text-xl md:text-2xl font-bold text-white truncate">{card.value}</div>
                    <div className="text-xs text-slate-400 truncate">{card.sub}</div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
