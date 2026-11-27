"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminRefresh } from "@/components/admin-refresh"
import { PanelEmpty, PanelError, StaleReadingNotice } from "@/components/panels/panel-states"
import { fetchFamilySample, toNumber, toText, type FamilySample } from "@/lib/admin-db-stats"
import {
  MISSING,
  ageMs,
  formatMetric,
  formatNumber,
  formatReadingTime,
  formatTimeAgo,
  kphToMph,
  toPercent,
} from "@/lib/admin-format"
import { describeRangePosition, getAqiCategory, getWindCategory, rangePosition } from "@/lib/admin-metrics"
import { cn } from "@/lib/utils"
import { Activity, Droplets, Gauge, MapPin, RefreshCw, Thermometer, TrendingUp, Wind } from "lucide-react"

interface AirQualityReading {
  collectedAt: string | null
  location: string | null
  stationCode: string | null
  provider: string | null
  aqi: number | null
  pm25: number | null
  pm10: number | null
  no2: number | null
  o3: number | null
  co: number | null
  so2: number | null
  temperatureC: number | null
  humidityPct: number | null
  pressureMb: number | null
  windKph: number | null
  windDeg: number | null
}

function mapRow(row: Record<string, any>): AirQualityReading {
  return {
    collectedAt: toText(row.collected_at ?? row.timestamp),
    location: toText(row.city) ?? toText(row.location),
    stationCode: toText(row.station_code),
    provider: toText(row.provider),
    aqi: toNumber(row.aqi),
    pm25: toNumber(row.pm25),
    pm10: toNumber(row.pm10),
    no2: toNumber(row.no2),
    o3: toNumber(row.o3),
    co: toNumber(row.co),
    so2: toNumber(row.so2),
    temperatureC: toNumber(row.temperature_c),
    humidityPct: toNumber(row.humidity_pct),
    pressureMb: toNumber(row.pressure_mb),
    windKph: toNumber(row.wind_kph),
    windDeg: toNumber(row.wind_deg),
  }
}

const POLLUTANTS = [
  {
    key: "pm25",
    label: "PM2.5",
    description: "Fine particulate matter",
    // WHO 24-hour guideline for PM2.5 is 15 µg/m³.
    whoGuideline: 15,
    unit: "µg/m³",
  },
  {
    key: "pm10",
    label: "PM10",
    description: "Coarse particulate matter",
    whoGuideline: 45,
    unit: "µg/m³",
  },
  {
    key: "no2",
    label: "NO₂",
    description: "Nitrogen dioxide",
    whoGuideline: 25,
    unit: "µg/m³",
  },
  {
    key: "o3",
    label: "O₃",
    description: "Ozone",
    whoGuideline: 100,
    unit: "µg/m³",
  },
  {
    key: "co",
    label: "CO",
    description: "Carbon monoxide",
    whoGuideline: 4,
    unit: "mg/m³",
  },
  {
    key: "so2",
    label: "SO₂",
    description: "Sulfur dioxide",
    whoGuideline: 40,
    unit: "µg/m³",
  },
] as const

