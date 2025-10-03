"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Wind, Droplets, Activity, BarChart3, Clock, ExternalLink, AlertCircle } from "lucide-react"
import { useEnvironmentalData } from "@/hooks/use-environmental-data"
import { useBlockchain } from "@/hooks/use-blockchain"
import { Skeleton } from "@/components/ui/skeleton"

export function OverviewPanel() {
  const { airQuality, waterLevels, seismicData, advancedMetrics, loading, error, lastUpdated } = useEnvironmentalData()
  const { transactions, connectionStatus } = useBlockchain()
  const [providers, setProviders] = useState<{ weatherapi?: any; waqi?: any; owm?: any } | null>(null)

  useEffect(() => {
    const loadProviders = async () => {
      try {
        const res = await fetch('/api/providers/status')
        if (res.ok) {
          const data = await res.json()
          setProviders(data.results)
        }
      } catch (_) {}
    }
    loadProviders()
  }, [])

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold font-space-grotesk mb-2">Environmental Overview</h1>
          <p className="text-muted-foreground">Real-time environmental data monitoring with blockchain verification</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader className="space-y-0 pb-2">
                <Skeleton className="h-4 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16 mb-2" />
                <Skeleton className="h-3 w-32 mb-2" />
                <Skeleton className="h-5 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-destructive mb-4">
          <AlertCircle className="h-5 w-5" />
          <span>Error loading environmental data: {error}</span>
        </div>
      </div>
    )
  }

  const getAQIStatus = (aqi: number) => {
    if (aqi <= 50) return { label: "Good", color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" }
    if (aqi <= 100)
      return { label: "Moderate", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" }
    return { label: "Unhealthy", color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" }
  }

  const aqiStatus = airQuality ? getAQIStatus(airQuality.aqi) : { label: "Unknown", color: "bg-gray-100 text-gray-800" }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-space-grotesk mb-2">Environmental Overview</h1>
        <p className="text-muted-foreground">Real-time environmental data monitoring with blockchain verification</p>
        {lastUpdated && (
          <p className="text-xs text-muted-foreground mt-1">Last updated: {lastUpdated.toLocaleTimeString()}</p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Air Quality</CardTitle>
            <Wind className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{aqiStatus.label}</div>
            <p className="text-xs text-muted-foreground">
              AQI: {airQuality?.aqi} • PM2.5: {airQuality?.pm25} μg/m³
            </p>
                          <Badge variant="secondary" className={`mt-2 text-xs rounded-sm ${aqiStatus.color}`}>
              <Clock className="h-3 w-3 mr-1" />
              {airQuality ? new Date(airQuality.timestamp).toLocaleTimeString() : "N/A"}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Water Levels</CardTitle>
            <Droplets className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">Normal</div>
            <p className="text-xs text-muted-foreground">
              {waterLevels?.stations?.slice(0, 2)
                .map((s) => `${s.name.split(" at ")[0]}: ${s.level}m`)
                .join(" • ") || "—"}
            </p>
            <Badge variant="secondary" className="mt-2 text-xs rounded-sm">
              <Clock className="h-3 w-3 mr-1" />
              {waterLevels ? new Date(waterLevels.timestamp).toLocaleTimeString() : "N/A"}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Seismic Activity</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold capitalize">{seismicData?.status || "Unknown"}</div>
            <p className="text-xs text-muted-foreground">
              {seismicData?.recent_events[0]
                ? `Last: M${seismicData.recent_events[0].magnitude} • ${new Date(seismicData.recent_events[0].time).toLocaleDateString()}`
                : "No recent events"}
            </p>
            <Badge variant="secondary" className="mt-2 text-xs rounded-sm">
              <Clock className="h-3 w-3 mr-1" />
              {seismicData ? new Date(seismicData.timestamp).toLocaleTimeString() : "N/A"}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Blockchain Status</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{connectionStatus?.connected ? "Active" : "Offline"}</div>
            <p className="text-xs text-muted-foreground">
              {transactions.length > 0
                ? `Last TX: ${new Date(transactions[0].timestamp).toLocaleTimeString()}`
                : "No transactions yet"}
            </p>
            <Badge variant="secondary" className="mt-2 text-xs rounded-sm">
              <ExternalLink className="h-3 w-3 mr-1" />
              View on BSV
            </Badge>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-space-grotesk">Recent Transactions</CardTitle>
            <CardDescription>Latest environmental data recorded on BSV blockchain</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {transactions.slice(0, 3).map((tx) => (
                <div key={tx.txid} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                  <div>
                    <p className="font-medium text-sm">{tx.data.dataType.replace("_", " ").toUpperCase()}</p>
                    <p className="text-xs text-muted-foreground">{new Date(tx.timestamp).toLocaleTimeString()}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-mono">{tx.txid.substring(0, 8)}...</p>
                    <Badge variant="secondary" className="text-xs rounded-sm">
                      {tx.status}
                    </Badge>
                  </div>
                </div>
              ))}
              {transactions.length === 0 && (
                <p className="text-muted-foreground text-center py-4">No transactions yet</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-space-grotesk">System Status</CardTitle>
            <CardDescription>Current status of data sources and integrations</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Provider statuses */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${providers?.weatherapi?.ok ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-sm font-medium">WeatherAPI</span>
                </div>
                <Badge variant={providers?.weatherapi?.ok ? 'default' : 'destructive'} className="text-xs rounded-sm">
                  {providers?.weatherapi?.ok ? 'Connected' : 'Error'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${providers?.waqi?.ok ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-sm font-medium">WAQI</span>
                </div>
                <Badge variant={providers?.waqi?.ok ? 'default' : 'destructive'} className="text-xs rounded-sm">
                  {providers?.waqi?.ok ? 'Connected' : 'Error'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${providers?.owm?.ok ? 'bg-green-500' : 'bg-yellow-500'}`} />
                  <span className="text-sm font-medium">OpenWeatherMap</span>
                </div>
                <Badge variant={providers?.owm?.ok ? 'default' : 'secondary'} className="text-xs rounded-sm">
                  {providers?.owm?.ok ? 'Connected' : 'Pending'}
                </Badge>
              </div>
              {/* Core integrations */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${connectionStatus?.connected ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-sm font-medium">BSV Network</span>
                </div>
                <Badge variant={connectionStatus?.connected ? 'default' : 'destructive'} className="text-xs rounded-sm">
                  {connectionStatus?.connected ? 'Connected' : 'Disconnected'}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
