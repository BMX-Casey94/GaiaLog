"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { Button } from "@/components/ui/button"
import { ArrowRight, AlertTriangle, AlertOctagon, AlertCircle, Shield, Globe, MapPin, CheckCircle2 } from "lucide-react"
import {
  metricAlertToHeroDisplay,
  pickTopMetricAlert,
  processDataIntoAlerts,
  readingsToEnvironmentalData,
  type MetricSeverity,
} from "@/lib/metric-alerts"
import { fetchJsonDeduplicated } from "@/lib/client-fetch-cache"

// Heavy canvas visuals are decorative — defer them so they never block first paint.
const SparklesCore = dynamic(
  () => import("@/components/ui/sparkles").then((m) => m.SparklesCore),
  { ssr: false },
)
const MeshCanvas = dynamic(
  () => import("@/components/ui/gravitational-mesh").then((m) => m.MeshCanvas),
  { ssr: false },
)

interface HeroStats {
  overlay: {
    totalReadings: number | null
    providerCount: number | null
  }
  lastRecordAt: number | null
  topAlert: {
    label: string
    value: string
    location: string
    timestamp: string
    severity: MetricSeverity
  } | null
}

function heroAlertStyle(severity: MetricSeverity) {
  switch (severity) {
    case 'critical':
      return {
        card: 'border-red-500/40 bg-red-950/25 hover:border-red-400/60 hover:bg-red-950/35',
        badge: 'bg-red-500/20 text-red-300 border-red-500/40',
        dot: 'bg-red-400',
        value: 'text-red-300',
        iconWrap: 'bg-red-500/15 text-red-400',
        Icon: AlertOctagon,
      }
    case 'high':
      return {
        card: 'border-orange-500/35 bg-orange-950/20 hover:border-orange-400/55 hover:bg-orange-950/30',
        badge: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
        dot: 'bg-orange-400',
        value: 'text-orange-300',
        iconWrap: 'bg-orange-500/15 text-orange-400',
        Icon: AlertTriangle,
      }
    case 'moderate':
      return {
        card: 'border-amber-500/35 bg-amber-950/20 hover:border-amber-400/55 hover:bg-amber-950/30',
        badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
        dot: 'bg-amber-400',
        value: 'text-amber-300',
        iconWrap: 'bg-amber-500/15 text-amber-400',
        Icon: AlertCircle,
      }
    default:
      return {
        card: 'border-emerald-500/30 bg-emerald-950/15 hover:border-emerald-400/50 hover:bg-emerald-950/25',
        badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/35',
        dot: 'bg-emerald-400',
        value: 'text-emerald-300',
        iconWrap: 'bg-emerald-500/15 text-emerald-400',
        Icon: CheckCircle2,
      }
  }
}