export function AirQualityPanel() {
  const { tick } = useAdminRefresh()
  const [reading, setReading] = useState<AirQualityReading | null>(null)
  const [sample, setSample] = useState<FamilySample | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await fetchFamilySample({
        endpoint: "/api/db/air-quality",
        valueOf: (row) => toNumber(row.aqi),
        isAlert: (row) => (toNumber(row.aqi) ?? 0) > 100 || (toNumber(row.pm25) ?? 0) > 35.4,
        // One city at a time: AQI readings from different places describe
        // different air, so averaging them says nothing useful. The endpoint's
        // search only covers city, provider and txid, so city is the key.
        narrowTo: (row) => toText(row.city),
      })
      setSample(next)
      setReading(next.latest ? mapRow(next.latest) : null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load air quality data")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [load, tick])

  const handleRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const aggregates = sample?.aggregates ?? null
  const aqiCategory = getAqiCategory(reading?.aqi ?? null)
  const windMph = kphToMph(reading?.windKph ?? null)
  const windCategory = getWindCategory(windMph)
  const position = rangePosition(reading?.aqi ?? null, aggregates?.min ?? null, aggregates?.max ?? null)
  const rangeLabel = describeRangePosition(reading?.aqi ?? null, aggregates?.average ?? null)

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 font-display text-3xl font-bold">
          <Wind className="h-8 w-8" aria-hidden />
          Air quality monitor
        </h1>
        <p className="mt-1 text-muted-foreground">
          Latest air quality reading recorded by the collectors.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Reading time: {formatReadingTime(reading?.collectedAt)} · Fetched:{" "}
          {sample ? formatTimeAgo(sample.fetchedAt) : MISSING}
        </p>
      </div>
      <Button onClick={handleRefresh} disabled={refreshing || loading}>
        <RefreshCw className={cn("mr-2 h-4 w-4", refreshing && "animate-spin")} aria-hidden />
        Refresh
      </Button>
    </div>
  )

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        {header}
        <p className="text-sm text-muted-foreground">Loading the latest readings…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6 p-6">
        {header}
        <PanelError
          title="Air quality data could not be loaded"
          message={error}
          onRetry={handleRefresh}
          retrying={refreshing}
        />
      </div>
    )
  }

  if (!reading) {
    return (
      <div className="space-y-6 p-6">
        {header}
        <PanelEmpty
          title="No air quality readings yet"
          message="The collector workers have not stored an air quality reading. Check that the WAQI or OpenWeatherMap credentials are configured and that the workers are running."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      {header}

      <StaleReadingNotice collectedAt={reading.collectedAt} ageMs={ageMs(reading.collectedAt)} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Current AQI</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatNumber(reading.aqi)}</p>
            <Badge className={cn("mt-1 rounded-sm", aqiCategory.className)}>{aqiCategory.label}</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">PM2.5</CardTitle>
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(reading.pm25, "µg/m³", 1)}</p>
            <p className="text-xs text-muted-foreground">Fine particulate matter</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Temperature</CardTitle>
            <Thermometer className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(reading.temperatureC, "°C", 1)}</p>
            <p className="text-xs text-muted-foreground">Ambient temperature</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Humidity</CardTitle>
            <Droplets className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(reading.humidityPct, "%", 0)}</p>
            <p className="text-xs text-muted-foreground">Relative humidity</p>
          </CardContent>
        </Card>
      </div>

      <div className="pt-2 text-[10px] text-muted-foreground">
        Readings are collected from the World Air Quality Index Project (WAQI), WeatherAPI and
        OpenWeatherMap. Attribution is required by those providers; see{" "}
        <a href="https://waqi.info/" target="_blank" rel="noopener noreferrer" className="underline">
          waqi.info
        </a>
        {" and "}
        <a
          href="https://www.weatherapi.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          weatherapi.com
        </a>
        .
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex w-full flex-wrap gap-1 overflow-x-auto sm:w-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="pollutants">Pollutants</TabsTrigger>
          <TabsTrigger value="weather">Weather</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" aria-hidden />
                  Monitoring station
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <p className="mb-2 text-3xl font-bold">
                    {reading.location ?? reading.stationCode ?? "Unknown station"}
                  </p>
                  <Badge variant="outline">{reading.provider ?? "Unknown provider"}</Badge>
                </div>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">AQI category</dt>
                    <dd>
                      <Badge className={cn("rounded-sm", aqiCategory.className)}>{aqiCategory.label}</Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Wind speed</dt>
                    <dd className="font-semibold">{formatMetric(windMph, "mph", 1)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Pressure</dt>
                    <dd className="font-semibold">{formatMetric(reading.pressureMb, "hPa", 0)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Reading time</dt>
                    <dd className="font-semibold">{formatReadingTime(reading.collectedAt)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" aria-hidden />
                  AQI over the last 24 hours
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {aggregates && aggregates.totalReadings > 0 ? (
                  <>
                    <dl className="space-y-3">
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Current</dt>
                        <dd className="font-semibold">{formatNumber(reading.aqi)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Average</dt>
                        <dd className="font-semibold">{formatNumber(aggregates.average, 1)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Maximum</dt>
                        <dd className="font-semibold text-red-600">{formatNumber(aggregates.max, 1)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Minimum</dt>
                        <dd className="font-semibold text-green-600">{formatNumber(aggregates.min, 1)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Readings</dt>
                        <dd className="font-semibold">{formatNumber(aggregates.totalReadings)}</dd>
                      </div>
                    </dl>
                    <div className="space-y-1">
                      <Progress
                        value={position ?? 0}
                        className="h-2"
                        aria-label="Current AQI within the 24-hour range"
                      />
                      <p className="text-xs text-muted-foreground">
                        {rangeLabel.label}
                        {sample?.groupKey ? ` at ${sample.groupKey}` : ""}
                        {aggregates.sampleTruncated ? " · based on the 500 most recent readings" : ""}
                      </p>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No readings in the last 24 hours, so no range can be calculated.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="pollutants" className="space-y-4">
          <p className="text-xs text-muted-foreground">
            The upstream providers publish pollutant readings, while AQI and its component
            sub-indices are calculated from them. Values are shown exactly as stored. WHO
            guideline values are the 24-hour air quality guideline levels.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {POLLUTANTS.map((pollutant) => {
              const value = reading[pollutant.key]
              const ratio = value != null ? toPercent(value, pollutant.whoGuideline * 5) : 0
              return (
                <Card key={pollutant.key}>
                  <CardHeader>
                    <CardTitle className="text-sm">
                      {pollutant.label} — {pollutant.description}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="mb-2 text-2xl font-bold">
                      {formatMetric(value, pollutant.unit, 1)}
                    </p>
                    <Progress
                      value={ratio}
                      className="mb-2 h-2"
                      aria-label={`${pollutant.label} relative to five times the WHO guideline`}
                    />
                    <p className="text-xs text-muted-foreground">
                      WHO guideline: {formatMetric(pollutant.whoGuideline, pollutant.unit, 1)}
                    </p>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="weather" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Thermometer className="h-5 w-5" aria-hidden />
                  Environmental conditions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center">
                    <p className="text-3xl font-bold text-blue-600">
                      {formatMetric(reading.temperatureC, "°C", 1)}
                    </p>
                    <p className="text-sm text-muted-foreground">Temperature</p>
                  </div>
                  <div className="text-center">
                    <p className="text-3xl font-bold text-cyan-600">
                      {formatMetric(reading.humidityPct, "%", 0)}
                    </p>
                    <p className="text-sm text-muted-foreground">Humidity</p>
                  </div>
                  <div className="text-center">
                    <p className="text-3xl font-bold text-gray-600">
                      {formatMetric(reading.pressureMb, "hPa", 0)}
                    </p>
                    <p className="text-sm text-muted-foreground">Pressure</p>
                  </div>
                  <div className="text-center">
                    <p className="text-3xl font-bold text-green-600">
                      {formatMetric(windMph, "mph", 1)}
                    </p>
                    <p className="text-sm text-muted-foreground">Wind speed</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wind className="h-5 w-5" aria-hidden />
                  Wind
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <p className="mb-2 text-4xl font-bold">{formatMetric(reading.windDeg, "°", 0)}</p>
                  <p className="text-sm text-muted-foreground">Wind direction</p>
                </div>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Wind speed</dt>
                    <dd className="font-semibold">{formatMetric(windMph, "mph", 1)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Wind category</dt>
                    <dd>
                      <Badge variant="outline">{windCategory.label}</Badge>
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Air quality statistics</CardTitle>
                <CardDescription>Last 24 hours of monitoring</CardDescription>
              </CardHeader>
              <CardContent>
                {aggregates && aggregates.totalReadings > 0 ? (
                  <dl className="space-y-4">
                    <div className="flex items-center justify-between">
                      <dt>Total readings</dt>
                      <dd className="font-semibold">{formatNumber(aggregates.totalReadings)}</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt>Readings above the alert threshold</dt>
                      <dd className="font-semibold text-red-600">{formatNumber(aggregates.alerts)}</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt>Data source</dt>
                      <dd>
                        <Badge variant="outline">{reading.provider ?? "Unknown"}</Badge>
                      </dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt>Sample</dt>
                      <dd className="text-sm text-muted-foreground">
                        {aggregates.sampleTruncated
                          ? "500 most recent readings"
                          : "All readings in the window"}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">No readings in the last 24 hours.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Health guidance</CardTitle>
                <CardDescription>Based on the current AQI of {formatNumber(reading.aqi)}</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="space-y-4">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Outdoor activity</dt>
                    <dd>
                      <Badge
                        variant={(reading.aqi ?? 0) > 100 ? "destructive" : "default"}
                        className={(reading.aqi ?? 0) > 100 ? "" : "bg-green-600"}
                      >
                        {(reading.aqi ?? 0) > 100 ? "Limit" : "Safe"}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Sensitive groups</dt>
                    <dd>
                      <Badge
                        variant={(reading.aqi ?? 0) > 150 ? "destructive" : "secondary"}
                      >
                        {(reading.aqi ?? 0) > 150 ? "High risk" : "Moderate"}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Air purification</dt>
                    <dd>
                      <Badge variant={(reading.aqi ?? 0) > 200 ? "destructive" : "outline"}>
                        {(reading.aqi ?? 0) > 200 ? "Recommended" : "Optional"}
                      </Badge>
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
