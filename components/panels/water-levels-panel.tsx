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
import { describeRangePosition, rangePosition } from "@/lib/admin-metrics"
import { cn } from "@/lib/utils"
import { Droplets, Gauge, MapPin, RefreshCw, Thermometer, TrendingUp, Waves } from "lucide-react"

interface WaterLevelReading {
  collectedAt: string | null
  location: string | null
  stationCode: string | null
  provider: string | null
  levelM: number | null
  tideHeightM: number | null
  waveHeightM: number | null
  salinityPsu: number | null
  dissolvedOxygenMgL: number | null
  turbidityNtu: number | null
  currentSpeedMs: number | null
  currentDirectionDeg: number | null
  windKph: number | null
  windDeg: number | null
}

function mapRow(row: Record<string, any>): WaterLevelReading {
  return {
    collectedAt: toText(row.collected_at ?? row.timestamp),
    location: toText(row.location),
    stationCode: toText(row.station_code),
    provider: toText(row.provider),
    levelM: toNumber(row.level_m),
    tideHeightM: toNumber(row.tide_height_m),
    waveHeightM: toNumber(row.wave_height_m),
    salinityPsu: toNumber(row.salinity_psu),
    dissolvedOxygenMgL: toNumber(row.dissolved_oxygen_mg_l),
    turbidityNtu: toNumber(row.turbidity_ntu),
    currentSpeedMs: toNumber(row.current_speed_ms),
    currentDirectionDeg: toNumber(row.current_direction_deg),
    windKph: toNumber(row.wind_kph),
    windDeg: toNumber(row.wind_deg),
  }
}

