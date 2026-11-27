"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminRefresh } from "@/components/admin-refresh"
import { PanelEmpty, PanelError, StaleReadingNotice } from "@/components/panels/panel-states"
import {
  bucketValues,
  fetchFamilySample,
  toNumber,
  toText,
  type FamilySample,
} from "@/lib/admin-db-stats"
import {
  MISSING,
  ageMs,
  formatDateTime,
  formatMetric,
  formatNumber,
  formatReadingTime,
  formatTimeAgo,
  metresToMiles,
} from "@/lib/admin-format"
import { describeRangePosition, getMagnitudeCategory, rangePosition } from "@/lib/admin-metrics"
import { cn } from "@/lib/utils"
import { Activity, AlertTriangle, Gauge, MapPin, RefreshCw, TrendingUp, Zap } from "lucide-react"

interface SeismicEvent {
  collectedAt: string | null
  eventId: string | null
  location: string | null
  provider: string | null
  magnitude: number | null
  depthKm: number | null
  lat: number | null
  lon: number | null
}

function mapRow(row: Record<string, any>): SeismicEvent {
  return {
    collectedAt: toText(row.collected_at ?? row.timestamp),
    eventId: toText(row.event_id),
    location: toText(row.location),
    provider: toText(row.provider),
    magnitude: toNumber(row.magnitude),
    depthKm: toNumber(row.depth_km),
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
  }
}

const MAGNITUDE_BUCKETS = [
  { label: "Micro (< 2.0)", lower: -Infinity, upper: 2 },
  { label: "Minor (2.0–2.9)", lower: 2, upper: 3 },
  { label: "Light (3.0–3.9)", lower: 3, upper: 4 },
  { label: "Moderate (4.0–4.9)", lower: 4, upper: 5 },
  { label: "Strong and above (≥ 5.0)", lower: 5, upper: Infinity },
]

/** Energy released by an earthquake, in joules (Gutenberg-Richter relation). */
function energyJoules(magnitude: number | null): number | null {
  if (magnitude == null || !Number.isFinite(magnitude)) return null
  return Math.pow(10, 1.5 * magnitude + 4.8)
}

function formatJoules(joules: number | null): string {
  if (joules == null || !Number.isFinite(joules)) return MISSING
  const units = [
    { limit: 1e3, suffix: "J" },
    { limit: 1e6, suffix: "kJ" },
    { limit: 1e9, suffix: "MJ" },
    { limit: 1e12, suffix: "GJ" },
    { limit: 1e15, suffix: "TJ" },
    { limit: 1e18, suffix: "PJ" },
  ]
  for (const unit of units) {
    if (joules < unit.limit) return `${(joules / (unit.limit / 1000)).toFixed(1)} ${unit.suffix}`
  }
  return `${(joules / 1e18).toFixed(1)} EJ`
}

function depthCategory(depthKm: number | null) {
  if (depthKm == null) return "Unknown"
  if (depthKm < 70) return "Shallow"
  if (depthKm < 300) return "Intermediate"
  return "Deep"
}

