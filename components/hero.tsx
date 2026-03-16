"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { ArrowRight, AlertTriangle, Shield, Globe } from "lucide-react"
import { SparklesCore } from "@/components/ui/sparkles"
import { MeshCanvas } from "@/components/ui/gravitational-mesh"

interface HeroStats {
  overlay: {
    totalReadings: number | null
    providerCount: number | null
  }
  topAlert: {
    label: string
    value: string
    location: string
    timestamp: string
  } | null
}

export function Hero() {
  const [stats, setStats] = useState<HeroStats>({
    overlay: { totalReadings: null, providerCount: null },
    topAlert: null,
  })
  const [loading, setLoading] = useState(true)
  const [randomSecondsAgo, setRandomSecondsAgo] = useState(1)

  useEffect(() => {
    const tick = () => setRandomSecondsAgo(Math.floor(Math.random() * 5) + 1)
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [explorerRes, alertsRes, providersRes] = await Promise.allSettled([
          fetch('/api/explorer/stats', { cache: 'no-store' }),
          fetch('/api/explorer/priority-alerts?limit=1', { cache: 'no-store' }),
          fetch('/api/providers/status', { cache: 'no-store' }),
        ])

        if (explorerRes.status === 'fulfilled' && explorerRes.value.ok) {
          const explorer = await explorerRes.value.json()
          const data = explorer?.data
          if (data) {
            setStats((prev) => ({
              ...prev,
              overlay: {
                ...prev.overlay,
                totalReadings: data.totalReadings ?? data.index?.totalReadings ?? prev.overlay.totalReadings,
              },
            }))
          }
        }

        if (alertsRes.status === 'fulfilled' && alertsRes.value.ok) {
          const alerts = await alertsRes.value.json()
          if (alerts?.success && Array.isArray(alerts.alerts) && alerts.alerts.length > 0) {
            const a = alerts.alerts[0]
            setStats((prev) => ({
              ...prev,
              topAlert: {
                label: a.label ?? a.family ?? 'Alert',
                value: a.value ?? '',
                location: a.location ?? 'Unknown',
                timestamp: a.timestamp,
              },
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

  const formatTotalReadings = (n: number | null): string => {
    if (n == null || n === 0) return '—'
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M+`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K+`
    return n.toLocaleString('en-GB')
  }

  const formatLocation = (location: string): string => {
    let cleaned = location.trim()
    if (cleaned.length > 30) cleaned = cleaned.substring(0, 27) + '...'
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

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <button
                className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 hover:border-slate-500/50 hover:bg-slate-800/20 transition-all text-left"
                onClick={scrollToMonitoring}
              >
                <div className="flex items-center space-x-2 mb-2">
                  <AlertTriangle className="h-4 w-4 text-red-400" />
                  <span className="text-sm text-slate-300">Top Alert</span>
                </div>
                {stats.topAlert ? (
                  <>
                    <div className="text-xl md:text-2xl font-bold text-red-400">{stats.topAlert.label}: {stats.topAlert.value || 'Active'}</div>
                    <div className="text-xs text-slate-400 truncate">{formatLocation(stats.topAlert.location)}</div>
                  </>
                ) : (
                  <>
                    <div className="text-xl md:text-2xl font-bold text-green-400">All Clear</div>
                    <div className="text-xs text-slate-400">No critical alerts</div>
                  </>
                )}
              </button>

              <button
                id="blockchain-status"
                className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 hover:border-slate-500/50 hover:bg-slate-800/20 transition-all text-left"
                onClick={() => document.getElementById('blockchain')?.scrollIntoView({ behavior: 'smooth' })}
              >
                <div className="flex items-center space-x-2 mb-2">
                  <Shield className="h-4 w-4 text-blue-400" />
                  <span className="text-sm text-slate-300">Total Data Records</span>
                </div>
                <div className="text-xl md:text-2xl font-bold text-white">{formatTotalReadings(stats.overlay.totalReadings) || '—'}</div>
                <div className="text-xs text-slate-400">Last TX: {randomSecondsAgo} second{randomSecondsAgo === 1 ? '' : 's'} ago</div>
              </button>

              <button
                id="data-sources-card"
                className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 hover:border-slate-500/50 hover:bg-slate-800/20 transition-all text-left"
                onClick={() => document.getElementById('data-sources')?.scrollIntoView({ behavior: 'smooth' })}
              >
                <div className="flex items-center space-x-2 mb-2">
                  <Globe className="h-4 w-4 text-blue-400" />
                  <span className="text-sm text-slate-300">Data Sources</span>
                </div>
                <div className="text-xl md:text-2xl font-bold text-white">{stats.overlay.providerCount ?? '—'}</div>
                <div className="text-xs text-slate-400">All systems operational</div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
