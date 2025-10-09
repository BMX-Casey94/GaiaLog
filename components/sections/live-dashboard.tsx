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

  const processDataIntoAlerts = (data: any): AlertData[] => {
    const alerts: AlertData[] = []
    
    // Process Air Quality - Only show moderate or worse
    if (data.airQuality) {
      const aqi = data.airQuality.aqi
      let severity: 'low' | 'moderate' | 'high' | 'critical' = 'low'
      if (aqi > 150) severity = 'critical'
      else if (aqi > 100) severity = 'high'
      else if (aqi > 50) severity = 'moderate'
      
      // Only add to alerts if it's moderate or worse
      if (severity !== 'low') {
        alerts.push({
          type: 'air',
          severity,
          value: aqi,
          location: data.airQuality.location,
          timestamp: data.airQuality.timestamp,
          source: data.airQuality.source,
          details: `AQI: ${aqi} • PM2.5: ${data.airQuality.pm25} μg/m³`
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
          details: `Level: ${level}m`
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
          details: `Magnitude: ${magnitude}M • Depth: ${data.seismic.depth ? `${data.seismic.depth} (km)` : 'Unknown (km)'}`
        })
      }
    }
    
    // Process Environmental Quality - Only show moderate or worse
    if (data.advancedMetrics) {
      const score = data.advancedMetrics.environmental_quality_score
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
          details: `Score: ${score}/100 • UV: ${data.advancedMetrics.uv_index}`
        })
      }
    }
    
    return alerts
  }

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      // Fetch from database (kept fresh by local workers)
      const [airQualityRes, waterLevelsRes, seismicRes] = await Promise.all([
        fetch('/api/air-quality/latest'),
        fetch('/api/water-levels?limit=1'),
        fetch('/api/seismic?limit=1')
      ])
      
      const airQuality = await airQualityRes.json()
      const waterLevels = await waterLevelsRes.json()
      const seismic = await seismicRes.json()
      
      const processedData = {
        airQuality: airQuality.success ? airQuality.data : null,
        waterLevels: waterLevels.success && waterLevels.data?.length > 0 ? waterLevels.data[0] : null,
        seismic: seismic.success && seismic.data?.length > 0 ? seismic.data[0] : null,
        advancedMetrics: null, // Not displayed in Live Alerts
        lastUpdated: new Date().toLocaleTimeString()
      }
      
      setData(processedData)
      setAlerts(processDataIntoAlerts(processedData))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // Refresh every 5 minutes
    const interval = setInterval(fetchData, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])
  return (
    <section id="monitoring" className="py-20 px-4 sm:px-6 lg:px-8 relative">
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
            <GlowCard glowColor="blue" customSize disableGlow className="h-64">
              <div className="flex items-center justify-center space-x-2 text-blue-400 mb-1">
                <Database className="h-5 w-5" />
                <span className="font-semibold">Air Quality Alerts</span>
              </div>
              {alerts.filter(a => a.type === 'air').length > 0 ? (
                alerts.filter(a => a.type === 'air').map((alert, index) => (
                  <div key={index} className="mb-3 text-center">
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
                    <div className="text-sm text-slate-400 mb-2">
                      {alert.details}
                    </div>
                    <div className="text-xs text-slate-500 mb-1">
                      📍 {alert.location}
                    </div>
                    <div className="text-xs text-slate-600 mb-1">
                      🕒 {new Date(alert.timestamp).toLocaleString('en-GB')}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">✓ GOOD</div>
                  <div className="text-sm text-slate-400 mb-3">No air quality alerts</div>
                  {data?.airQuality && (
                    <>
                      <div className="text-sm text-slate-400 mb-2">
                        AQI: {data.airQuality.aqi} • PM2.5: {data.airQuality.pm25} μg/m³
                      </div>
                      <div className="text-xs text-slate-500 mb-1">
                        📍 {data.airQuality.location}
                      </div>
                      <div className="text-xs text-slate-600 mb-1">
                        🕒 {new Date(data.airQuality.timestamp).toLocaleString('en-GB')}
                      </div>

                    </>
                  )}
                </div>
              )}
              <div className="flex justify-center mt-2">
                <Badge variant="secondary" className="bg-blue-900/50 text-blue-400">
                  {data?.lastUpdated ? `Updated: ${data.lastUpdated}` : 'No data'}
                </Badge>
              </div>
            </GlowCard>

            <GlowCard glowColor="blue" customSize disableGlow className="h-64">
              <div className="flex items-center justify-center space-x-2 text-blue-400 mb-1">
                <Droplets className="h-5 w-5" />
                <span className="font-semibold">Water Level Alerts</span>
              </div>
              {alerts.filter(a => a.type === 'water').length > 0 ? (
                alerts.filter(a => a.type === 'water').map((alert, index) => (
                  <div key={index} className="mb-3 text-center">
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
                    <div className="text-sm text-slate-400 mb-2">
                      {alert.details}
                    </div>
                    <div className="text-xs text-slate-500 mb-1">
                      📍 {alert.location}
                    </div>
                    <div className="text-xs text-slate-600 mb-1">
                      🕒 {new Date(alert.timestamp).toLocaleString('en-GB')}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">✓ GOOD</div>
                  <div className="text-sm text-slate-400 mb-3">No water level alerts</div>
                  {data?.waterLevels && (
                    <>
                      <div className="text-sm text-slate-400 mb-2">
                        Level: {data.waterLevels.river_level}m
                      </div>
                      <div className="text-xs text-slate-500 mb-1">
                        📍 {data.waterLevels.location}
                      </div>
                      <div className="text-xs text-slate-600 mb-1">
                        🕒 {new Date(data.waterLevels.timestamp).toLocaleString('en-GB')}
                      </div>

                    </>
                  )}
                </div>
              )}
              <div className="flex justify-center mt-2">
                <Badge variant="secondary" className="bg-blue-900/50 text-blue-400">
                  {data?.lastUpdated ? `Updated: ${data.lastUpdated}` : 'No data'}
                </Badge>
              </div>
            </GlowCard>

            <GlowCard glowColor="blue" customSize disableGlow className="h-64">
              <div className="flex items-center justify-center space-x-2 text-blue-400 mb-1">
                <Activity className="h-5 w-5" />
                <span className="font-semibold">Seismic Alerts</span>
              </div>
              {alerts.filter(a => a.type === 'seismic').length > 0 ? (
                alerts.filter(a => a.type === 'seismic').map((alert, index) => (
                  <div key={index} className="mb-3 text-center">
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
                    <div className="text-sm text-slate-400 mb-2">
                      {alert.details}
                    </div>
                    <div className="text-xs text-slate-500 mb-1">
                      📍 {alert.location}
                    </div>
                    <div className="text-xs text-slate-600 mb-1">
                      🕒 {new Date(alert.timestamp).toLocaleString('en-GB')}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">✓ GOOD</div>
                  <div className="text-sm text-slate-400 mb-3">No seismic alerts</div>
                  {data?.seismic && (
                    <>
                      <div className="text-sm text-slate-400 mb-2">
                        Magnitude: {data.seismic.magnitude}M • Depth: {data.seismic.depth ? `${data.seismic.depth} (km)` : 'Unknown (km)'}
                      </div>
                      <div className="text-xs text-slate-500 mb-1">
                        📍 {data.seismic.location}
                      </div>
                      <div className="text-xs text-slate-600 mb-1">
                        🕒 {new Date(data.seismic.timestamp).toLocaleString('en-GB')}
                      </div>

                    </>
                  )}
                </div>
              )}
              <div className="flex justify-center mt-2">
                <Badge variant="secondary" className="bg-blue-900/50 text-blue-400">
                  {data?.lastUpdated ? `Updated: ${data.lastUpdated}` : 'No data'}
                </Badge>
              </div>
            </GlowCard>

            <GlowCard glowColor="blue" customSize disableGlow className="h-64">
              <div className="flex items-center justify-center space-x-2 text-blue-400 mb-1">
                <Thermometer className="h-5 w-5" />
                <span className="font-semibold">Environmental Alerts</span>
              </div>
              {alerts.filter(a => a.type === 'environmental').length > 0 ? (
                alerts.filter(a => a.type === 'environmental').map((alert, index) => (
                  <div key={index} className="mb-3 text-center">
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
                    <div className="text-sm text-slate-400 mb-2">
                      {alert.details}
                    </div>
                    <div className="text-xs text-slate-500 mb-1">
                      📍 {alert.location}
                    </div>
                    <div className="text-xs text-slate-600 mb-1">
                      🕒 {new Date(alert.timestamp).toLocaleString('en-GB')}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">✓ GOOD</div>
                  <div className="text-sm text-slate-400 mb-3">No environmental alerts</div>
                  {data?.advancedMetrics && (
                    <>
                      <div className="text-sm text-slate-400 mb-2">
                        Score: {data.advancedMetrics.environmental_quality_score}/100 • UV: {data.advancedMetrics.uv_index}
                      </div>
                      <div className="text-xs text-slate-500 mb-1">
                        📍 {data.advancedMetrics.location}
                      </div>
                      <div className="text-xs text-slate-600 mb-1">
                        🕒 {new Date(data.advancedMetrics.timestamp).toLocaleString('en-GB')}
                      </div>

                    </>
                  )}
                </div>
              )}
              <div className="flex justify-center mt-2">
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
