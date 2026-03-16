"use client"

import { useState, useEffect } from "react"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Database, Droplets, Activity, Thermometer, RefreshCw, AlertTriangle, AlertCircle, AlertOctagon, Shield } from "lucide-react"

type AlertType = 'air' | 'water' | 'seismic' | 'environmental'

interface EnvironmentalData {
  airQuality: any
  waterLevels: any
  seismic: any
  advancedMetrics: any
  lastUpdated: string
}

interface AlertData {
  type: AlertType
  severity: 'low' | 'moderate' | 'high' | 'critical'
  value: number
  location: string
  timestamp: string
  source: string
  details: string
}

const SEVERITY_RANK = { low: 0, moderate: 1, high: 2, critical: 3 } as const

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

  const processDataIntoAlerts = (data: any): AlertData[] => {
    const alerts: AlertData[] = []
    const toFixed = (n: any, digits = 1): string => {
      const num = Number(n)
      if (!isFinite(num)) return ''
      return num.toFixed(digits)
    }
    
    // Process Air Quality - Only show moderate or worse
    if (data.airQuality) {
      const aqi = data.airQuality.aqi
      const pm25 = Number(data.airQuality.pm25)
      let severity: 'low' | 'moderate' | 'high' | 'critical' = 'low'
      
      // Support both AQI scales:
      // - 0–500 (US EPA/WAQI)
      // - 1–5 (OpenWeather style: 1=Good, 5=Very Poor)
      if (Number.isFinite(aqi)) {
        if (aqi >= 0 && aqi <= 5) {
          // 1–5 scale
          if (aqi >= 5) severity = 'critical'
          else if (aqi >= 4) severity = 'high'
          else if (aqi >= 3) severity = 'moderate'
        } else {
          // 0–500 scale
          if (aqi > 150) severity = 'critical'
          else if (aqi > 100) severity = 'high'
          else if (aqi > 50) severity = 'moderate'
        }
      }
      
      // Escalate based on PM2.5 if it's worse than AQI classification.
      // Thresholds approximate EPA 24h guidance (µg/m³).
      if (Number.isFinite(pm25)) {
        const pmSeverity: 'low' | 'moderate' | 'high' | 'critical' =
          pm25 > 55.4 ? 'critical'
          : pm25 > 35.4 ? 'high'
          : pm25 > 12 ? 'moderate'
          : 'low'
        const rank = { low: 0, moderate: 1, high: 2, critical: 3 } as const
        if (rank[pmSeverity] > rank[severity]) {
          severity = pmSeverity
        }
      }
      
      // Only add to alerts if it's moderate or worse
      if (severity !== 'low') {
        alerts.push({
          type: 'air',
          severity,
          value: aqi,
          location: data.airQuality.location,
          timestamp: data.airQuality.timestamp,
          source: data.airQuality.source,
          details: `AQI: ${aqi} • PM2.5: ${toFixed(data.airQuality.pm25, 1)} μg/m³`
        })
      }
    }
    
    // Process Water Levels - Only show moderate or worse
    if (data.waterLevels) {
      const level = data.waterLevels.river_level
      // Assume levels above 4m are concerning (this would be based on historical data)
      let severity: 'low' | 'moderate' | 'high' | 'critical' = 'low'
      if (level > 8) severity = 'critical'
      else if (level > 6) severity = 'high'
      else if (level > 4) severity = 'moderate'
      
      // Only add to alerts if it's moderate or worse
      if (severity !== 'low') {
        alerts.push({
          type: 'water',
          severity,
          value: level,
          location: data.waterLevels.location,
          timestamp: data.waterLevels.timestamp,
          source: data.waterLevels.source,
          details: `Level: ${toFixed(level, 2)}m`
        })
      }
    }
    
    // Process Seismic Activity - Only show moderate or worse
    if (data.seismic) {
      const magnitude = data.seismic.magnitude
      let severity: 'low' | 'moderate' | 'high' | 'critical' = 'low'
      if (magnitude >= 6) severity = 'critical'
      else if (magnitude >= 4.5) severity = 'high'
      else if (magnitude >= 3) severity = 'moderate'
      
      // Only add to alerts if it's moderate or worse
      if (severity !== 'low') {
        alerts.push({
          type: 'seismic',
          severity,
          value: magnitude,
          location: data.seismic.location,
          timestamp: data.seismic.timestamp,
          source: data.seismic.source,
          details: `Magnitude: ${toFixed(magnitude, 1)}M • Depth: ${
            data.seismic.depth ? `${toFixed(data.seismic.depth, 1)} (km)` : 'Unknown (km)'
          }`
        })
      }
    }
    
    // Process Environmental Quality - Only show moderate or worse
    if (data.advancedMetrics) {
      const rawScore = data.advancedMetrics.environmental_quality_score
      // Normalize score: if 0–1, scale to 0–100
      const normalizedScore = typeof rawScore === 'number' && rawScore <= 1 ? rawScore * 100 : rawScore
      const score = normalizedScore
      let severity: 'low' | 'moderate' | 'high' | 'critical' = 'low'
      if (score < 30) severity = 'critical'
      else if (score < 50) severity = 'high'
      else if (score < 70) severity = 'moderate'
      
      // Only add to alerts if it's moderate or worse
      if (severity !== 'low') {
        alerts.push({
          type: 'environmental',
          severity,
          value: score,
          location: data.advancedMetrics.location,
          timestamp: data.advancedMetrics.timestamp,
          source: data.advancedMetrics.source,
          details: `Score: ${toFixed(score, 1)}/100 • UV: ${toFixed(data.advancedMetrics.uv_index, 1)}`
        })
      }
    }
    
    return alerts
  }

  const worstAlert = (type: AlertType): AlertData | null => {
    const current = alerts.filter(a => a.type === type)
    const sticky = stickyByType[type]
    const candidates = sticky ? [...current, sticky] : current
    if (candidates.length === 0) return null
    return candidates.reduce((best, a) => SEVERITY_RANK[a.severity] > SEVERITY_RANK[best.severity] ? a : best, candidates[0])
  }

  const fetchData = async () => {
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

      const byFamily = (f: string) => readings.find(r => r.family === f) ?? null

      const airRow = byFamily('air_quality')
      const waterRow = byFamily('water_levels')
      const seismicRow = byFamily('seismic_activity')
      const advRow = byFamily('advanced_metrics')

      const processedData: EnvironmentalData = {
        airQuality: airRow ? {
          aqi: airRow.metrics.aqi ?? airRow.metrics.air_quality_index ?? null,
          pm25: airRow.metrics.pm25 ?? airRow.metrics.fine_particulate_matter_pm25 ?? null,
          location: airRow.location,
          timestamp: airRow.timestamp,
          source: airRow.provider ?? 'overlay',
        } : null,
        waterLevels: waterRow ? {
          river_level: waterRow.metrics.river_level ?? waterRow.metrics.sea_level ?? waterRow.metrics.level ?? 0,
          location: waterRow.location,
          timestamp: waterRow.timestamp,
          source: waterRow.provider ?? 'overlay',
        } : null,
        seismic: seismicRow ? {
          magnitude: seismicRow.metrics.magnitude ?? null,
          depth: seismicRow.metrics.depth ?? seismicRow.metrics.depth_km ?? null,
          location: seismicRow.location,
          timestamp: seismicRow.timestamp,
          source: seismicRow.provider ?? 'overlay',
        } : null,
        advancedMetrics: advRow ? (() => {
          const rawScore = advRow.metrics.environmental_quality_score ?? advRow.metrics.environmental_score
          const normalized = typeof rawScore === 'number' && rawScore <= 1 ? rawScore * 100 : rawScore
          return {
            environmental_quality_score: normalized ?? null,
            scoreDisplay: typeof normalized === 'number' ? normalized : null,
            uv_index: advRow.metrics.uv_index ?? null,
            uvDisplay: typeof advRow.metrics.uv_index === 'number' ? advRow.metrics.uv_index : null,
            location: advRow.location,
            timestamp: advRow.timestamp,
            source: advRow.provider ?? 'overlay',
          }
        })() : null,
        lastUpdated: new Date().toLocaleTimeString('en-GB'),
      }

      setData(processedData)
      const newAlerts = processDataIntoAlerts(processedData)

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
  }

  useEffect(() => {
    fetchData()
    // Refresh every 45 seconds to align with API cache TTL
    const interval = setInterval(fetchData, 45000)
    return () => clearInterval(interval)
  }, [])
  return (
    <section id="monitoring" className="py-20 px-4 sm:px-6 lg:px-8 relative scroll-mt-24 live-dashboard-section">
      <div className="absolute inset-0 bg-gradient-to-b from-slate-950/50 via-slate-900/30 to-black/80 pointer-events-none"></div>
      <div className="relative">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Live Environmental Alerts</h2>
            <p className="text-base text-slate-400 max-w-2xl mx-auto">
              Real-time environmental data collection from global sensor networks. Every measurement is timestamped, geolocated, and immutably recorded on the BSV blockchain.
            </p>
          </div>

          

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
            {([
              { type: 'air' as AlertType, label: 'Air Quality', icon: Database, color: 'blue', fallbackData: data?.airQuality, fallbackLine: data?.airQuality ? `AQI: ${data.airQuality.aqi} • PM2.5: ${data.airQuality.pm25} μg/m³` : null },
              { type: 'water' as AlertType, label: 'Water Levels', icon: Droplets, color: 'blue', fallbackData: data?.waterLevels, fallbackLine: data?.waterLevels ? `Level: ${data.waterLevels.river_level}m` : null },
              { type: 'seismic' as AlertType, label: 'Seismic', icon: Activity, color: 'blue', fallbackData: data?.seismic, fallbackLine: data?.seismic ? `Magnitude: ${data.seismic.magnitude}M` : null },
              { type: 'environmental' as AlertType, label: 'Environmental', icon: Thermometer, color: 'blue', fallbackData: data?.advancedMetrics, fallbackLine: data?.advancedMetrics ? `Score: ${typeof data.advancedMetrics.scoreDisplay === 'number' ? data.advancedMetrics.scoreDisplay.toFixed(1) : data.advancedMetrics.environmental_quality_score}/100` : null },
            ]).map(({ type, label, icon: Icon, fallbackData, fallbackLine }) => {
              const alert = worstAlert(type)
              return (
                <GlowCard key={type} glowColor="blue" customSize className="flex flex-col">
                  <div className="flex items-center justify-center space-x-2 -mx-4 -mt-4 px-4 py-3 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
                    <Icon className="h-4 w-4 text-blue-400" />
                    <span className="font-semibold text-sm text-blue-400">{label}</span>
                  </div>
                  <div className="flex-1 flex flex-col justify-center py-3">
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
                  <div className="flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2 border-t border-slate-700/30">
                    <Badge variant="secondary" className="bg-blue-900/50 text-blue-400">
                      {data?.lastUpdated ? `Updated: ${data.lastUpdated}` : 'No data'}
                    </Badge>
                  </div>
                </GlowCard>
              )
            })}

            {/* Verified on-chain */}
            <GlowCard glowColor="green" customSize className="flex flex-col">
              <div className="flex items-center justify-center space-x-2 -mx-4 -mt-4 px-4 py-3 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
                <Shield className="h-4 w-4 text-green-400" />
                <span className="font-semibold text-sm text-green-400">On-chain</span>
              </div>
              <div className="flex-1 flex flex-col justify-center py-3">
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
              <div className="flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2 border-t border-slate-700/30">
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