export function WaterLevelsPanel() {
  const { tick } = useAdminRefresh()
  const [reading, setReading] = useState<WaterLevelReading | null>(null)
  const [sample, setSample] = useState<FamilySample | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await fetchFamilySample({
        endpoint: "/api/db/water-levels",
        valueOf: (row) => toNumber(row.level_m),
        // Each tide gauge has its own datum, so levels are only comparable
        // within a single station.
        narrowTo: (row) => toText(row.station_code),
      })
      setSample(next)
      setReading(next.latest ? mapRow(next.latest) : null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load water level data")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 60_000)
    return () => clearInterval(id)
  }, [load, tick])

  const handleRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const aggregates = sample?.aggregates ?? null
  const position = rangePosition(reading?.levelM ?? null, aggregates?.min ?? null, aggregates?.max ?? null)
  const rangeLabel = describeRangePosition(reading?.levelM ?? null, aggregates?.average ?? null)
  const windMph = kphToMph(reading?.windKph ?? null)

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 font-display text-3xl font-bold">
          <Droplets className="h-8 w-8" aria-hidden />
          Water levels monitor
        </h1>
        <p className="mt-1 text-muted-foreground">
          Latest water level and oceanographic reading recorded by the collectors.
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
          title="Water level data could not be loaded"
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
          title="No water level readings yet"
          message="The collector workers have not stored a water level reading. Check that the NOAA station identifiers are configured and that the workers are running."
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
            <CardTitle className="text-sm font-medium">Water level</CardTitle>
            <Waves className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(reading.levelM, "m", 2)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{rangeLabel.label}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tide height</CardTitle>
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(reading.tideHeightM, "m", 2)}</p>
            <p className="text-xs text-muted-foreground">Above the station datum</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Wave height</CardTitle>
            <Droplets className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(reading.waveHeightM, "m", 2)}</p>
            <p className="text-xs text-muted-foreground">Significant wave height</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Water temperature</CardTitle>
            <Thermometer className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            {/* The NOAA tide-gauge feed does not publish a water temperature, so
                this is shown as unavailable rather than as a fake zero. */}
            <p className="text-2xl font-bold">{MISSING}</p>
            <p className="text-xs text-muted-foreground">Not published by this feed</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex w-full flex-wrap gap-1 overflow-x-auto sm:w-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="water-quality">Water quality</TabsTrigger>
          <TabsTrigger value="currents">Currents and tides</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" aria-hidden />
                  Station
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
                    <dt className="text-sm text-muted-foreground">Station code</dt>
                    <dd className="font-mono text-sm">{reading.stationCode ?? MISSING}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Current speed</dt>
                    <dd className="font-semibold">{formatMetric(reading.currentSpeedMs, "m/s", 2)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Wind speed</dt>
                    <dd className="font-semibold">{formatMetric(windMph, "mph", 1)}</dd>
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
                  Water level over the last 24 hours
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {aggregates && aggregates.totalReadings > 0 ? (
                  <>
                    <dl className="space-y-3">
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Current</dt>
                        <dd className="font-semibold">{formatMetric(reading.levelM, "m", 2)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Average</dt>
                        <dd className="font-semibold">{formatNumber(aggregates.average, 2)} m</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Maximum</dt>
                        <dd className="font-semibold text-red-600">{formatNumber(aggregates.max, 2)} m</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Minimum</dt>
                        <dd className="font-semibold text-blue-600">{formatNumber(aggregates.min, 2)} m</dd>
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
                        aria-label="Current level within the 24-hour range"
                      />
                      <p className="text-xs text-muted-foreground">
                        {rangeLabel.label}
                        {sample?.groupKey ? ` at station ${sample.groupKey}` : ""}
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

        <TabsContent value="water-quality" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Salinity</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-2xl font-bold">{formatMetric(reading.salinityPsu, "PSU", 2)}</p>
                <Progress
                  value={toPercent(reading.salinityPsu, 40)}
                  className="mb-2 h-2"
                  aria-label="Salinity relative to 40 PSU"
                />
                <p className="text-xs text-muted-foreground">
                  Practical Salinity Units; open ocean is typically 33–37 PSU.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Dissolved oxygen</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-2xl font-bold">
                  {formatMetric(reading.dissolvedOxygenMgL, "mg/L", 2)}
                </p>
                <Progress
                  value={toPercent(reading.dissolvedOxygenMgL, 12)}
                  className="mb-2 h-2"
                  aria-label="Dissolved oxygen relative to 12 mg/L"
                />
                <p className="text-xs text-muted-foreground">
                  Sustained values below 5 mg/L stress most marine life.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Turbidity</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-2xl font-bold">{formatMetric(reading.turbidityNtu, "NTU", 1)}</p>
                <Progress
                  value={toPercent(reading.turbidityNtu, 50)}
                  className="mb-2 h-2"
                  aria-label="Turbidity relative to 50 NTU"
                />
                <p className="text-xs text-muted-foreground">Nephelometric Turbidity Units.</p>
              </CardContent>
            </Card>
          </div>

          <p className="text-xs text-muted-foreground">
            Salinity, dissolved oxygen and turbidity are only present when the station publishes
            them; a dash means the upstream feed returned no value.
          </p>
        </TabsContent>

        <TabsContent value="currents" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Waves className="h-5 w-5" aria-hidden />
                  Current
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <p className="mb-2 text-4xl font-bold">
                    {formatMetric(reading.currentDirectionDeg, "°", 0)}
                  </p>
                  <p className="text-sm text-muted-foreground">Direction the current flows towards</p>
                </div>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Speed</dt>
                    <dd className="font-semibold">{formatMetric(reading.currentSpeedMs, "m/s", 2)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Wind direction</dt>
                    <dd className="font-semibold">{formatMetric(reading.windDeg, "°", 0)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Droplets className="h-5 w-5" aria-hidden />
                  Tide
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <p className="mb-2 text-4xl font-bold">{formatMetric(reading.tideHeightM, "m", 2)}</p>
                  <p className="text-sm text-muted-foreground">Tide height</p>
                </div>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Position in 24h range</dt>
                    <dd>
                      <Badge variant="outline">{rangeLabel.label}</Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Wave height</dt>
                    <dd className="font-semibold">{formatMetric(reading.waveHeightM, "m", 2)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Water level statistics</CardTitle>
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
                    <dt>Highest level</dt>
                    <dd className="font-semibold">{formatNumber(aggregates.max, 2)} m</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt>Lowest level</dt>
                    <dd className="font-semibold">{formatNumber(aggregates.min, 2)} m</dd>
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
        </TabsContent>
      </Tabs>
    </div>
  )
}
