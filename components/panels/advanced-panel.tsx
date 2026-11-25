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
  formatMetric,
  formatNumber,
  formatTimeAgo,
  formatReadingTime,
  ageMs,
  kphToMph,
  toPercent,
} from "@/lib/admin-format"
import {
  describeRangePosition,
  getScoreCategory,
  getWindCategory,
  rangePosition,
} from "@/lib/admin-metrics"
import { cn } from "@/lib/utils"
import { BarChart3, Flame, Globe, Gauge, MapPin, RefreshCw, Sparkles, Sun, Thermometer, TrendingUp, Wind } from "lucide-react"

interface AdvancedReading {
  collectedAt: string | null
  location: string | null
  provider: string | null
  soilMoisturePct: number | null
  uvIndex: number | null
  wildfireRisk: number | null
  environmentalScore: number | null
  temperatureC: number | null
  humidityPct: number | null
  pressureMb: number | null
  windKph: number | null
  windDeg: number | null
  lat: number | null
  lon: number | null
}

/**
 * The stored environmental score is sometimes a 0-1 fraction and sometimes a
 * 0-100 score, depending on which provider wrote the row. Normalise here so the
 * panel and the aggregates always agree.
 */
function normaliseScore(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return value <= 1 ? value * 100 : value
}

function mapRow(row: Record<string, any>): AdvancedReading {
  return {
    collectedAt: toText(row.collected_at ?? row.timestamp),
    location: toText(row.city) ?? toText(row.location),
    provider: toText(row.provider),
    soilMoisturePct: toNumber(row.soil_moisture_pct),
    uvIndex: toNumber(row.uv_index),
    wildfireRisk: toNumber(row.wildfire_risk),
    environmentalScore: normaliseScore(toNumber(row.environmental_score)),
    temperatureC: toNumber(row.temperature_c),
    humidityPct: toNumber(row.humidity_pct),
    pressureMb: toNumber(row.pressure_mb),
    windKph: toNumber(row.wind_kph),
    windDeg: toNumber(row.wind_deg),
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
  }
}

/** WHO UV index bands. */
function uvCategory(uv: number | null) {
  if (uv == null) return { label: "Unknown", className: "bg-gray-500 text-white" }
  if (uv < 3) return { label: "Low", className: "bg-green-600 text-white" }
  if (uv < 6) return { label: "Moderate", className: "bg-yellow-600 text-white" }
  if (uv < 8) return { label: "High", className: "bg-orange-600 text-white" }
  if (uv < 11) return { label: "Very high", className: "bg-red-600 text-white" }
  return { label: "Extreme", className: "bg-purple-700 text-white" }
}

function soilCategory(pct: number | null) {
  if (pct == null) return { label: "Unknown", className: "bg-gray-500 text-white" }
  if (pct < 20) return { label: "Dry", className: "bg-orange-600 text-white" }
  if (pct <= 40) return { label: "Optimal", className: "bg-green-600 text-white" }
  return { label: "Saturated", className: "bg-blue-600 text-white" }
}