function formatRelativeTime(fromMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (diffSec < 60) return `${diffSec} second${diffSec === 1 ? "" : "s"} ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs === 1 ? "" : "s"} ago`
  const diffDays = Math.floor(diffHrs / 24)
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`
}

export function Hero({ initialProviderCount }: { initialProviderCount?: number } = {}) {
  const [stats, setStats] = useState<HeroStats>({
    overlay: { totalReadings: null, providerCount: initialProviderCount ?? null },
    lastRecordAt: null,
    topAlert: null,
  })
  const [now, setNow] = useState(() => Date.now())

  // Tick every 5s so the relative "last record" label stays fresh between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const fetchStats = async (forceRefresh = false) => {
      try {
        const [explorerRes, readingsRes] = await Promise.allSettled([
          fetchJsonDeduplicated<any>('/api/explorer/stats', { ttlMs: 15_000, forceRefresh }),
          // Genuine sensor metrics only — never on-chain event/priority alerts.
          fetchJsonDeduplicated<any>('/api/explorer/latest-readings', { ttlMs: 15_000, forceRefresh }),
        ])

        if (explorerRes.status === 'fulfilled') {
          const data = explorerRes.value?.data
          if (data) {
            const lastUpdatedIso = data.index?.lastUpdated
            const lastUpdatedMs = lastUpdatedIso ? new Date(lastUpdatedIso).getTime() : NaN
            setStats((prev) => ({
              ...prev,
              overlay: {
                ...prev.overlay,
                totalReadings: data.totalReadings ?? data.index?.totalReadings ?? prev.overlay.totalReadings,
              },
              lastRecordAt: Number.isFinite(lastUpdatedMs) ? lastUpdatedMs : prev.lastRecordAt,
            }))
          }
        }

        if (readingsRes.status === 'fulfilled') {
          const latest = readingsRes.value
          const readings = latest?.success && Array.isArray(latest.readings) ? latest.readings : []
          const top = pickTopMetricAlert(processDataIntoAlerts(readingsToEnvironmentalData(readings)))
          setStats((prev) => ({
            ...prev,
            topAlert: top ? { ...metricAlertToHeroDisplay(top), severity: top.severity } : null,
          }))
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          console.error('Error fetching hero data:', error)
        }
      }
    }

    fetchStats(false)
    const interval = setInterval(() => fetchStats(true), 45000)
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
    document.getElementById("monitoring")?.scrollIntoView({ behavior: "smooth" })
  }

  return (
    <div className="relative overflow-hidden min-h-[100svh] flex flex-col">
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 85% 65% at 50% 35%, rgba(88, 28, 135, 0.38) 0%, rgba(59, 7, 100, 0.22) 40%, transparent 75%)`,
          maskImage: "linear-gradient(to bottom, black 78%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, black 78%, transparent 100%)",
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

      <div className="relative max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 flex-1 flex flex-col justify-center gap-10 md:gap-14 pt-28 pb-16 md:pt-32 md:pb-20">
        <div className="text-center">
          <h1 className="font-display text-5xl md:text-6xl lg:text-7xl font-bold mb-6 relative z-20 tracking-tight">
            <span className="gradient-heading">GaiaLog</span>
          </h1>

          <p className="text-sm md:text-lg text-slate-300 mb-1 max-w-3xl mx-auto leading-snug relative z-20">
            Immutable environmental data, live from{' '}
            <span className="block md:inline">air, water, fire and seismic sensors.</span>
          </p>

          <p className="hidden md:block text-base text-slate-400 mb-8 max-w-4xl mx-auto leading-snug relative z-20">
            Every measurement on the BSV blockchain for transparency and verification.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center relative z-20 mt-6 md:mt-0">
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

        <div className="max-w-5xl w-full mx-auto z-20">
          <div className="glass-card glass-card-hover p-5 sm:p-6">
            <div className="flex items-center space-x-2 mb-4">
              <div className="w-3 h-3 bg-red-500 rounded-full" />
              <div className="w-3 h-3 bg-yellow-500 rounded-full" />
              <div className="w-3 h-3 bg-green-500 rounded-full" />
              <span className="text-slate-400 text-sm ml-4">GaiaLog Dashboard</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(() => {
                const alertStyle = heroAlertStyle(stats.topAlert?.severity ?? 'low')
                const AlertIcon = alertStyle.Icon
                return (
                  <button
                    className={`backdrop-blur-md rounded-xl p-4 border transition-all text-left flex flex-col justify-between ${alertStyle.card}`}
                    onClick={scrollToMonitoring}
                  >
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg ${alertStyle.iconWrap}`}>
                          <AlertIcon className="h-4 w-4" />
                        </span>
                        <span className="text-xs font-medium uppercase tracking-wider text-slate-300">Top Alert</span>
                      </div>
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide border ${alertStyle.badge}`}>
                        <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${alertStyle.dot}`} />
                        {stats.topAlert ? stats.topAlert.severity : 'Clear'}
                      </span>
                    </div>
                    {stats.topAlert ? (
                      <div>
                        <div className={`text-lg md:text-xl font-bold leading-snug ${alertStyle.value}`}>
                          {stats.topAlert.label}
                          <span className="text-white font-semibold"> · {stats.topAlert.value || 'Active'}</span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-400">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                          <span className="truncate">{formatLocation(stats.topAlert.location)}</span>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="text-lg md:text-xl font-bold text-emerald-300">All Clear</div>
                        <div className="mt-1.5 text-xs text-slate-400">No critical alerts detected</div>
                      </div>
                    )}
                  </button>
                )
              })()}

              <button
                id="blockchain-status"
                className="bg-purple-950/20 backdrop-blur-md rounded-xl p-4 border border-purple-500/25 hover:border-purple-400/50 hover:bg-purple-950/35 transition-all text-left flex flex-col justify-between"
                onClick={() => document.getElementById('blockchain')?.scrollIntoView({ behavior: 'smooth' })}
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-purple-500/15 text-purple-300">
                    <Shield className="h-4 w-4" />
                  </span>
                  <span className="text-xs font-medium uppercase tracking-wider text-slate-300">Total Data Records</span>
                </div>
                <div>
                  <div className="text-xl md:text-2xl font-bold text-white tabular-nums">{formatTotalReadings(stats.overlay.totalReadings) || '—'}</div>
                  <div className="mt-1.5 text-xs text-slate-400">
                    {stats.lastRecordAt ? `Last record: ${formatRelativeTime(stats.lastRecordAt, now)}` : 'Awaiting data…'}
                  </div>
                </div>
              </button>

              <button
                id="data-sources-card"
                className="bg-purple-950/20 backdrop-blur-md rounded-xl p-4 border border-purple-500/25 hover:border-purple-400/50 hover:bg-purple-950/35 transition-all text-left flex flex-col justify-between"
                onClick={() => document.getElementById('data-sources')?.scrollIntoView({ behavior: 'smooth' })}
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-500/15 text-indigo-300">
                    <Globe className="h-4 w-4" />
                  </span>
                  <span className="text-xs font-medium uppercase tracking-wider text-slate-300">Data Sources</span>
                </div>
                <div>
                  <div className="text-xl md:text-2xl font-bold text-white tabular-nums">{stats.overlay.providerCount ?? '—'}</div>
                  <div className="mt-1.5 text-xs text-slate-400">All systems operational</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
