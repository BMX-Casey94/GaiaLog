"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useAdminRefresh } from "@/components/admin-refresh"
import { useBlockchain } from "@/components/blockchain-provider"
import { StaleReadingNotice } from "@/components/panels/panel-states"
import { isValidTxid, getExplorerUrl } from "@/lib/bsv-links"
import { useEnvironmentalData } from "@/hooks/use-environmental-data"
import { MISSING, ageMs, formatDateTime, formatMetric, formatReadingTime, formatTime, toPercent } from "@/lib/admin-format"
import { getAqiCategory, getMagnitudeCategory } from "@/lib/admin-metrics"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { Activity, AlertCircle, BarChart3, Clock, Droplets, ExternalLink, Wind } from "lucide-react"

type ProviderKey = "weatherapi" | "waqi" | "owm"

interface ProviderState {
  status: "loading" | "ok" | "error"
  message: string | null
}

type ProviderMap = Record<ProviderKey, ProviderState>

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  weatherapi: "WeatherAPI",
  waqi: "WAQI",
  owm: "OpenWeatherMap",
}

const INITIAL_PROVIDERS: ProviderMap = {
  weatherapi: { status: "loading", message: null },
  waqi: { status: "loading", message: null },
  owm: { status: "loading", message: null },
}

export function OverviewPanel() {
  const { airQuality, waterLevels, seismic, advanced, loading, error, lastUpdated, refetch } =
    useEnvironmentalData()
  const { transactions, connectionStatus, loading: blockchainLoading, error: blockchainError } = useBlockchain()
  const { tick } = useAdminRefresh()
  const [providers, setProviders] = useState<ProviderMap>(INITIAL_PROVIDERS)
  const [providersError, setProvidersError] = useState<string | null>(null)

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers/status", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      const results = body?.results ?? {}
      setProviders({
        weatherapi: toProviderState(results.weatherapi),
        waqi: toProviderState(results.waqi),
        owm: toProviderState(results.owm),
      })
      setProvidersError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : "unavailable"
      setProvidersError(`Provider status unavailable (${message})`)
      // Leaving these as "loading" would leave the row spinning forever, so each
      // provider is marked as errored with the reason attached.
      setProviders({
        weatherapi: { status: "error", message },
        waqi: { status: "error", message },
        owm: { status: "error", message },
      })
    }
  }, [])

  useEffect(() => {
    void loadProviders()
  }, [loadProviders, tick])

  const aqiCategory = getAqiCategory(airQuality?.aqi ?? null)
  const latestEvent = seismic?.events?.[0] ?? null
  const magnitudeCategory = getMagnitudeCategory(latestEvent?.magnitude ?? null)

  // Every card is driven by the newest stored reading per family, so the page
  // warns once against the oldest of them rather than four times over.
  const readings = [airQuality?.collectedAt, waterLevels?.collectedAt, seismic?.collectedAt].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  const oldestReading =
    readings.length > 0
      ? readings.reduce((oldest, candidate) =>
          Date.parse(candidate) < Date.parse(oldest) ? candidate : oldest,
        )
      : null

  if (loading && !lastUpdated) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h1 className="mb-2 font-display text-2xl font-bold">Environmental overview</h1>
          <p className="text-muted-foreground">Loading the latest readings recorded by the collectors.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <Card key={key}>
              <CardHeader className="space-y-0 pb-2">
                <Skeleton className="h-4 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="mb-2 h-8 w-16" />
                <Skeleton className="mb-2 h-3 w-32" />
                <Skeleton className="h-5 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-2 font-display text-2xl font-bold">Environmental overview</h1>
          <p className="text-muted-foreground">
            Latest environmental readings, each recorded on the BSV blockchain.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Reads refreshed: {lastUpdated ? formatTime(lastUpdated) : MISSING}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh overview"}
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Some readings could not be loaded</p>
            <p className="text-destructive/90">{error}</p>
          </div>
        </div>
      )}

      {/* The newest stored readings drive every card below, so one stale notice
          covers the whole page rather than repeating it four times. */}
      <StaleReadingNotice
        collectedAt={oldestReading}
        ageMs={oldestReading ? ageMs(oldestReading) : null}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Air quality */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Air quality</CardTitle>
            <Wind className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{aqiCategory.label}</p>
            <p className="text-xs text-muted-foreground">
              AQI {formatMetric(airQuality?.aqi ?? null, "")} · PM2.5{" "}
              {formatMetric(airQuality?.pm25 ?? null, "µg/m³", 1)}
            </p>
            <Badge variant="secondary" className={cn("mt-2 rounded-sm text-xs", aqiCategory.className)}>
              <Clock className="mr-1 h-3 w-3" aria-hidden />
              {airQuality ? formatReadingTime(airQuality.collectedAt) : "No reading"}
            </Badge>
          </CardContent>
        </Card>

        {/* Water levels */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Water level</CardTitle>
            <Droplets className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatMetric(waterLevels?.levelM ?? null, "m", 2)}</p>
            <p className="truncate text-xs text-muted-foreground">
              {waterLevels?.location ?? waterLevels?.stationCode ?? "No station reported"}
            </p>
            <Badge variant="secondary" className="mt-2 rounded-sm text-xs">
              <Clock className="mr-1 h-3 w-3" aria-hidden />
              {waterLevels ? formatReadingTime(waterLevels.collectedAt) : "No reading"}
            </Badge>
          </CardContent>
        </Card>

        {/* Seismic */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Seismic activity</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{magnitudeCategory.label}</p>
            <p className="truncate text-xs text-muted-foreground">
              {latestEvent
                ? `${formatMetric(latestEvent.magnitude, "M", 1)} · ${latestEvent.location ?? "Unknown location"}`
                : "No events reported"}
            </p>
            <Badge variant="secondary" className="mt-2 rounded-sm text-xs">
              <Clock className="mr-1 h-3 w-3" aria-hidden />
              {seismic ? formatReadingTime(seismic.collectedAt) : "No reading"}
            </Badge>
          </CardContent>
        </Card>

        {/* Blockchain */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Blockchain</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {blockchainLoading && connectionStatus === null
                ? "Checking…"
                : connectionStatus?.connected
                  ? "Connected"
                  : "Offline"}
            </p>
            <p className="text-xs text-muted-foreground">
              {transactions.length > 0
                ? `Latest transaction ${formatReadingTime(transactions[0].timestamp)}`
                : blockchainLoading
                  ? "Reading the transaction log…"
                  : "No transactions recorded"}
            </p>
            {transactions.length > 0 && isValidTxid(transactions[0].txid) && (
              <a
                href={getExplorerUrl(transactions[0].txid)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block"
              >
                <Badge variant="secondary" className="cursor-pointer rounded-sm text-xs hover:bg-secondary/80">
                  <ExternalLink className="mr-1 h-3 w-3" aria-hidden />
                  View on WhatsOnChain
                </Badge>
              </a>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-display">Latest on-chain transactions</CardTitle>
            <CardDescription>The most recent broadcast per data family</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {transactions.slice(0, 4).map((tx) => {
                const linkable = isValidTxid(tx.txid)
                const inner = (
                  <>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {tx.dataType.replace(/_/g, " ").toUpperCase()}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(tx.timestamp)}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-xs">{tx.txid.slice(0, 8)}…</p>
                      <Badge variant="secondary" className="rounded-sm text-xs">
                        {tx.status}
                      </Badge>
                    </div>
                  </>
                )
                return linkable ? (
                  <a
                    key={tx.txid}
                    href={getExplorerUrl(tx.txid)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3 transition-colors hover:bg-muted/70"
                  >
                    {inner}
                  </a>
                ) : (
                  <div
                    key={tx.txid}
                    className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3"
                  >
                    {inner}
                  </div>
                )
              })}
              {transactions.length === 0 && (
                <p className="py-4 text-center text-muted-foreground">
                  {blockchainLoading
                    ? "Reading the transaction log…"
                    : (blockchainError ?? "No transactions have been broadcast yet.")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display">System status</CardTitle>
            <CardDescription>Live health of the data sources and the BSV network</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(Object.keys(PROVIDER_LABELS) as ProviderKey[]).map((key) => {
              const state = providers[key]
              return (
                <div key={key} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "h-2 w-2 rounded-full",
                          state.status === "ok"
                            ? "bg-green-500"
                            : state.status === "error"
                              ? "bg-red-500"
                              : "bg-yellow-500",
                        )}
                        aria-hidden
                      />
                      <span className="text-sm font-medium">{PROVIDER_LABELS[key]}</span>
                    </div>
                    <Badge
                      variant={state.status === "ok" ? "default" : state.status === "error" ? "destructive" : "secondary"}
                      className="rounded-sm text-xs"
                    >
                      {state.status === "ok" ? "Connected" : state.status === "error" ? "Error" : "Checking…"}
                    </Badge>
                  </div>
                  {state.status === "error" && state.message && (
                    <p className="pl-5 text-xs text-muted-foreground">{state.message}</p>
                  )}
                </div>
              )
            })}

            <div className="flex items-center justify-between border-t pt-4">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    connectionStatus?.connected ? "bg-green-500" : "bg-red-500",
                  )}
                  aria-hidden
                />
                <span className="text-sm font-medium">BSV network</span>
              </div>
              <Badge
                variant={blockchainLoading && connectionStatus === null ? "secondary" : connectionStatus?.connected ? "default" : "destructive"}
                className="rounded-sm text-xs"
              >
                {blockchainLoading && connectionStatus === null
                  ? "Checking…"
                  : connectionStatus?.connected
                    ? "Connected"
                    : "Disconnected"}
              </Badge>
            </div>
            {!blockchainLoading && !connectionStatus?.connected && connectionStatus?.reason && (
              <p className="pl-5 text-xs text-muted-foreground">{connectionStatus.reason}</p>
            )}

            {providersError && (
              <div className="flex items-start justify-between gap-2 border-t pt-3">
                <p className="text-xs text-muted-foreground">{providersError}</p>
                <Button variant="ghost" size="sm" onClick={() => void loadProviders()}>
                  Retry
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Advanced metrics: only the values the collectors actually record. */}
      <Card>
        <CardHeader>
          <CardTitle className="font-display">Advanced metrics</CardTitle>
          <CardDescription>
            Soil moisture, UV index and the derived environmental score from the latest reading
          </CardDescription>
        </CardHeader>
        <CardContent>
          {advanced ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Soil moisture</p>
                <p className="text-xl font-bold">{formatMetric(advanced.soilMoisturePct, "%", 0)}</p>
                <Progress
                  value={toPercent(advanced.soilMoisturePct, 100)}
                  className="mt-2 h-1.5"
                  aria-label="Soil moisture as a share of saturation"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">UV index</p>
                <p className="text-xl font-bold">{formatMetric(advanced.uvIndex, "", 1)}</p>
                <Progress
                  value={toPercent(advanced.uvIndex, 11)}
                  className="mt-2 h-1.5"
                  aria-label="UV index on the 0-11 scale"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Environmental score</p>
                <p className="text-xl font-bold">{formatMetric(advanced.environmentalScore, "/100", 0)}</p>
                <Progress
                  value={toPercent(advanced.environmentalScore, 100)}
                  className="mt-2 h-1.5"
                  aria-label="Environmental score out of 100"
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No advanced metrics reading has been collected yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function toProviderState(value: unknown): ProviderState {
  if (!value || typeof value !== "object") {
    return { status: "error", message: "No status reported" }
  }
  const record = value as { ok?: boolean; message?: string }
  return {
    status: record.ok ? "ok" : "error",
    message: typeof record.message === "string" && record.message.length > 0 ? record.message : null,
  }
}