export function AdvancedPanel() {
  const { tick } = useAdminRefresh()
  const [reading, setReading] = useState<AdvancedReading | null>(null)
  const [sample, setSample] = useState<FamilySample | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await fetchFamilySample({
        endpoint: "/api/db/advanced",
        valueOf: (row) => normaliseScore(toNumber(row.environmental_score)),
        isAlert: (row) => (normaliseScore(toNumber(row.environmental_score)) ?? 100) < 50,
        // Environmental scores describe one place; averaging several cities
        // would make the 24-hour range meaningless.
        narrowTo: (row) => toText(row.city),
      })
      setSample(next)
      setReading(next.latest ? mapRow(next.latest) : null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load advanced metrics")
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
  const score = reading?.environmentalScore ?? null
  const scoreCategory = getScoreCategory(score)
  const position = rangePosition(score, aggregates?.min ?? null, aggregates?.max ?? null)
  const rangeLabel = describeRangePosition(score, aggregates?.average ?? null)
  const windMph = kphToMph(reading?.windKph ?? null)
  const windCategory = getWindCategory(windMph)
  const uv = uvCategory(reading?.uvIndex ?? null)
  const soil = soilCategory(reading?.soilMoisturePct ?? null)

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 font-display text-3xl font-bold">
          <BarChart3 className="h-8 w-8" aria-hidden />
          Advanced metrics monitor
        </h1>
        <p className="mt-1 text-muted-foreground">
          The latest advanced reading: soil moisture, UV index, wildfire risk and the derived
          environmental score.
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
          title="Advanced metrics could not be loaded"
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
          title="No advanced metrics recorded yet"
          message="The collector workers have not stored an advanced metrics reading. Check that the WeatherAPI or OpenWeatherMap credentials are configured and that the workers are running."
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
            <CardTitle className="text-sm font-medium">Environmental score</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(score, "/100", 0)}</p>
            <Badge className={cn("mt-1 rounded-sm", scoreCategory.className)}>
              {scoreCategory.label}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Soil moisture</CardTitle>
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(reading.soilMoisturePct, "%", 0)}</p>
            <Badge className={cn("mt-1 rounded-sm", soil.className)}>{soil.label}</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">UV index</CardTitle>
            <Sun className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(reading.uvIndex, "", 1)}</p>
            <Badge className={cn("mt-1 rounded-sm", uv.className)}>{uv.label}</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Wildfire risk</CardTitle>
            <Flame className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(reading.wildfireRisk, "/10", 0)}</p>
            <p className="text-xs text-muted-foreground">Stored provider risk level</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex w-full flex-wrap gap-1 overflow-x-auto sm:w-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="environmental">Environmental</TabsTrigger>
          <TabsTrigger value="climate">Climate</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" aria-hidden />
                  Monitoring location
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <p className="mb-2 text-3xl font-bold">{reading.location ?? "Unknown location"}</p>
                  <Badge variant="outline">{reading.provider ?? "Unknown provider"}</Badge>
                </div>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Latitude</dt>
                    <dd className="font-semibold">
                      {reading.lat != null ? `${reading.lat.toFixed(4)}°` : MISSING}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Longitude</dt>
                    <dd className="font-semibold">
                      {reading.lon != null ? `${reading.lon.toFixed(4)}°` : MISSING}
                    </dd>
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
                  Environmental score over the last 24 hours
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {aggregates && aggregates.totalReadings > 0 ? (
                  <>
                    <dl className="space-y-3">
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Current</dt>
                        <dd className="font-semibold">{formatMetric(score, "/100", 0)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Average</dt>
                        <dd className="font-semibold">{formatNumber(aggregates.average, 1)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Maximum</dt>
                        <dd className="font-semibold text-green-600">{formatNumber(aggregates.max, 1)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Minimum</dt>
                        <dd className="font-semibold text-red-600">{formatNumber(aggregates.min, 1)}</dd>
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
                        aria-label="Current score within the 24-hour range"
                      />
                      <p className="text-xs text-muted-foreground">
                        {rangeLabel.label}
                        {sample?.groupKey ? ` in ${sample.groupKey}` : ""}
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

        <TabsContent value="environmental" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Soil moisture</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-2xl font-bold">
                  {formatMetric(reading.soilMoisturePct, "%", 0)}
                </p>
                <Progress
                  value={toPercent(reading.soilMoisturePct, 100)}
                  className="mb-2 h-2"
                  aria-label="Soil moisture as a share of saturation"
                />
                <p className="text-xs text-muted-foreground">
                  {soil.label} · optimal range is 20–40% volumetric water content.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">UV index</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-2xl font-bold">{formatMetric(reading.uvIndex, "", 1)}</p>
                <Progress
                  value={toPercent(reading.uvIndex, 11)}
                  className="mb-2 h-2"
                  aria-label="UV index on the 0-11 scale"
                />
                <p className="text-xs text-muted-foreground">
                  {uv.label} · WHO scale runs from 0 to 11 and above.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Wildfire risk</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-2xl font-bold">
                  {formatMetric(reading.wildfireRisk, "/10", 0)}
                </p>
                <Progress
                  value={toPercent(reading.wildfireRisk, 10)}
                  className="mb-2 h-2"
                  aria-label="Wildfire risk out of 10"
                />
                <p className="text-xs text-muted-foreground">
                  As published by the upstream provider; the scale is provider-specific.
                </p>
              </CardContent>
            </Card>

            <Card className="md:col-span-2 lg:col-span-3">
              <CardHeader>
                <CardTitle className="text-sm">Environmental score</CardTitle>
                <CardDescription>
                  Stored score for this reading, normalised to a 0–100 scale
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-2xl font-bold">{formatMetric(score, "/100", 0)}</p>
                <Progress
                  value={toPercent(score, 100)}
                  className="mb-2 h-2"
                  aria-label="Environmental score out of 100"
                />
                <Badge className={cn("rounded-sm", scoreCategory.className)}>
                  {scoreCategory.label}
                </Badge>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="climate" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Thermometer className="h-5 w-5" aria-hidden />
                  Climate conditions
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

          <p className="text-xs text-muted-foreground">
            Radiation, noise, ambient light and magnetic-field sensors are not deployed, so this
            dashboard does not report them.
          </p>
        </TabsContent>

        <TabsContent value="analytics" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Advanced metrics statistics</CardTitle>
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
                      <dt>Readings below a score of 50</dt>
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
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5" aria-hidden />
                  Reading summary
                </CardTitle>
                <CardDescription>Every value stored for the latest reading</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Environmental score</dt>
                    <dd className="font-semibold">{formatMetric(score, "/100", 0)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Soil moisture</dt>
                    <dd className="font-semibold">{formatMetric(reading.soilMoisturePct, "%", 0)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">UV index</dt>
                    <dd className="font-semibold">{formatMetric(reading.uvIndex, "", 1)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Wildfire risk</dt>
                    <dd className="font-semibold">{formatMetric(reading.wildfireRisk, "/10", 0)}</dd>
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
