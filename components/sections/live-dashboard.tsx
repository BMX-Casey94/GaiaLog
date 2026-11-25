"use client"

import { useState, useEffect, useCallback } from "react"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Database,
  Droplets,
  Activity,
  Thermometer,
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  AlertOctagon,
  Shield,
  MapPin,
  Clock,
  CheckCircle2,
} from "lucide-react"
import {
  SEVERITY_RANK,
  processDataIntoAlerts,
  readingsToEnvironmentalData,
  type MetricAlert,
  type MetricAlertType,
  type MetricSeverity,
} from "@/lib/metric-alerts"
import { fetchJsonDeduplicated } from "@/lib/client-fetch-cache"

type AlertType = MetricAlertType
type AlertData = MetricAlert

interface EnvironmentalData {
  airQuality: any
  waterLevels: any
  seismic: any
  advancedMetrics: any
  lastUpdated: string
}

interface OverlayAlert {
  family: string
  label: string
  severity: number
  value: string | null
  location: string
  timestamp: string
  txid: string
  confirmed?: boolean
}

function getSeverityVisuals(severity: MetricSeverity | 'good') {
  switch (severity) {
    case 'critical':
      return {
        glow: 'red' as const,
        headerBg: 'bg-red-950/45 border-red-500/25',
        headerIcon: 'text-red-400',
        pill: 'bg-red-500/20 text-red-300 border-red-500/40',
        dot: 'bg-red-400',
        Icon: AlertOctagon,
        label: 'CRITICAL',
      }
    case 'high':
      return {
        glow: 'orange' as const,
        headerBg: 'bg-orange-950/40 border-orange-500/25',
        headerIcon: 'text-orange-400',
        pill: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
        dot: 'bg-orange-400',
        Icon: AlertTriangle,
        label: 'HIGH',
      }
    case 'moderate':
      return {
        glow: 'purple' as const,
        headerBg: 'bg-amber-950/30 border-amber-500/25',
        headerIcon: 'text-amber-400',
        pill: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
        dot: 'bg-amber-400',
        Icon: AlertCircle,
        label: 'MODERATE',
      }
    default:
      return {
        glow: 'purple' as const,
        headerBg: 'bg-purple-950/40 border-purple-500/20',
        headerIcon: 'text-purple-300',
        pill: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
        dot: 'bg-emerald-400',
        Icon: CheckCircle2,
        label: 'GOOD',
      }
  }
}

