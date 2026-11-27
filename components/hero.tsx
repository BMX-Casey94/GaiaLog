"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { Button } from "@/components/ui/button"
import { ArrowRight, AlertTriangle, AlertOctagon, AlertCircle, Shield, Globe, MapPin, CheckCircle2, ChevronRight, Radio } from "lucide-react"
import {
  metricAlertToHeroDisplay,
  pickTopMetricAlert,
  processDataIntoAlerts,
  readingsToEnvironmentalData,
  type MetricSeverity,
} from "@/lib/metric-alerts"
import { fetchJsonDeduplicated } from "@/lib/client-fetch-cache"
import { holdHomepageStage } from "@/lib/homepage-load-queue"

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
        card: 'border-red-500/35 bg-gradient-to-b from-red-950/35 via-[#14070d]/80 to-[#0a040a]/90 hover:border-red-400/60 hover:shadow-[0_12px_32px_-12px_rgba(239,68,68,0.45)]',
        accentLine: 'via-red-400/60',
        badge: 'bg-red-500/15 text-red-200 border-red-400/35',
        dot: 'bg-red-400',
        value: 'text-red-200',
        icon: 'text-red-300',
        Icon: AlertOctagon,
      }
    case 'high':
      return {
        card: 'border-orange-500/35 bg-gradient-to-b from-orange-950/30 via-[#140a07]/80 to-[#0a050a]/90 hover:border-orange-400/60 hover:shadow-[0_12px_32px_-12px_rgba(249,115,22,0.4)]',
        accentLine: 'via-orange-400/60',
        badge: 'bg-orange-500/15 text-orange-200 border-orange-400/35',
        dot: 'bg-orange-400',
        value: 'text-orange-200',
        icon: 'text-orange-300',
        Icon: AlertTriangle,
      }
    case 'moderate':
      return {
        card: 'border-amber-500/35 bg-gradient-to-b from-amber-950/30 via-[#140e07]/80 to-[#0a060a]/90 hover:border-amber-400/60 hover:shadow-[0_12px_32px_-12px_rgba(245,158,11,0.35)]',
        accentLine: 'via-amber-400/60',
        badge: 'bg-amber-500/15 text-amber-200 border-amber-400/35',
        dot: 'bg-amber-400',
        value: 'text-amber-200',
        icon: 'text-amber-300',
        Icon: AlertCircle,
      }
    default:
      return {
        card: 'border-emerald-500/30 bg-gradient-to-b from-emerald-950/25 via-[#07120e]/80 to-[#07050c]/90 hover:border-emerald-400/55 hover:shadow-[0_12px_32px_-12px_rgba(16,185,129,0.35)]',
        accentLine: 'via-emerald-400/55',
        badge: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/30',
        dot: 'bg-emerald-400',
        value: 'text-emerald-200',
        icon: 'text-emerald-300',
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
    const needsProviderCount = initialProviderCount == null

    const fetchStats = async (forceRefresh = false) => {
      try {
        const [explorerRes, readingsRes, providersRes] = await Promise.allSettled([
          fetchJsonDeduplicated<any>('/api/explorer/stats', { ttlMs: 15_000, forceRefresh }),
          // Genuine sensor metrics only — never on-chain event/priority alerts.
          fetchJsonDeduplicated<any>('/api/explorer/latest-readings', { ttlMs: 15_000, forceRefresh }),
          // Skip when the server already supplied initialProviderCount.
          needsProviderCount
            ? fetchJsonDeduplicated<any>('/api/providers/status', { ttlMs: 5 * 60_000, forceRefresh: false })
            : Promise.resolve(null),
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

        if (providersRes.status === 'fulfilled') {
          const list = providersRes.value?.controls?.providers
          if (Array.isArray(list)) {
            const count = list.filter((p: { enabled?: boolean; rolloutEnabled?: boolean }) => p.enabled && p.rolloutEnabled).length
            setStats((prev) => ({
              ...prev,
              overlay: { ...prev.overlay, providerCount: count },
            }))
          }
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          console.error('Error fetching hero data:', error)
        }
      }
    }

    const release = holdHomepageStage(0)
    let released = false
    const releaseOnce = () => {
      if (released) return
      released = true
      release()
    }
    void fetchStats(false).finally(releaseOnce)
    const interval = setInterval(() => fetchStats(true), 45000)
    return () => {
      releaseOnce()
      clearInterval(interval)
    }
  }, [initialProviderCount])

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
          background: `radial-gradient(ellipse at center, rgba(88, 28, 135, 0.42) 0%, rgba(59, 7, 100, 0.3) 35%, rgba(4, 2, 8, 0.96) 72%)`,
          maskImage: "linear-gradient(to bottom, black 76%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, black 76%, transparent 100%)",
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
        <div className="opacity-35">
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
          <div className="relative glass-card glass-card-hover p-5 sm:p-6 overflow-hidden border border-purple-500/20 bg-[#090512]/70 shadow-[0_24px_64px_-20px_rgba(88,28,135,0.45)]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-purple-400/50 to-transparent"
            />
            <div className="flex items-center justify-between gap-3 pb-4 mb-5 border-b border-white/[0.06]">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 bg-red-500/90 rounded-full ring-1 ring-red-400/30" />
                <div className="w-2.5 h-2.5 bg-amber-400/90 rounded-full ring-1 ring-amber-300/30" />
                <div className="w-2.5 h-2.5 bg-emerald-400/90 rounded-full ring-1 ring-emerald-300/30" />
                <span className="text-slate-300 text-xs sm:text-sm font-medium tracking-wide ml-2">GaiaLog Dashboard</span>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-purple-400/20 bg-purple-500/10 px-2.5 py-0.5 text-[11px] font-medium text-purple-200/90">
                <Radio className="h-3 w-3 text-emerald-400 animate-pulse" />
                Live Mainnet
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(() => {
                const alertStyle = heroAlertStyle(stats.topAlert?.severity ?? 'low')
                const AlertIcon = alertStyle.Icon
                return (
                  <button
                    className={`group relative overflow-hidden rounded-2xl p-5 border ring-1 ring-inset ring-white/[0.05] transition-all duration-200 hover:-translate-y-0.5 text-left flex flex-col justify-between min-h-[144px] ${alertStyle.card}`}
                    onClick={scrollToMonitoring}
                  >
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent ${alertStyle.accentLine} to-transparent`}
                    />
                    <div className="flex items-center justify-between gap-2 mb-4">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <AlertIcon className={`h-4 w-4 shrink-0 ${alertStyle.icon}`} />
                        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300/90 truncate">Top Alert</span>
                      </div>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border shrink-0 ${alertStyle.badge}`}>
                        <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${alertStyle.dot}`} />
                        {stats.topAlert ? stats.topAlert.severity : 'Clear'}
                      </span>
                    </div>
                    {stats.topAlert ? (
                      <div>
                        <div className={`text-lg md:text-[19px] font-bold leading-snug tracking-tight ${alertStyle.value}`}>
                          {stats.topAlert.label}
                          <span className="text-white font-semibold"> · {stats.topAlert.value || 'Active'}</span>
                        </div>
                        <div className="mt-2.5 pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-2 text-xs text-slate-400">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                            <span className="truncate">{formatLocation(stats.topAlert.location)}</span>
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-slate-200" />
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="text-xl md:text-2xl font-bold tracking-tight text-emerald-200">All Clear</div>
                        <div className="mt-2.5 pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-2 text-xs text-slate-400">
                          <span>No critical alerts detected</span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-slate-200" />
                        </div>
                      </div>
                    )}
                  </button>
                )
              })()}

              <button
                id="blockchain-status"
                className="group relative overflow-hidden rounded-2xl p-5 border border-purple-500/25 bg-gradient-to-b from-purple-950/35 via-[#10081c]/80 to-[#090512]/90 ring-1 ring-inset ring-white/[0.05] transition-all duration-200 hover:-translate-y-0.5 hover:border-purple-400/55 hover:shadow-[0_12px_32px_-12px_rgba(168,85,247,0.4)] text-left flex flex-col justify-between min-h-[144px]"
                onClick={() => document.getElementById('blockchain')?.scrollIntoView({ behavior: 'smooth' })}
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-purple-400/55 to-transparent"
                />
                <div className="flex items-center justify-between gap-2 mb-4">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Shield className="h-4 w-4 shrink-0 text-purple-300" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300/90 truncate">Total Data Records</span>
                  </div>
                  <span className="text-[10px] font-medium uppercase tracking-wider text-purple-300/80 bg-purple-500/10 border border-purple-400/20 rounded-full px-2 py-0.5 shrink-0">
                    On-chain
                  </span>
                </div>
                <div>
                  <div className="text-2xl md:text-[28px] font-bold tracking-tight text-white tabular-nums leading-none">
                    {formatTotalReadings(stats.overlay.totalReadings) || '—'}
                  </div>
                  <div className="mt-2.5 pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-2 text-xs text-slate-400">
                    <span className="truncate">
                      {stats.lastRecordAt ? `Last record: ${formatRelativeTime(stats.lastRecordAt, now)}` : 'Awaiting data…'}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-purple-200" />
                  </div>
                </div>
              </button>

              <button
                id="data-sources-card"
                className="group relative overflow-hidden rounded-2xl p-5 border border-indigo-500/25 bg-gradient-to-b from-indigo-950/35 via-[#0c0a1d]/80 to-[#080613]/90 ring-1 ring-inset ring-white/[0.05] transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-400/55 hover:shadow-[0_12px_32px_-12px_rgba(99,102,241,0.4)] text-left flex flex-col justify-between min-h-[144px]"
                onClick={() => document.getElementById('data-sources')?.scrollIntoView({ behavior: 'smooth' })}
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-indigo-400/55 to-transparent"
                />
                <div className="flex items-center justify-between gap-2 mb-4">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Globe className="h-4 w-4 shrink-0 text-indigo-300" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300/90 truncate">Data Sources</span>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300/90 bg-emerald-500/10 border border-emerald-400/20 rounded-full px-2 py-0.5 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    Active
                  </span>
                </div>
                <div>
                  <div className="text-2xl md:text-[28px] font-bold tracking-tight text-white tabular-nums leading-none">
                    {stats.overlay.providerCount ?? '—'}
                  </div>
                  <div className="mt-2.5 pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-2 text-xs text-slate-400">
                    <span className="truncate">All systems operational</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-indigo-200" />
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
