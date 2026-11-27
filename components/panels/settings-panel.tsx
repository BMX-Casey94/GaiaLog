"use client"

import { useCallback, useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PanelError } from "@/components/panels/panel-states"
import { useHasMounted } from "@/hooks/use-has-mounted"
import { MISSING, formatNumber } from "@/lib/admin-format"
import { Database, Key, Monitor, RefreshCw, Shield } from "lucide-react"

interface ProviderControl {
  id: string
  displayName: string
  primaryFamily: string
  enabled: boolean
  configuredEnabled: boolean
  rolloutEnabled: boolean
  lane: string
  intervalMs: number
  chunkSize: number
  maxInFlight: number
  attributionRequired?: boolean
  attributionText?: string | null
}

interface ProviderControlsResponse {
  providers: ProviderControl[]
  datasets: unknown[]
}

interface ProviderProbe {
  ok: boolean
  message: string
}

interface ProviderStatusResponse {
  results?: Record<string, ProviderProbe>
  controls?: ProviderControlsResponse
}

/** "10 minutes" from a millisecond cadence, with correct singular/plural. */
function formatCadence(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return MISSING
  const plural = (value: string, unit: string) => `${value} ${unit}${value === "1" ? "" : "s"}`

  const minutes = intervalMs / 60_000
  if (minutes < 1) {
    const seconds = intervalMs / 1000
    return plural(formatNumber(seconds, seconds % 1 === 0 ? 0 : 1), "second")
  }
  if (minutes < 60) {
    return plural(formatNumber(minutes, minutes % 1 === 0 ? 0 : 1), "minute")
  }
  const hours = minutes / 60
  return plural(formatNumber(hours, hours % 1 === 0 ? 0 : 1), "hour")
}

export function SettingsPanel() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const mounted = useHasMounted()
  const [controls, setControls] = useState<ProviderControlsResponse | null>(null)
  const [probes, setProbes] = useState<Record<string, ProviderProbe> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/providers/status", { cache: "no-store" })
      const body: (ProviderStatusResponse & { error?: string }) | null = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      setProbes(body?.results ?? null)
      setControls(body?.controls ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the server configuration")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="mb-2 font-display text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Display preferences for this browser, and a read-only view of the collector configuration
          held on the server.
        </p>
      </div>

      <Tabs defaultValue="display" className="space-y-6">
        <TabsList className="flex w-full flex-wrap gap-2 overflow-x-auto sm:w-auto">
          <TabsTrigger value="display">Display</TabsTrigger>
          <TabsTrigger value="providers">Data sources</TabsTrigger>
          <TabsTrigger value="security">Credentials</TabsTrigger>
        </TabsList>

        <TabsContent value="display">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Monitor className="h-5 w-5" aria-hidden />
                Display preferences
              </CardTitle>
              <CardDescription>
                These apply to this browser only. The choice is stored by the theme provider.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="theme-select">Theme</Label>
                <Select
                  value={mounted ? (theme ?? "system") : "system"}
                  onValueChange={setTheme}
                  disabled={!mounted}
                >
                  <SelectTrigger id="theme-select" className="max-w-xs">
                    <SelectValue placeholder="System" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="system">Match the operating system</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Currently showing the{" "}
                  {mounted ? (resolvedTheme === "dark" ? "dark" : "light") : "…"} theme.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="providers" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" aria-hidden />
                Collector configuration
              </CardTitle>
              <CardDescription>
                Read from the running server. Change these through the environment file and restart
                the workers; the dashboard does not write them.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && (
                <PanelError
                  title="Configuration could not be loaded"
                  message={error}
                  onRetry={load}
                  retrying={loading}
                />
              )}

              {loading && !controls && !error && (
                <p className="text-sm text-muted-foreground">Loading the server configuration…</p>
              )}

              {controls && controls.providers.length === 0 && (
                <p className="text-sm text-muted-foreground">No providers are configured on the server.</p>
              )}

              {controls && controls.providers.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-2 pr-4">Provider</th>
                        <th className="py-2 pr-4">Status</th>
                        <th className="py-2 pr-4">Probe</th>
                        <th className="py-2 pr-4">Cadence</th>
                        <th className="py-2 pr-4">Lane</th>
                        <th className="py-2 pr-4">Batch</th>
                        <th className="py-2 pr-4">In flight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {controls.providers.map((provider) => {
                        const probe = probes?.[provider.id]
                        return (
                          <tr key={provider.id} className="border-t">
                            <td className="py-2 pr-4">
                              <span className="font-medium">{provider.displayName}</span>
                              <span className="block text-xs text-muted-foreground">
                                {provider.primaryFamily.replace(/_/g, " ")}
                              </span>
                            </td>
                            <td className="py-2 pr-4">
                              <Badge
                                variant={provider.rolloutEnabled ? "default" : "secondary"}
                                className={provider.rolloutEnabled ? "bg-green-600" : ""}
                              >
                                {provider.rolloutEnabled ? "Collecting" : "Paused"}
                              </Badge>
                              {!provider.configuredEnabled && (
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  Disabled in configuration
                                </span>
                              )}
                            </td>
                            <td className="py-2 pr-4">
                              {probe ? (
                                <Badge variant={probe.ok ? "default" : "destructive"}>
                                  {probe.ok ? "OK" : "Error"}
                                </Badge>
                              ) : (
                                <span className="text-xs text-muted-foreground">Not probed</span>
                              )}
                            </td>
                            <td className="py-2 pr-4">{formatCadence(provider.intervalMs)}</td>
                            <td className="py-2 pr-4">{provider.lane}</td>
                            <td className="py-2 pr-4">{formatNumber(provider.chunkSize)}</td>
                            <td className="py-2 pr-4">{formatNumber(provider.maxInFlight)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
                <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
                Reload configuration
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Attribution requirements</CardTitle>
              <CardDescription>
                Providers whose licence requires the attribution text shown on the public site
              </CardDescription>
            </CardHeader>
            <CardContent>
              {controls ? (
                <ul className="space-y-3">
                  {controls.providers
                    .filter((provider) => provider.attributionRequired)
                    .map((provider) => (
                      <li key={provider.id} className="text-sm">
                        <span className="font-medium">{provider.displayName}</span>
                        {provider.attributionText ? (
                          <span className="block text-muted-foreground">{provider.attributionText}</span>
                        ) : (
                          <span className="block text-muted-foreground">
                            Attribution required; no text supplied in the registry.
                          </span>
                        )}
                      </li>
                    ))}
                  {controls.providers.every((provider) => !provider.attributionRequired) && (
                    <li className="text-sm text-muted-foreground">
                      No provider currently requires attribution text.
                    </li>
                  )}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Configuration not loaded.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" aria-hidden />
                Credentials
              </CardTitle>
              <CardDescription>Where the collector credentials live</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                Provider API keys and the BSV wallet key are read from the server environment. They
                are never sent to the browser and cannot be entered or changed here.
              </p>
              <p className="text-muted-foreground">
                To rotate a key, update the environment file on the server and restart the workers.
                The <span className="font-mono text-xs">npm run sync:env:dry-run</span> script reports
                what would change before you apply it.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" aria-hidden />
                Network
              </CardTitle>
              <CardDescription>Recording target</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <p>
                This deployment records to BSV mainnet only. Every transaction link in the dashboard
                opens a mainnet transaction on WhatsOnChain.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
