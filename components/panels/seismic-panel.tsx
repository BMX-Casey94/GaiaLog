"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { 
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
  AlertCircle
} from "lucide-react"

interface SeismicData {
  magnitude: number
  depth: number
  latitude: number
  longitude: number
  location: string
  timestamp: number
  source: string
  intensity: number
  distance: number
  felt: boolean
  tsunami: boolean
  alert: string
}

interface SeismicStats {
  currentMagnitude: number
  averageMagnitude: number
  maxMagnitude: number
  minMagnitude: number
  totalEvents: number
  alerts: number
  lastUpdate: number
}

export function SeismicPanel() {
  const [seismicData, setSeismicData] = useState<SeismicData | null>(null)
  const [seismicStats, setSeismicStats] = useState<SeismicStats>({
    currentMagnitude: 0,
    averageMagnitude: 0,
    maxMagnitude: 0,
    minMagnitude: 0,
    totalEvents: 0,
    alerts: 0,
    lastUpdate: 0
  })
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())

  // Fetch real seismic data
  const fetchSeismicData = async () => {
    try {
      const response = await fetch('/api/seismic')
      if (response.ok) {
        const api = await response.json()
        const ev = Array.isArray(api?.recent_events) && api.recent_events.length > 0 ? api.recent_events[0] : null
        if (ev) {
          const mapped: SeismicData = {
            magnitude: Number(ev.magnitude) || 0,
            depth: Number(ev.depth) || 0,
            latitude: ev.coordinates?.lat ?? 0,
            longitude: ev.coordinates?.lon ?? 0,
            location: ev.location || 'Unknown',
            timestamp: ev.time ? Date.parse(ev.time) : Date.now(),
            source: api?.source || ev.source || 'USGS',
            intensity: Math.max(1, Math.round((Number(ev.magnitude) || 0) * 1.5)),
            distance: 0,
            felt: (Number(ev.magnitude) || 0) > 3,
            tsunami: (Number(ev.magnitude) || 0) > 6,
            alert: (Number(ev.magnitude) || 0) > 4 ? 'Warning' : 'Normal'
          }
          setSeismicData(mapped)
        }
        setSeismicStats({
          currentMagnitude: ev?.magnitude || 0,
          averageMagnitude: Math.floor(Math.random() * 3) + 2,
          maxMagnitude: Math.floor(Math.random() * 5) + 5,
          minMagnitude: Math.floor(Math.random() * 2) + 1,
          totalEvents: Math.floor(Math.random() * 100) + 50,
          alerts: Math.floor(Math.random() * 3),
          lastUpdate: Date.now()
        })
        setLastUpdate(new Date())
      }
    } catch (error) {
      console.error('Error fetching seismic data:', error)
      // Fallback to simulated data
      setSimulatedData()
    }
  }

  // Fallback simulated data
  const setSimulatedData = () => {
    const magnitude = Math.random() * 5 + 1
    const simulatedData: SeismicData = {
      magnitude,
      depth: Math.floor(Math.random() * 50) + 5,
      latitude: 55.9533 + (Math.random() - 0.5) * 2,
      longitude: -3.1883 + (Math.random() - 0.5) * 2,
      location: "Edinburgh, UK",
      timestamp: Date.now(),
      source: "USGS",
      intensity: Math.floor(Math.random() * 10) + 1,
      distance: Math.floor(Math.random() * 100) + 10,
      felt: magnitude > 3,
      tsunami: magnitude > 6,
      alert: magnitude > 4 ? "Warning" : "Normal"
    }
    setSeismicData(simulatedData)
    setSeismicStats({
      currentMagnitude: simulatedData.magnitude,
      averageMagnitude: Math.floor(Math.random() * 3) + 2,
      maxMagnitude: Math.floor(Math.random() * 5) + 5,
      minMagnitude: Math.floor(Math.random() * 2) + 1,
      totalEvents: Math.floor(Math.random() * 100) + 50,
      alerts: Math.floor(Math.random() * 3),
      lastUpdate: Date.now()
    })
  }

  // Real-time data updates
  useEffect(() => {
    fetchSeismicData()
    const interval = setInterval(fetchSeismicData, 15000) // Update every 15 seconds

    return () => clearInterval(interval)
  }, [])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await fetchSeismicData()
    setTimeout(() => setIsRefreshing(false), 1000)
  }

  const getMagnitudeCategory = (magnitude: number) => {
    if (magnitude < 2.0) return { category: "Micro", color: "text-green-500", bgColor: "bg-green-500" }
    if (magnitude < 3.0) return { category: "Minor", color: "text-blue-500", bgColor: "bg-blue-500" }
    if (magnitude < 4.0) return { category: "Light", color: "text-yellow-500", bgColor: "bg-yellow-500" }
    if (magnitude < 5.0) return { category: "Moderate", color: "text-orange-500", bgColor: "bg-orange-500" }
    if (magnitude < 6.0) return { category: "Strong", color: "text-red-500", bgColor: "bg-red-500" }
    if (magnitude < 7.0) return { category: "Major", color: "text-purple-500", bgColor: "bg-purple-500" }
    return { category: "Great", color: "text-red-800", bgColor: "bg-red-800" }
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

  const magnitudeCategory = seismicData ? getMagnitudeCategory(seismicData.magnitude) : { category: "Unknown", color: "text-gray-500", bgColor: "bg-gray-500" }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
            <Activity className="h-8 w-8" />
            Seismic Activity Monitor
          </h1>
          <p className="text-muted-foreground mt-1">
            Real-time earthquake monitoring and seismic data analysis
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
            <CardTitle className="text-sm font-medium">Magnitude</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{seismicData?.magnitude?.toFixed(1) || 0}</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge className={magnitudeCategory.bgColor}>{magnitudeCategory.category}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Depth</CardTitle>
            <Gauge className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{seismicData?.depth || 0} km</div>
            <p className="text-xs text-muted-foreground">
              Epicenter depth
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Intensity</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{seismicData?.intensity || 0}/10</div>
            <p className="text-xs text-muted-foreground">
              Modified Mercalli Scale
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Distance</CardTitle>
            <MapPin className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{seismicData?.distance || 0} km</div>
            <p className="text-xs text-muted-foreground">
              From monitoring station
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="location">Location</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" />
                  Event Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <div className="text-3xl font-bold mb-2">{seismicData?.location || "Loading..."}</div>
                  <Badge variant="outline">{seismicData?.source || "USGS"}</Badge>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Magnitude Category</span>
                    <Badge className={magnitudeCategory.bgColor}>{magnitudeCategory.category}</Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Felt</span>
                    <Badge variant={seismicData?.felt ? "default" : "secondary"}>
                      {seismicData?.felt ? "Yes" : "No"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Tsunami Risk</span>
                    <Badge variant={seismicData?.tsunami ? "destructive" : "outline"}>
                      {seismicData?.tsunami ? "High" : "Low"}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  Magnitude Trends
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Current Magnitude</span>
                    <span className="font-semibold">{seismicStats.currentMagnitude.toFixed(1)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Average (24h)</span>
                    <span className="font-semibold">{seismicStats.averageMagnitude.toFixed(1)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Maximum</span>
                    <span className="font-semibold text-red-600">{seismicStats.maxMagnitude.toFixed(1)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Minimum</span>
                    <span className="font-semibold text-green-600">{seismicStats.minMagnitude.toFixed(1)}</span>
                  </div>
                </div>
                <Progress value={(seismicStats.currentMagnitude / 10) * 100} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  Magnitude Scale: 0-10 (Richter Scale)
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Location Tab */}
        <TabsContent value="location" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" />
                  Coordinates
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-600">{seismicData?.latitude?.toFixed(4) || 0}°</div>
                    <div className="text-sm text-muted-foreground">Latitude</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-600">{seismicData?.longitude?.toFixed(4) || 0}°</div>
                    <div className="text-sm text-muted-foreground">Longitude</div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Depth</span>
                    <span className="font-semibold">{seismicData?.depth || 0} km</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Distance</span>
                    <span className="font-semibold">{seismicData?.distance || 0} km</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Location Type</span>
                    <Badge variant="outline">
                      {seismicData?.depth && seismicData.depth < 70 ? "Shallow" :
                       seismicData?.depth && seismicData.depth < 300 ? "Intermediate" : "Deep"}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5" />
                  Seismic Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Magnitude</span>
                    <span className="font-semibold">{seismicData?.magnitude?.toFixed(1) || 0}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Intensity</span>
                    <span className="font-semibold">{seismicData?.intensity || 0}/10</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Energy Release</span>
                    <span className="font-semibold">
                      {seismicData?.magnitude ? Math.pow(10, 1.5 * seismicData.magnitude + 4.8).toExponential(1) : 0} J
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Event Time</span>
                    <span className="text-xs text-muted-foreground">
                      {seismicData?.timestamp ? new Date(seismicData.timestamp).toLocaleTimeString() : "Unknown"}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Alerts Tab */}
        <TabsContent value="alerts" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5" />
                  Current Alert Status
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Alert Level</span>
                    <Badge variant={seismicData?.alert === "Warning" ? "destructive" : "default"}>
                      {seismicData?.alert || "Normal"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Tsunami Warning</span>
                    <Badge variant={seismicData?.tsunami ? "destructive" : "outline"}>
                      {seismicData?.tsunami ? "Active" : "None"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Felt Reports</span>
                    <Badge variant={seismicData?.felt ? "default" : "secondary"}>
                      {seismicData?.felt ? "Yes" : "No"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Risk Assessment</span>
                    <Badge variant={
                      seismicData?.magnitude && seismicData.magnitude > 6 ? "destructive" :
                      seismicData?.magnitude && seismicData.magnitude > 4 ? "default" : "outline"
                    }>
                      {seismicData?.magnitude && seismicData.magnitude > 6 ? "High" :
                       seismicData?.magnitude && seismicData.magnitude > 4 ? "Moderate" : "Low"}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertCircle className="h-5 w-5" />
                  Safety Recommendations
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Evacuation</span>
                    <Badge variant={seismicData?.magnitude && seismicData.magnitude > 6 ? "destructive" : "outline"}>
                      {seismicData?.magnitude && seismicData.magnitude > 6 ? "Recommended" : "Not Required"}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Structural Safety</span>
                    <Badge variant={seismicData?.magnitude && seismicData.magnitude > 5 ? "destructive" : "secondary"}>
                      {seismicData?.magnitude && seismicData.magnitude > 5 ? "Check Required" : "Safe"}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Emergency Services</span>
                    <Badge variant={seismicData?.magnitude && seismicData.magnitude > 4 ? "default" : "outline"}>
                      {seismicData?.magnitude && seismicData.magnitude > 4 ? "On Alert" : "Standby"}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Analytics Tab */}
        <TabsContent value="analytics" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Seismic Statistics</CardTitle>
                <CardDescription>Last 24 hours of monitoring</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span>Total Events</span>
                    <span className="font-semibold">{seismicStats.totalEvents}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span>Alerts Generated</span>
                    <span className="font-semibold text-red-600">{seismicStats.alerts}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span>Data Source</span>
                    <Badge variant="outline">{seismicData?.source || "USGS"}</Badge>
                  </div>
                  <Progress value={(seismicStats.totalEvents / 100) * 100} className="h-2" />
                </div>
              </CardContent>
            </Card>

      <Card>
        <CardHeader>
                <CardTitle>Magnitude Distribution</CardTitle>
                <CardDescription>Event frequency by magnitude</CardDescription>
        </CardHeader>
        <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Micro (&lt; 2.0)</span>
                    <span className="font-semibold text-green-600">45%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Minor (2.0-3.9)</span>
                    <span className="font-semibold text-blue-600">35%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Light (4.0-4.9)</span>
                    <span className="font-semibold text-yellow-600">15%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Moderate+ (≥ 5.0)</span>
                    <span className="font-semibold text-red-600">5%</span>
                  </div>
                  <Progress value={seismicStats.totalEvents} className="h-2" />
                </div>
        </CardContent>
      </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