export function SeismicPanel() {
  const { tick } = useAdminRefresh()
  const [event, setEvent] = useState<SeismicEvent | null>(null)
  const [sample, setSample] = useState<FamilySample | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await fetchFamilySample({
        endpoint: "/api/db/seismic",
        valueOf: (row) => toNumber(row.magnitude),
        isAlert: (row) => (toNumber(row.magnitude) ?? 0) >= 5,
      })
      setSample(next)
      setEvent(next.latest ? mapRow(next.latest) : null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load seismic data")
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
  const magnitudeCategory = getMagnitudeCategory(event?.magnitude ?? null)
  const position = rangePosition(event?.magnitude ?? null, aggregates?.min ?? null, aggregates?.max ?? null)
  const rangeLabel = describeRangePosition(event?.magnitude ?? null, aggregates?.average ?? null)
  const distribution = aggregates ? bucketValues(aggregates.values, MAGNITUDE_BUCKETS) : []
  const strongest = aggregates?.max ?? null

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 font-display text-3xl font-bold">
          <Activity className="h-8 w-8" aria-hidden />
          Seismic activity monitor
        </h1>
        <p className="mt-1 text-muted-foreground">
          Latest earthquake recorded by the collectors from the USGS event feed.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Event recorded: {formatDateTime(event?.collectedAt)} · Fetched:{" "}
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
        <p className="text-sm text-muted-foreground">Loading the latest events…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6 p-6">
        {header}
        <PanelError
          title="Seismic data could not be loaded"
          message={error}
          onRetry={handleRefresh}
          retrying={refreshing}
        />
      </div>
    )
  }

  if (!event) {
    return (
      <div className="space-y-6 p-6">
        {header}
        <PanelEmpty
          title="No seismic events recorded yet"
          message="The collector workers have not stored a seismic event. Check that the USGS feed is reachable and that the workers are running."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      {header}

      <StaleReadingNotice collectedAt={event.collectedAt} ageMs={ageMs(event.collectedAt)} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Magnitude</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(event.magnitude, "M", 1)}</p>
            <Badge className={cn("mt-1 rounded-sm", magnitudeCategory.className)}>
              {magnitudeCategory.label}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Depth</CardTitle>
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(event.depthKm, "km", 1)}</p>
            <p className="text-xs text-muted-foreground">{depthCategory(event.depthKm)} epicentre</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Energy released</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatJoules(energyJoules(event.magnitude))}</p>
            <p className="text-xs text-muted-foreground">From the Gutenberg-Richter relation</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Distance from you</CardTitle>
            <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            {/* Distance needs the operator's own position, which this dashboard
                does not collect, so it is not invented. */}
            <p className="text-2xl font-bold">{MISSING}</p>
            <p className="text-xs text-muted-foreground">Requires a monitoring position</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex w-full flex-wrap gap-1 overflow-x-auto sm:w-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="location">Location</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" aria-hidden />
                  Event
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <p className="mb-2 text-3xl font-bold">{event.location ?? "Unknown location"}</p>
                  <Badge variant="outline">{event.provider ?? "Unknown provider"}</Badge>
                </div>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Magnitude category</dt>
                    <dd>
                      <Badge className={cn("rounded-sm", magnitudeCategory.className)}>
                        {magnitudeCategory.label}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Event identifier</dt>
                    <dd className="font-mono text-xs">{event.eventId ?? MISSING}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Recorded</dt>
                    <dd className="font-semibold">{formatDateTime(event.collectedAt)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" aria-hidden />
                  Magnitude over the last 24 hours
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {aggregates && aggregates.totalReadings > 0 ? (
                  <>
                    <dl className="space-y-3">
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Latest</dt>
                        <dd className="font-semibold">{formatMetric(event.magnitude, "M", 1)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Average</dt>
                        <dd className="font-semibold">{formatNumber(aggregates.average, 2)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Strongest</dt>
                        <dd className="font-semibold text-red-600">{formatNumber(aggregates.max, 2)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Weakest</dt>
                        <dd className="font-semibold text-green-600">{formatNumber(aggregates.min, 2)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-sm">Events</dt>
                        <dd className="font-semibold">{formatNumber(aggregates.totalReadings)}</dd>
                      </div>
                    </dl>
                    <div className="space-y-1">
                      <Progress
                        value={position ?? 0}
                        className="h-2"
                        aria-label="Latest magnitude within the 24-hour range"
                      />
                      <p className="text-xs text-muted-foreground">
                        {rangeLabel.label}
                        {aggregates.sampleTruncated ? " · based on the 500 most recent events" : ""}
                      </p>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No events in the last 24 hours, so no range can be calculated.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="location" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" aria-hidden />
                  Coordinates
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center">
                    <p className="text-2xl font-bold text-blue-600">
                      {event.lat != null ? `${event.lat.toFixed(4)}°` : MISSING}
                    </p>
                    <p className="text-sm text-muted-foreground">Latitude</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-green-600">
                      {event.lon != null ? `${event.lon.toFixed(4)}°` : MISSING}
                    </p>
                    <p className="text-sm text-muted-foreground">Longitude</p>
                  </div>
                </div>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Depth</dt>
                    <dd className="font-semibold">{formatMetric(event.depthKm, "km", 1)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Depth class</dt>
                    <dd>
                      <Badge variant="outline">{depthCategory(event.depthKm)}</Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Depth in miles</dt>
                    <dd className="font-semibold">
                      {formatMetric(metresToMiles((event.depthKm ?? 0) * 1000), "miles", 1)}
                    </dd>
                  </div>
                </dl>
                {event.lat != null && event.lon != null && (
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${event.lat}&mlon=${event.lon}#map=6/${event.lat}/${event.lon}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm underline"
                  >
                    Open the epicentre in OpenStreetMap
                  </a>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5" aria-hidden />
                  Event detail
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Magnitude</dt>
                    <dd className="font-semibold">{formatMetric(event.magnitude, "M", 1)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Energy released</dt>
                    <dd className="font-semibold">{formatJoules(energyJoules(event.magnitude))}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Source</dt>
                    <dd className="font-semibold">{event.provider ?? MISSING}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm text-muted-foreground">Recorded</dt>
                    <dd className="font-semibold">{formatReadingTime(event.collectedAt)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="alerts" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5" aria-hidden />
                  Current alert status
                </CardTitle>
                <CardDescription>
                  Derived from the stored magnitude against the 5.0 alert threshold
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Latest event</dt>
                    <dd>
                      <Badge
                        variant={(event.magnitude ?? 0) >= 5 ? "destructive" : "default"}
                        className={(event.magnitude ?? 0) >= 5 ? "" : "bg-green-600"}
                      >
                        {(event.magnitude ?? 0) >= 5 ? "Above threshold" : "Below threshold"}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Events at or above 5.0 in the last 24 hours</dt>
                    <dd className="font-semibold">{formatNumber(aggregates?.alerts ?? 0)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Strongest in the last 24 hours</dt>
                    <dd className="font-semibold">{formatMetric(strongest, "M", 2)}</dd>
                  </div>
                </dl>
                <p className="mt-4 text-xs text-muted-foreground">
                  Tsunami warnings are issued by national authorities, not derived from magnitude
                  alone, so this dashboard does not claim one.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Magnitude guidance</CardTitle>
                <CardDescription>
                  General guidance for a magnitude {formatNumber(event.magnitude, 1)} event
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="space-y-4">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Structural inspection</dt>
                    <dd>
                      <Badge variant={(event.magnitude ?? 0) >= 5 ? "destructive" : "secondary"}>
                        {(event.magnitude ?? 0) >= 5 ? "Recommended nearby" : "Not required"}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Felt at the epicentre</dt>
                    <dd>
                      <Badge variant="outline">
                        {(event.magnitude ?? 0) >= 3 ? "Likely" : "Unlikely"}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Local authority liaison</dt>
                    <dd>
                      <Badge variant={(event.magnitude ?? 0) >= 6 ? "default" : "outline"}>
                        {(event.magnitude ?? 0) >= 6 ? "Advised" : "Not required"}
                      </Badge>
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
                <CardTitle>Seismic statistics</CardTitle>
                <CardDescription>Last 24 hours of monitoring</CardDescription>
              </CardHeader>
              <CardContent>
                {aggregates && aggregates.totalReadings > 0 ? (
                  <dl className="space-y-4">
                    <div className="flex items-center justify-between">
                      <dt>Total events</dt>
                      <dd className="font-semibold">{formatNumber(aggregates.totalReadings)}</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt>Events at or above 5.0</dt>
                      <dd className="font-semibold text-red-600">{formatNumber(aggregates.alerts)}</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt>Data source</dt>
                      <dd>
                        <Badge variant="outline">{event.provider ?? "Unknown"}</Badge>
                      </dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt>Sample</dt>
                      <dd className="text-sm text-muted-foreground">
                        {aggregates.sampleTruncated
                          ? "500 most recent events"
                          : "All events in the window"}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">No events in the last 24 hours.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Magnitude distribution</CardTitle>
                <CardDescription>
                  Share of the {formatNumber(aggregates?.values.length ?? 0)} sampled events in each
                  band
                </CardDescription>
              </CardHeader>
              <CardContent>
                {distribution.some((bucket) => bucket.count > 0) ? (
                  <dl className="space-y-3">
                    {distribution.map((bucket) => (
                      <div key={bucket.label} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <dt>{bucket.label}</dt>
                          <dd className="font-semibold">
                            {formatNumber(bucket.count)} ({formatNumber(bucket.share, 1)}%)
                          </dd>
                        </div>
                        <Progress
                          value={bucket.share}
                          className="h-1.5"
                          aria-label={`${bucket.label} share of sampled events`}
                        />
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No magnitudes have been recorded in the last 24 hours.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
