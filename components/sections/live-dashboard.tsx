"use client"

import { useState, useEffect, useCallback } from "react"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Database, Droplets, Activity, Thermometer, RefreshCw, AlertTriangle, AlertCircle, AlertOctagon, Shield } from "lucide-react"
import {
  SEVERITY_RANK,
  processDataIntoAlerts,
  readingsToEnvironmentalData,
  type MetricAlert,
  type MetricAlertType,
} from "@/lib/metric-alerts"

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

export function LiveDashboard() {
  const [data, setData] = useState<EnvironmentalData | null>(null)
  const [alerts, setAlerts] = useState<AlertData[]>([])
  const [loading, setLoading] = useState(false)
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

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [latestRes, priorityAlertsRes] = await Promise.all([
        fetch('/api/explorer/latest-readings', { cache: 'no-store' }),
        fetch('/api/explorer/priority-alerts?limit=12', { cache: 'no-store' }),
      ])

      const latestJson = latestRes.ok ? await latestRes.json() : { success: false, readings: [] }
      const readings: Array<{ family: string; location: string; timestamp: string; provider: string; metrics: Record<string, any> }> =
        latestJson?.success ? (latestJson.readings ?? []) : []

      const metrics = readingsToEnvironmentalData(readings)
      const processedData: EnvironmentalData = {
        ...metrics,
        lastUpdated: new Date().toLocaleTimeString('en-GB'),
      }

      setData(processedData)
      const newAlerts = processDataIntoAlerts(metrics)

      if (priorityAlertsRes.ok) {
        const priorityJson = await priorityAlertsRes.json()
        if (priorityJson?.success && Array.isArray(priorityJson.alerts) && priorityJson.alerts.length > 0) {
          const sorted = [...priorityJson.alerts].sort((a: OverlayAlert, b: OverlayAlert) => (b.severity ?? 0) - (a.severity ?? 0))
          setTopOverlayAlert(sorted[0])
        } else {
          setTopOverlayAlert(null)
        }
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
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 45000)
    return () => clearInterval(interval)
  }, [fetchData])

  return (
    <section id="monitoring" className="py-20 px-4 sm:px-6 lg:px-8 relative scroll-mt-24 live-dashboard-section">
      <div className="absolute inset-0 bg-gradient-to-b from-slate-950/50 via-slate-900/30 to-black/80 pointer-events-none"></div>
      <div className="relative">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="font-display text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">Live Environmental Alerts</h2>
            <p className="text-base text-slate-400 max-w-2xl mx-auto">
              Real-time environmental data collection from global sensor networks. Every measurement is timestamped, geolocated, and immutably recorded on the BSV blockchain.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
            {([
              { type: 'air' as AlertType, label: 'Air Quality', icon: Database, fallbackData: data?.airQuality, fallbackLine: data?.airQuality ? `AQI: ${data.airQuality.aqi} • PM2.5: ${data.airQuality.pm25} μg/m³` : null },
              { type: 'water' as AlertType, label: 'Water Levels', icon: Droplets, fallbackData: data?.waterLevels, fallbackLine: data?.waterLevels ? `Level: ${data.waterLevels.river_level}m` : null },
              { type: 'seismic' as AlertType, label: 'Seismic', icon: Activity, fallbackData: data?.seismic, fallbackLine: data?.seismic ? `Magnitude: ${data.seismic.magnitude}M` : null },
              { type: 'environmental' as AlertType, label: 'Environmental', icon: Thermometer, fallbackData: data?.advancedMetrics, fallbackLine: data?.advancedMetrics ? `Score: ${typeof data.advancedMetrics.scoreDisplay === 'number' ? data.advancedMetrics.scoreDisplay.toFixed(1) : data.advancedMetrics.environmental_quality_score}/100` : null },
            ]).map(({ type, label, icon: Icon, fallbackData, fallbackLine }) => {
              const alert = worstAlert(type)
              return (
                <GlowCard key={type} glowColor="blue" customSize className="h-full min-h-[220px]">
                  <div className="shrink-0 flex items-center justify-center gap-2 -mx-4 -mt-4 px-4 py-2.5 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
                    <Icon className="h-4 w-4 text-blue-400" />
                    <span className="font-semibold text-sm text-blue-400">{label}</span>
                  </div>
                  <div className="flex-1 flex flex-col justify-center py-3 min-h-0">
                    {alert ? (
                      <div className="text-center">
                        <div className="flex items-center justify-center space-x-2 mb-2">
                          {alert.severity === 'critical' && <AlertOctagon className="h-4 w-4 text-red-500" />}
                          {alert.severity === 'high' && <AlertTriangle className="h-4 w-4 text-orange-500" />}
                          {alert.severity === 'moderate' && <AlertCircle className="h-4 w-4 text-yellow-500" />}
                          <span className={`text-lg font-bold ${
                            alert.severity === 'critical' ? 'text-red-400' :
                            alert.severity === 'high' ? 'text-orange-400' :
                            alert.severity === 'moderate' ? 'text-yellow-400' : 'text-green-400'
                          }`}>
                            {alert.severity.toUpperCase()}
                          </span>
                        </div>
                        <div className="text-sm text-slate-400 mb-2">{alert.details}</div>
                        <div className="text-xs text-slate-500 mb-1">📍 {alert.location}</div>
                        <div className="text-xs text-slate-600">🕒 {new Date(alert.timestamp).toLocaleString('en-GB')}</div>
                      </div>
                    ) : fallbackData ? (
                      <div className="text-green-400 text-center">
                        <div className="text-lg font-bold mb-1">Good</div>
                        <div className="text-sm text-slate-400 mb-2">{fallbackLine}</div>
                        <div className="text-xs text-slate-500 mb-1">📍 {fallbackData.location}</div>
                        <div className="text-xs text-slate-600">🕒 {new Date(fallbackData.timestamp).toLocaleString('en-GB')}</div>
                      </div>
                    ) : (
                      <div className="text-green-400 text-center">
                        <div className="text-lg font-bold mb-1">No alerts</div>
                        <div className="text-sm text-slate-400">No data available</div>
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2 border-t border-slate-700/30">
                    <Badge variant="secondary" className="bg-blue-900/50 text-blue-400">
                      {data?.lastUpdated ? `Updated: ${data.lastUpdated}` : 'No data'}
                    </Badge>
                  </div>
                </GlowCard>
              )
            })}

            {/* Verified on-chain (display only — not used for Hero Top Alert) */}
            <GlowCard glowColor="green" customSize className="h-full min-h-[220px]">
              <div className="shrink-0 flex items-center justify-center gap-2 -mx-4 -mt-4 px-4 py-2.5 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
                <Shield className="h-4 w-4 text-green-400" />
                <span className="font-semibold text-sm text-green-400">On-chain</span>
              </div>
              <div className="flex-1 flex flex-col justify-center py-3 min-h-0">
                {topOverlayAlert ? (
                  <div className="text-center">
                    <div className="flex items-center justify-center space-x-2 mb-2">
                      {topOverlayAlert.severity >= 80 && <AlertOctagon className="h-4 w-4 text-red-500" />}
                      {topOverlayAlert.severity >= 60 && topOverlayAlert.severity < 80 && <AlertTriangle className="h-4 w-4 text-orange-500" />}
                      {topOverlayAlert.severity < 60 && <AlertCircle className="h-4 w-4 text-yellow-500" />}
                      <span className="text-sm font-bold text-white">{topOverlayAlert.label}</span>
                    </div>
                    <div className="text-xs text-slate-400">{topOverlayAlert.value ?? 'Alert'}</div>
                    <div className="text-xs text-slate-500 mb-1">📍 {topOverlayAlert.location}</div>
                    <div className="text-xs text-green-500/80">✓ Verified • {new Date(topOverlayAlert.timestamp).toLocaleString('en-GB')}</div>
                  </div>
                ) : (
                  <div className="text-green-400 text-center">
                    <div className="text-lg font-bold mb-1">All clear</div>
                    <div className="text-sm text-slate-400">No priority alerts</div>
                  </div>
                )}
              </div>
              <div className="shrink-0 flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2 border-t border-slate-700/30">
                <Badge variant="secondary" className="bg-green-900/30 text-green-400">
                  {topOverlayAlert ? 'Blockchain verified' : 'No alerts'}
                </Badge>
              </div>
            </GlowCard>
          </div>

          <div className="text-center mt-6">
            <Button
              onClick={fetchData}
              disabled={loading}
              variant="outline"
              className="border-slate-600 text-slate-300 hover:bg-slate-800 bg-transparent"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Fetching Data...' : 'Refresh Data'}
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
