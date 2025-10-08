"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { 
  BarChart3, 
  Activity, 
  TrendingUp, 
  AlertTriangle, 
  CheckCircle, 
  Clock, 
  XCircle,
  RefreshCw,
  Zap,
  Database,
  MapPin,
  Thermometer,
  Wind,
  Gauge,
  Waves,
  AlertCircle,
  Globe,
  Satellite
} from "lucide-react"

interface AdvancedMetricsData {
  // Environmental metrics
  airQualityIndex: number
  waterQualityIndex: number
  soilMoisture: number
  vegetationIndex: number
  
  // Climate metrics
  temperature: number
  humidity: number
  pressure: number
  windSpeed: number
  windDirection: number
  precipitation: number
  
  // Advanced sensors
  radiationLevel: number
  noiseLevel: number
  lightIntensity: number
  magneticField: number
  
  // Location and metadata
  location: string
  timestamp: number
  source: string
  coordinates: {
    latitude: number
    longitude: number
  }
}

interface AdvancedStats {
  currentScore: number
  averageScore: number
  maxScore: number
  minScore: number
  totalReadings: number
  alerts: number
  lastUpdate: number
}

export function AdvancedPanel() {
  const [advancedData, setAdvancedData] = useState<AdvancedMetricsData | null>(null)
  const [advancedStats, setAdvancedStats] = useState<AdvancedStats>({
    currentScore: 0,
    averageScore: 0,
    maxScore: 0,
    minScore: 0,
    totalReadings: 0,
    alerts: 0,
    lastUpdate: 0
  })
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [trends, setTrends] = useState<any>(null)

  // Fetch fresh advanced metrics data using the same endpoint as Live Dashboard
  const fetchAdvancedData = async () => {
    try {
      const response = await fetch('/api/data/collect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
      if (response.ok) {
        const result = await response.json()
        const advancedData = result.data?.advancedMetrics
        
        if (advancedData) {
          const mapped = {
            airQualityIndex: 0,
            waterQualityIndex: 0,
            soilMoisture: typeof advancedData?.soil_moisture?.value === 'number'
              ? Math.round(advancedData.soil_moisture.value)
              : (typeof advancedData?.soil_moisture === 'number' ? Math.round(advancedData.soil_moisture) : 0),
            vegetationIndex: 0,
            temperature: typeof advancedData?.temperature_c === 'number' ? advancedData.temperature_c : 0,
            humidity: typeof advancedData?.humidity_pct === 'number' ? advancedData.humidity_pct : 0,
            pressure: typeof advancedData?.pressure_mb === 'number' ? advancedData.pressure_mb : 0,
            windSpeed: typeof advancedData?.wind_kph === 'number' ? advancedData.wind_kph : 0,
            windDirection: 0,
            precipitation: 0,
            radiationLevel: 0,
            noiseLevel: 0,
            lightIntensity: 0,
            magneticField: 0,
            location: advancedData?.location || 'Unknown',
            timestamp: Date.now(),
            source: advancedData?.source || 'Derived',
            coordinates: { latitude: advancedData?.coordinates?.lat ?? 0, longitude: advancedData?.coordinates?.lon ?? 0 },
          } as AdvancedMetricsData
          setAdvancedData(mapped)
          setAdvancedStats({
            currentScore: advancedData?.environmental_quality_score || 0,
            averageScore: Math.floor(Math.random() * 50) + 30,
            maxScore: Math.floor(Math.random() * 100) + 150,
            minScore: Math.floor(Math.random() * 20) + 10,
            totalReadings: Math.floor(Math.random() * 1000) + 500,
            alerts: Math.floor(Math.random() * 5),
            lastUpdate: Date.now()
          })
          setLastUpdate(new Date())
        } else {
          console.warn('No advanced metrics data in fresh collection response')
          setAdvancedData(null)
        }
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
    } catch (error) {
      console.error('Error fetching fresh advanced metrics data:', error)
      // Don't fall back to simulated data - show no data instead
      setAdvancedData(null)
    }
  }

  // No simulated data fallback - use real data only

  // Real-time data updates - match Live Dashboard refresh rate
  useEffect(() => {
    fetchAdvancedData()
    const interval = setInterval(fetchAdvancedData, 5 * 60 * 1000) // Update every 5 minutes (same as Live Dashboard)

    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const fetchTrends = async () => {
      try {
        const res = await fetch('/api/trends')
        if (res.ok) {
          const json = await res.json()
          setTrends(json)
        }
      } catch {}
    }
    fetchTrends()
    const trendsInterval = setInterval(fetchTrends, 30000)
    return () => clearInterval(trendsInterval)
  }, [])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await fetchAdvancedData()
    setTimeout(() => setIsRefreshing(false), 1000)
  }

  const getEnvironmentalScore = (data: AdvancedMetricsData) => {
    const scores = [
      data.airQualityIndex / 200 * 100,
      data.waterQualityIndex,
      data.soilMoisture,
      data.vegetationIndex
    ]
    return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
  }

  const getScoreCategory = (score: number) => {
    if (score >= 80) return { category: "Excellent", color: "text-green-500", bgColor: "bg-green-500" }
    if (score >= 60) return { category: "Good", color: "text-blue-500", bgColor: "bg-blue-500" }
    if (score >= 40) return { category: "Moderate", color: "text-yellow-500", bgColor: "bg-yellow-500" }
    if (score >= 20) return { category: "Poor", color: "text-orange-500", bgColor: "bg-orange-500" }
    return { category: "Critical", color: "text-red-500", bgColor: "bg-red-500" }
  }

  const formatLastUpdate = (date: Date) => {
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    
    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    return `${diffHours}h ago`
  }

  const environmentalScore = advancedData ? getEnvironmentalScore(advancedData) : 0
  const scoreCategory = getScoreCategory(environmentalScore)

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
            <BarChart3 className="h-8 w-8" />
            Advanced Metrics Monitor
          </h1>
          <p className="text-muted-foreground mt-1">
            Comprehensive environmental monitoring and multi-sensor data analysis
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Last updated: {formatLastUpdate(lastUpdate)}
          </p>
        </div>
        <Button onClick={handleRefresh} disabled={isRefreshing}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Environmental Score</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{environmentalScore}/100</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge className={scoreCategory.bgColor}>{scoreCategory.category}</Badge>
            </div>
          </CardContent>
        </Card>

        {/* Removed AQI and Water Quality (handled in dedicated panels) */}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Soil Moisture</CardTitle>
            <Gauge className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{advancedData?.soilMoisture || 0}%</div>
            <p className="text-xs text-muted-foreground">
              Soil moisture content
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="environmental">Environmental</TabsTrigger>
          <TabsTrigger value="climate">Climate</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" />
                  Monitoring Station
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <div className="text-3xl font-bold mb-2">{advancedData?.location || "Loading..."}</div>
                  <Badge variant="outline">{advancedData?.source || "Multi-Sensor Array"}</Badge>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Environmental Score</span>
                    <Badge className={scoreCategory.bgColor}>{scoreCategory.category}</Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Latitude</span>
                    <span className="font-semibold">{typeof advancedData?.coordinates?.latitude === 'number' ? advancedData.coordinates.latitude.toFixed(4) : '—'}°</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Longitude</span>
                    <span className="font-semibold">{typeof advancedData?.coordinates?.longitude === 'number' ? advancedData.coordinates.longitude.toFixed(4) : '—'}°</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  Environmental Trends
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Current Score</span>
                    <span className="font-semibold">{environmentalScore}/100</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Average (24h)</span>
                    <span className="font-semibold">{(() => { const v = Number(trends?.advanced?.avg ?? 0); return Math.max(0, Math.min(100, Math.round(v))); })()}/100</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Maximum (24h)</span>
                    <span className="font-semibold text-green-600">{(() => { const v = Number(trends?.advanced?.max ?? 0); return Math.max(0, Math.min(100, Math.round(v))); })()}/100</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Minimum (24h)</span>
                    <span className="font-semibold text-red-600">{(() => { const v = Number(trends?.advanced?.min ?? 0); return Math.max(0, Math.min(100, Math.round(v))); })()}/100</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Readings (24h)</span>
                    <span className="font-semibold">{trends?.advanced?.count ?? 0}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Soil Moisture Avg (24h)</span>
                    <span className="font-semibold">{(() => { const v = Number(trends?.advanced?.soil_moisture_avg ?? 0); return Math.max(0, Math.min(100, Math.round(v))); })()}%</span>
                  </div>
                </div>
                <Progress value={environmentalScore} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  Environmental Score Scale: 0-100
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Environmental Tab */}
        <TabsContent value="environmental" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Soil Moisture</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold mb-2">{advancedData?.soilMoisture || 0}%</div>
                <Progress value={advancedData?.soilMoisture || 0} className="h-2 mb-2" />
                <p className="text-xs text-muted-foreground">
                  Optimal: 20-40%
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Vegetation Index</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold mb-2">{advancedData?.vegetationIndex || 0}/100</div>
                <Progress value={advancedData?.vegetationIndex || 0} className="h-2 mb-2" />
                <p className="text-xs text-muted-foreground">
                  NDVI Scale: 0-100
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Environmental Score</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold mb-2">{environmentalScore}/100</div>
                <Progress value={environmentalScore} className="h-2 mb-2" />
                <p className="text-xs text-muted-foreground">
                  Overall environmental health
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Status Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Air Quality</span>
                    <Badge variant={advancedData?.airQualityIndex && advancedData.airQualityIndex > 100 ? "destructive" : "default"}>
                      {advancedData?.airQualityIndex && advancedData.airQualityIndex > 100 ? "Poor" : "Good"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Water Quality</span>
                    <Badge variant={advancedData?.waterQualityIndex && advancedData.waterQualityIndex < 60 ? "destructive" : "default"}>
                      {advancedData?.waterQualityIndex && advancedData.waterQualityIndex < 60 ? "Poor" : "Good"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Soil Health</span>
                    <Badge variant={advancedData?.soilMoisture && (advancedData.soilMoisture < 20 || advancedData.soilMoisture > 40) ? "destructive" : "default"}>
                      {advancedData?.soilMoisture && (advancedData.soilMoisture < 20 || advancedData.soilMoisture > 40) ? "Poor" : "Good"}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Climate Tab */}
        <TabsContent value="climate" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Thermometer className="h-5 w-5" />
                  Climate Conditions
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-blue-600">{advancedData?.temperature || 0}°C</div>
                    <div className="text-sm text-muted-foreground">Temperature</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-cyan-600">{advancedData?.humidity || 0}%</div>
                    <div className="text-sm text-muted-foreground">Humidity</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-gray-600">{advancedData?.pressure || 0} hPa</div>
                    <div className="text-sm text-muted-foreground">Pressure</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-green-600">{advancedData?.windSpeed || 0} km/h</div>
                    <div className="text-sm text-muted-foreground">Wind Speed</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wind className="h-5 w-5" />
                  Wind Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <div className="text-4xl font-bold mb-2">{(advancedData as any)?.windDirection || (advancedData as any)?.wind_deg || 0}°</div>
                  <div className="text-sm text-muted-foreground">Wind Direction</div>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Wind Speed</span>
                    <span className="font-semibold">{advancedData?.windSpeed || 0} km/h</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Precipitation</span>
                    <span className="font-semibold">{advancedData?.precipitation || 0} mm</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Wind Category</span>
                    <Badge variant="outline">
                      {advancedData?.windSpeed && advancedData.windSpeed < 10 ? "Light" :
                       advancedData?.windSpeed && advancedData.windSpeed < 20 ? "Moderate" :
                       advancedData?.windSpeed && advancedData.windSpeed < 30 ? "Strong" : "Very Strong"}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Advanced Sensors removed for launch (no live sources yet) */}

        {/* Analytics Tab */}
        <TabsContent value="analytics" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Advanced Metrics Statistics</CardTitle>
                <CardDescription>Last 24 hours of monitoring</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span>Total Readings</span>
                    <span className="font-semibold">{trends?.advanced?.count ?? 0}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span>Alerts Generated</span>
                    <span className="font-semibold text-red-600">0</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span>Data Source</span>
                    <Badge variant="outline">{advancedData?.source || "Multi-Sensor Array"}</Badge>
                  </div>
                  <Progress value={Math.min(100, ((trends?.advanced?.count ?? 0) / 1000) * 100)} className="h-2" />
                </div>
              </CardContent>
            </Card>

      <Card>
        <CardHeader>
                <CardTitle>Environmental Health</CardTitle>
                <CardDescription>Overall system status</CardDescription>
        </CardHeader>
        <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Air Quality</span>
                    <Badge variant={advancedData?.airQualityIndex && advancedData.airQualityIndex > 100 ? "destructive" : "default"}>
                      {advancedData?.airQualityIndex && advancedData.airQualityIndex > 100 ? "Poor" : "Good"}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Water Quality</span>
                    <Badge variant={advancedData?.waterQualityIndex && advancedData.waterQualityIndex < 60 ? "destructive" : "default"}>
                      {advancedData?.waterQualityIndex && advancedData.waterQualityIndex < 60 ? "Poor" : "Good"}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Soil Health</span>
                    <Badge variant={advancedData?.soilMoisture && (advancedData.soilMoisture < 20 || advancedData.soilMoisture > 40) ? "destructive" : "default"}>
                      {advancedData?.soilMoisture && (advancedData.soilMoisture < 20 || advancedData.soilMoisture > 40) ? "Poor" : "Good"}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Overall Score</span>
                    <Badge className={scoreCategory.bgColor}>{scoreCategory.category}</Badge>
                  </div>
                </div>
        </CardContent>
      </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
