"use client"

import { useState, useEffect } from "react"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Database, Droplets, Activity, Thermometer, RefreshCw, AlertTriangle, AlertCircle, AlertOctagon } from "lucide-react"

interface EnvironmentalData {
  airQuality: any
  waterLevels: any
  seismic: any
  advancedMetrics: any
  lastUpdated: string
}

interface AlertData {
  type: 'air' | 'water' | 'seismic' | 'environmental'
  severity: 'low' | 'moderate' | 'high' | 'critical'
  value: number
  location: string
  timestamp: string
  source: string
  details: string
}

export function LiveDashboard() {
  const [data, setData] = useState<EnvironmentalData | null>(null)
  const [alerts, setAlerts] = useState<AlertData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Remember the last severe alert (high/critical) so the card doesn't go empty
  const [stickyByType, setStickyByType] = useState<Record<AlertData['type'], AlertData | null>>({
    air: null,
    water: null,
    seismic: null,
    environmental: null,
  })

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

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      // Fetch from WoC (no database, rotates across 3 wallets)
      const [airQualityRes, waterLevelsRes, seismicRes, advancedRes] = await Promise.all([
        fetch('/api/air-quality/latest', { cache: 'no-store' }),
        fetch('/api/water-levels/latest', { cache: 'no-store' }),
        fetch('/api/seismic/latest', { cache: 'no-store' }),
        fetch('/api/advanced-metrics/latest', { cache: 'no-store' })
      ])
      
      // Handle responses: 404 is expected when no data exists yet (not an error)
      const airQuality = airQualityRes.ok ? await airQualityRes.json() : { success: false }
      const waterLevels = waterLevelsRes.ok ? await waterLevelsRes.json() : { success: false }
      const seismic = seismicRes.ok ? await seismicRes.json() : { success: false }
      const advanced = advancedRes.ok ? await advancedRes.json() : { success: false }
      
      const processedData = {
        airQuality: airQuality.success ? airQuality.data : null,
        waterLevels: waterLevels.success ? {
          ...waterLevels.data,
          river_level: waterLevels.data.river_level ?? waterLevels.data.level ?? 0,
          location: waterLevels.data.location,
          timestamp: waterLevels.data.timestamp,
          source: waterLevels.data.source
        } : null,
        seismic: seismic.success ? {
          ...seismic.data,
          depth: seismic.data.depth_miles ?? seismic.data.depth,
          timestamp: seismic.data.timestamp,
          source: seismic.data.source
        } : null,
        advancedMetrics: advanced.success ? (() => {
          const rawScore = advanced.data.environmental_quality_score
          const normalized = typeof rawScore === 'number' && rawScore <= 1 ? rawScore * 100 : rawScore
          return {
            ...advanced.data,
            // Normalise for display so users don't see 0.71/100 style values
            environmental_quality_score: normalized,
            scoreDisplay: typeof normalized === 'number' ? normalized : null,
            uvDisplay: typeof advanced.data.uv_index === 'number' ? advanced.data.uv_index : Number(advanced.data.uv_index) || null,
            timestamp: advanced.data.timestamp,
            source: advanced.data.source
          }
        })() : null,
        lastUpdated: new Date().toLocaleTimeString('en-GB')
      }
      
      setData(processedData)
      const newAlerts = processDataIntoAlerts(processedData)
      setAlerts(newAlerts)
      // Update sticky memory for only high/critical alerts
      setStickyByType(prev => {
        const next = { ...prev }
        for (const a of newAlerts) {
          if (a.severity === 'high' || a.severity === 'critical') {
            next[a.type] = a
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

          

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {/* Air Quality */}
            <GlowCard glowColor="blue" customSize className="flex flex-col">
              <div className="flex items-center justify-center space-x-2 -mx-4 -mt-4 px-4 py-3 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
                <Database className="h-4 w-4 text-blue-400" />
                <span className="font-semibold text-sm text-blue-400">Air Quality Alerts</span>
              </div>
              <div className="flex-1 flex flex-col justify-center py-3">
              {(() => {
                const current = alerts.filter(a => a.type === 'air')
                const toShow = current.length > 0 ? current : (stickyByType.air ? [stickyByType.air] : [])
                return toShow.length > 0 ? (
                  toShow.map((alert, index) => (
                  <div key={index} className="text-center">
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
                  ))
                ) : data?.airQuality ? (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">Good</div>
                  <div className="text-sm text-slate-400 mb-2">AQI: {data.airQuality.aqi} • PM2.5: {data.airQuality.pm25} μg/m³</div>
                  <div className="text-xs text-slate-500 mb-1">📍 {data.airQuality.location}</div>
                  <div className="text-xs text-slate-600">🕒 {new Date(data.airQuality.timestamp).toLocaleString('en-GB')}</div>
                </div>
                ) : (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">Great! No alerts</div>
                  <div className="text-sm text-slate-400">No air quality data available</div>
                </div>
                )
              })()}
              </div>
              <div className="flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2 border-t border-slate-700/30">
                <Badge variant="secondary" className="bg-blue-900/50 text-blue-400">
                  {data?.lastUpdated ? `Updated: ${data.lastUpdated}` : 'No data'}
                </Badge>
              </div>
            </GlowCard>

            {/* Water Levels */}
            <GlowCard glowColor="blue" customSize className="flex flex-col">
              <div className="flex items-center justify-center space-x-2 -mx-4 -mt-4 px-4 py-3 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
                <Droplets className="h-4 w-4 text-blue-400" />
                <span className="font-semibold text-sm text-blue-400">Water Level Alerts</span>
              </div>
              <div className="flex-1 flex flex-col justify-center py-3">
              {(() => {
                const current = alerts.filter(a => a.type === 'water')
                const toShow = current.length > 0 ? current : (stickyByType.water ? [stickyByType.water] : [])
                return toShow.length > 0 ? (
                  toShow.map((alert, index) => (
                  <div key={index} className="text-center">
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
                  ))
                ) : data?.waterLevels ? (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">Good</div>
                  <div className="text-sm text-slate-400 mb-2">Level: {data.waterLevels.river_level}m</div>
                  <div className="text-xs text-slate-500 mb-1">📍 {data.waterLevels.location}</div>
                  <div className="text-xs text-slate-600">🕒 {new Date(data.waterLevels.timestamp).toLocaleString('en-GB')}</div>
                </div>
                ) : (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">Great! No alerts</div>
                  <div className="text-sm text-slate-400">No water level data available</div>
                </div>
                )
              })()}
              </div>
              <div className="flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2 border-t border-slate-700/30">
                <Badge variant="secondary" className="bg-blue-900/50 text-blue-400">
                  {data?.lastUpdated ? `Updated: ${data.lastUpdated}` : 'No data'}
                </Badge>
              </div>
            </GlowCard>

            {/* Seismic */}
            <GlowCard glowColor="blue" customSize className="flex flex-col">
              <div className="flex items-center justify-center space-x-2 -mx-4 -mt-4 px-4 py-3 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
                <Activity className="h-4 w-4 text-blue-400" />
                <span className="font-semibold text-sm text-blue-400">Seismic Alerts</span>
              </div>
              <div className="flex-1 flex flex-col justify-center py-3">
              {(() => {
                const current = alerts.filter(a => a.type === 'seismic')
                const toShow = current.length > 0 ? current : (stickyByType.seismic ? [stickyByType.seismic] : [])
                return toShow.length > 0 ? (
                  toShow.map((alert, index) => (
                  <div key={index} className="text-center">
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
                  ))
                ) : data?.seismic ? (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">Good</div>
                  <div className="text-sm text-slate-400 mb-2">Magnitude: {data.seismic.magnitude}M • Depth: {data.seismic.depth ? `${data.seismic.depth} miles` : 'Unknown'}</div>
                  <div className="text-xs text-slate-500 mb-1">📍 {data.seismic.location}</div>
                  <div className="text-xs text-slate-600">🕒 {new Date(data.seismic.timestamp).toLocaleString('en-GB')}</div>
                </div>
                ) : (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">Great! No alerts</div>
                  <div className="text-sm text-slate-400">No seismic data available</div>
                </div>
                )
              })()}
              </div>
              <div className="flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2 border-t border-slate-700/30">
                <Badge variant="secondary" className="bg-blue-900/50 text-blue-400">
                  {data?.lastUpdated ? `Updated: ${data.lastUpdated}` : 'No data'}
                </Badge>
              </div>
            </GlowCard>

            {/* Environmental */}
            <GlowCard glowColor="blue" customSize className="flex flex-col">
              <div className="flex items-center justify-center space-x-2 -mx-4 -mt-4 px-4 py-3 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
                <Thermometer className="h-4 w-4 text-blue-400" />
                <span className="font-semibold text-sm text-blue-400">Environmental Alerts</span>
              </div>
              <div className="flex-1 flex flex-col justify-center py-3">
              {(() => {
                const current = alerts.filter(a => a.type === 'environmental')
                const toShow = current.length > 0 ? current : (stickyByType.environmental ? [stickyByType.environmental] : [])
                return toShow.length > 0 ? (
                  toShow.map((alert, index) => (
                  <div key={index} className="text-center">
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
                  ))
                ) : data?.advancedMetrics ? (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">Good</div>
                  <div className="text-sm text-slate-400 mb-2">Score: {typeof data.advancedMetrics.scoreDisplay === 'number' ? data.advancedMetrics.scoreDisplay.toFixed(1) : data.advancedMetrics.environmental_quality_score}/100 • UV: {typeof data.advancedMetrics.uvDisplay === 'number' ? data.advancedMetrics.uvDisplay.toFixed(1) : data.advancedMetrics.uv_index}</div>
                  <div className="text-xs text-slate-500 mb-1">📍 {data.advancedMetrics.location}</div>
                  <div className="text-xs text-slate-600">🕒 {new Date(data.advancedMetrics.timestamp).toLocaleString('en-GB')}</div>
                </div>
                ) : (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">Great! No alerts</div>
                  <div className="text-sm text-slate-400">No environmental data available</div>
                </div>
                )
              })()}
              </div>
              <div className="flex justify-center pt-2 -mx-4 -mb-4 px-4 py-2 border-t border-slate-700/30">
                <Badge variant="secondary" className="bg-blue-900/50 text-blue-400">
                  {data?.lastUpdated ? `Updated: ${data.lastUpdated}` : 'No data'}
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