export function LiveDashboard() {
  const [data, setData] = useState<EnvironmentalData | null>(null)
  const [alerts, setAlerts] = useState<AlertData[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stickyByType, setStickyByType] = useState<Record<AlertType, AlertData | null>>({
    air: null, water: null, seismic: null, environmental: null,
  })
  const [topOverlayAlert, setTopOverlayAlert] = useState<OverlayAlert | null>(null)

  const worstAlert = (type: AlertType): AlertData | null => {
    const current = alerts.filter(a => a.type === type)
    const sticky = stickyByType[type]
    const candidates = sticky ? [...current, sticky] : current
    if (candidates.length === 0) return null
    return candidates.reduce((best, a) => SEVERITY_RANK[a.severity] > SEVERITY_RANK[best.severity] ? a : best, candidates[0])
  }

  const fetchData = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) {
      setRefreshing(true)
    }
    setError(null)
    try {
      const [latestJson, priorityJson] = await Promise.all([
        fetchJsonDeduplicated<any>('/api/explorer/latest-readings', { ttlMs: 15_000, forceRefresh })
          .catch(() => ({ success: false, readings: [] })),
        fetchJsonDeduplicated<any>('/api/explorer/priority-alerts?limit=12', { ttlMs: 15_000, forceRefresh })
          .catch(() => ({ success: false, alerts: [] })),
      ])

      const readings: Array<{ family: string; location: string; timestamp: string; provider: string; metrics: Record<string, any> }> =
        latestJson?.success ? (latestJson.readings ?? []) : []

      const metrics = readingsToEnvironmentalData(readings)
      const processedData: EnvironmentalData = {
        ...metrics,
        lastUpdated: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      }

      setData(processedData)
      const newAlerts = processDataIntoAlerts(metrics)

      if (priorityJson?.success && Array.isArray(priorityJson.alerts) && priorityJson.alerts.length > 0) {
        const sorted = [...priorityJson.alerts].sort((a: OverlayAlert, b: OverlayAlert) => (b.severity ?? 0) - (a.severity ?? 0))
        setTopOverlayAlert(sorted[0])
      } else {
        setTopOverlayAlert(null)
      }

      setAlerts(newAlerts)
      setStickyByType(prev => {
        const next = { ...prev }
        for (const a of newAlerts) {
          if (a.severity === 'high' || a.severity === 'critical') {
            if (!next[a.type] || SEVERITY_RANK[a.severity] > SEVERITY_RANK[next[a.type]!.severity]) {
              next[a.type] = a
            }
          }
        }
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchData(false)
    const interval = setInterval(() => fetchData(true), 45000)
    return () => clearInterval(interval)
  }, [fetchData])

  const cards = [
    {
      type: 'air' as AlertType,
      label: 'Air Quality',
      icon: Database,
      fallbackData: data?.airQuality,
      fallbackLine: data?.airQuality ? `AQI ${data.airQuality.aqi} · PM2.5 ${data.airQuality.pm25} μg/m³` : null,
    },
    {
      type: 'water' as AlertType,
      label: 'Water Levels',
      icon: Droplets,
      fallbackData: data?.waterLevels,
      fallbackLine: data?.waterLevels ? `River level: ${data.waterLevels.river_level}m` : null,
    },
    {
      type: 'seismic' as AlertType,
      label: 'Seismic',
      icon: Activity,
      fallbackData: data?.seismic,
      fallbackLine: data?.seismic ? `Magnitude: ${data.seismic.magnitude}M` : null,
    },
    {
      type: 'environmental' as AlertType,
      label: 'Environmental',
      icon: Thermometer,
      fallbackData: data?.advancedMetrics,
      fallbackLine: data?.advancedMetrics
        ? `Score: ${typeof data.advancedMetrics.scoreDisplay === 'number' ? data.advancedMetrics.scoreDisplay.toFixed(1) : data.advancedMetrics.environmental_quality_score}/100`
        : null,
    },
  ]

  return (
    <section id="monitoring" className="py-20 px-4 sm:px-6 lg:px-8 relative scroll-mt-24 live-dashboard-section">
      <div className="relative">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="font-display text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">
              Live Environmental Alerts
            </h2>
            <p className="text-base text-slate-400 max-w-2xl mx-auto">
              Real-time environmental data collection from global sensor networks. Every measurement is timestamped, geolocated, and immutably recorded on the BSV blockchain.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
            {cards.map(({ type, label, icon: Icon, fallbackData, fallbackLine }) => {
              const alert = worstAlert(type)
              const visuals = getSeverityVisuals(alert ? alert.severity : 'good')
              const StatusIcon = visuals.Icon

              return (
                <GlowCard key={type} glowColor={visuals.glow} customSize className="h-full min-h-[240px]">
                  <div className={`shrink-0 flex items-center justify-between gap-2 -mx-4 -mt-4 px-4 py-3 border-b rounded-t-2xl ${visuals.headerBg}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <Icon className={`h-4 w-4 shrink-0 ${visuals.headerIcon}`} />
                      <span className="font-semibold text-sm text-white truncate">{label}</span>
                    </div>
                    {!loading && (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border shrink-0 ${visuals.pill}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${alert ? 'animate-pulse' : ''} ${visuals.dot}`} />
                        {visuals.label}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 flex flex-col justify-center py-3.5 min-h-0">
                    {loading && !data ? (
                      <div className="space-y-2.5 animate-pulse">
                        <div className="h-4 w-3/4 mx-auto rounded bg-purple-900/35" />
                        <div className="h-3 w-5/6 mx-auto rounded bg-slate-800/70" />
                        <div className="h-3 w-1/2 mx-auto rounded bg-slate-800/50" />
                      </div>
                    ) : alert ? (
                      <div className="space-y-2.5 text-center">
                        <div className="inline-flex items-center justify-center gap-1.5 text-sm font-medium text-slate-200 leading-snug">
                          <StatusIcon className={`h-4 w-4 shrink-0 ${visuals.headerIcon}`} />
                          <span>{alert.details}</span>
                        </div>
                        <div className="space-y-1 pt-1">
                          <div
                            className="flex items-center justify-center gap-1.5 text-xs text-slate-400"
                            title={alert.location}
                          >
                            <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                            <span className="truncate max-w-[180px]">{alert.location}</span>
                          </div>
                          <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500 tabular-nums">
                            <Clock className="h-3 w-3 shrink-0" />
                            <span>{new Date(alert.timestamp).toLocaleString('en-GB')}</span>
                          </div>
                        </div>
                      </div>
                    ) : fallbackData ? (
                      <div className="space-y-2.5 text-center">
                        <div className="text-sm font-medium text-slate-200 leading-snug">
                          {fallbackLine}
                        </div>
                        <div className="space-y-1 pt-1">
                          <div
                            className="flex items-center justify-center gap-1.5 text-xs text-slate-400"
                            title={fallbackData.location}
                          >
                            <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                            <span className="truncate max-w-[180px]">{fallbackData.location}</span>
                          </div>
                          <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500 tabular-nums">
                            <Clock className="h-3 w-3 shrink-0" />
                            <span>{new Date(fallbackData.timestamp).toLocaleString('en-GB')}</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center space-y-1">
                        <div className="text-sm font-semibold text-emerald-300">No active alerts</div>
                        <div className="text-xs text-slate-500">Awaiting sensor reading</div>
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2.5 border-t border-white/5 bg-black/20 rounded-b-2xl">
                    <Badge variant="secondary" className="bg-purple-950/60 text-purple-200/80 border border-purple-500/20 text-[11px] font-normal tabular-nums">
                      {data?.lastUpdated ? `Updated ${data.lastUpdated}` : 'Connecting…'}
                    </Badge>
                  </div>
                </GlowCard>
              )
            })}

            {/* Verified on-chain (display only — not used for Hero Top Alert) */}
            <GlowCard glowColor="purple" customSize className="h-full min-h-[240px]">
              <div className="shrink-0 flex items-center justify-between gap-2 -mx-4 -mt-4 px-4 py-3 bg-emerald-950/40 border-b border-emerald-500/25 rounded-t-2xl">
                <div className="flex items-center gap-2 min-w-0">
                  <Shield className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span className="font-semibold text-sm text-white truncate">On-chain</span>
                </div>
                {!loading && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border bg-emerald-500/15 text-emerald-300 border-emerald-500/30 shrink-0">
                    <CheckCircle2 className="h-3 w-3" />
                    BSV
                  </span>
                )}
              </div>

              <div className="flex-1 flex flex-col justify-center py-3.5 min-h-0">
                {loading && !data ? (
                  <div className="space-y-2.5 animate-pulse">
                    <div className="h-4 w-3/4 mx-auto rounded bg-emerald-900/35" />
                    <div className="h-3 w-5/6 mx-auto rounded bg-slate-800/70" />
                    <div className="h-3 w-1/2 mx-auto rounded bg-slate-800/50" />
                  </div>
                ) : topOverlayAlert ? (
                  <div className="space-y-2.5 text-center">
                    <div className="inline-flex items-center justify-center gap-1.5 text-sm font-semibold text-white">
                      {topOverlayAlert.severity >= 80 && <AlertOctagon className="h-4 w-4 shrink-0 text-red-400" />}
                      {topOverlayAlert.severity >= 60 && topOverlayAlert.severity < 80 && <AlertTriangle className="h-4 w-4 shrink-0 text-orange-400" />}
                      {topOverlayAlert.severity < 60 && <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />}
                      <span className="truncate max-w-[160px]">{topOverlayAlert.label}</span>
                    </div>
                    <div className="text-xs text-slate-300 font-medium">{topOverlayAlert.value ?? 'Priority event'}</div>
                    <div className="space-y-1">
                      <div
                        className="flex items-center justify-center gap-1.5 text-xs text-slate-400"
                        title={topOverlayAlert.location}
                      >
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                        <span className="truncate max-w-[180px]">{topOverlayAlert.location}</span>
                      </div>
                      <div className="flex items-center justify-center gap-1.5 text-[11px] text-emerald-400/80 tabular-nums">
                        <CheckCircle2 className="h-3 w-3 shrink-0" />
                        <span>{new Date(topOverlayAlert.timestamp).toLocaleString('en-GB')}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center space-y-1">
                    <div className="text-sm font-semibold text-emerald-300">All clear</div>
                    <div className="text-xs text-slate-500">No priority alerts</div>
                  </div>
                )}
              </div>

              <div className="shrink-0 flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2.5 border-t border-white/5 bg-black/20 rounded-b-2xl">
                <Badge variant="secondary" className="bg-emerald-950/60 text-emerald-300 border border-emerald-500/20 text-[11px] font-normal">
                  {topOverlayAlert ? 'Blockchain verified' : 'No alerts'}
                </Badge>
              </div>
            </GlowCard>
          </div>

          <div className="text-center mt-6">
            <Button
              onClick={() => fetchData(true)}
              disabled={refreshing}
              variant="outline"
              className="border-purple-500/30 text-slate-200 hover:bg-purple-950/50 hover:border-purple-400/50 bg-purple-950/20"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Refreshing Data…' : 'Refresh Data'}
            </Button>
            {error && (
              <div className="mt-4 text-red-400 text-sm">
                Error: {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
