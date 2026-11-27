"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminRefresh } from "@/components/admin-refresh"
import { PanelError } from "@/components/panels/panel-states"
import { MISSING, formatDateTime, formatMetric, formatNumber, formatTimeAgo } from "@/lib/admin-format"
import { isValidTxid, getExplorerUrl } from "@/lib/bsv-links"
import { cn } from "@/lib/utils"
import {
  Activity,
  AlertTriangle,
  Database,
  Network,
  RefreshCw,
  Shield,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react"

interface WalletInfo {
  index: number
  address: string
  /** Balance in BSV. */
  balance: number
  /** Epoch milliseconds, or null when the wallet has never been used. */
  lastUsed: number | null
  transactionCount: number
}

interface QueueStatus {
  highPriority: number
  normalPriority: number
  processing: number
  completed: number
  failed: number
}

interface WorkerStats {
  workerId: string
  isRunning: boolean
  totalRuns: number
  totalTransactions: number
  errors: number
  averageProcessingTime: number
  /** Epoch milliseconds, or null when the worker has not run yet. */
  lastRun: number | null
  /** Epoch milliseconds, or null when a next run cannot be calculated. */
  nextRun: number | null
}

interface BsvStats {
  totalTransactions: number
  processingRate: number
  errorRate: number
  dailyCapacity: number
}

interface ProviderStatusItem {
  ok: boolean
  message: string
}

interface ProviderStatus {
  weatherapi?: ProviderStatusItem
  waqi?: ProviderStatusItem
  owm?: ProviderStatusItem
}

interface HttpDomainMetrics {
  domain: string
  attempts: number
  successes: number
  notModified304: number
  errors4xx: number
  errors5xx: number
  backoffs: number
  avgLatencyMs: number
  lastStatus?: number
  lastUpdated: number
}

interface ProviderMetrics {
  attempts: number
  nm304: number
  e4xx: number
  e5xx: number
  backoffs: number
  avgMs: number
}

interface TxItem {
  txid: string
  type: string
  provider: string
  collected_at: string
  onchain_at: string | null
  status: string
}

const SATOSHIS_PER_BSV = 100_000_000
const TX_LOG_LIMIT = 50

/**
 * Per-request deadline. Wallet balances and the transaction log are fetched from
 * WhatsOnChain by the server and routinely take 60 seconds, so this is generous:
 * it only stops a genuinely hung request.
 */
const ENDPOINT_TIMEOUT_MS = 120_000

/** Poll interval. Longer than the deadline so polls cannot stack. */
const POLL_MS = 150_000

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function nullableTimestamp(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Maps a request host to the provider that owns it. */
function mapDomainToProvider(domain: string): string {
  if (!domain) return "Other"
  if (domain.includes("waqi.info") || domain.includes("aqicn.org")) return "WAQI"
  if (domain.includes("weatherapi.com")) return "WeatherAPI"
  if (domain.includes("openweathermap.org")) return "OpenWeatherMap"
  if (domain.includes("noaa.gov")) return "NOAA"
  if (domain.includes("usgs.gov")) return "USGS"
  if (domain.includes("whatsonchain.com") || domain.includes("taal.com") || domain.includes("bitails.io"))
    return "Blockchain"
  return "Other"
}

/** "3m 20s", "45s", "Due now" — all derived from a caller-supplied clock. */
function formatCountdown(nextRun: number | null, now: number | null): string {
  if (nextRun == null || now == null) return MISSING
  const diffMs = nextRun - now
  if (diffMs <= 0) return "Due now"
  const minutes = Math.floor(diffMs / 60_000)
  const seconds = Math.floor((diffMs % 60_000) / 1000)
  if (minutes < 1) return `${seconds}s`
  if (minutes < 60) return `${minutes}m ${seconds}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function BSVBlockchainPanel() {
  const { tick } = useAdminRefresh()
  const [wallets, setWallets] = useState<WalletInfo[]>([])
  const [queue, setQueue] = useState<QueueStatus>({
    highPriority: 0,
    normalPriority: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  })
  const [workers, setWorkers] = useState<WorkerStats[]>([])
  const [stats, setStats] = useState<BsvStats>({
    totalTransactions: 0,
    processingRate: 0,
    errorRate: 0,
    dailyCapacity: 0,
  })
  const [httpDomains, setHttpDomains] = useState<HttpDomainMetrics[]>([])
  const [providerHttp, setProviderHttp] = useState<Record<string, ProviderMetrics>>({})
  const [providers, setProviders] = useState<ProviderStatus | null>(null)
  const [txItems, setTxItems] = useState<TxItem[]>([])
  const [now, setNow] = useState<number | null>(null)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failedEndpoints, setFailedEndpoints] = useState<string[]>([])
  const [pending, setPending] = useState<string[]>([])
  /** Endpoint names that have returned at least one successful response. */
  const [loadedEndpoints, setLoadedEndpoints] = useState<string[]>([])

  const applyPayload = useCallback((name: string, json: any) => {
    if (name === "wallets") {
      const list = Array.isArray(json?.wallets) ? json.wallets : []
      setWallets(
        list.map((wallet: any, index: number) => ({
          index: Number.isFinite(wallet?.index) ? Number(wallet.index) : index,
          address: typeof wallet?.address === "string" ? wallet.address : "",
          balance: num(wallet?.balance) / SATOSHIS_PER_BSV,
          lastUsed: nullableTimestamp(wallet?.lastUsed),
          transactionCount: num(wallet?.transactionCount),
        })),
      )
      return
    }

    if (name === "queue") {
      setQueue({
        highPriority: num(json?.highPriorityItems),
        normalPriority: num(json?.normalPriorityItems),
        processing: num(json?.processingItems),
        completed: num(json?.completedItems),
        failed: num(json?.failedItems),
      })
      return
    }

    if (name === "workers") {
      const list = Array.isArray(json?.workers) ? json.workers : []
      setWorkers(
        list.map((worker: any) => ({
          workerId: typeof worker?.workerId === "string" ? worker.workerId : "unknown",
          isRunning: worker?.isRunning === true,
          totalRuns: num(worker?.totalRuns),
          totalTransactions: num(worker?.totalTransactions),
          errors: num(worker?.errors),
          averageProcessingTime: num(worker?.averageProcessingTime),
          lastRun: nullableTimestamp(worker?.lastRun),
          nextRun: nullableTimestamp(worker?.nextRun),
        })),
      )
      return
    }

    if (name === "stats") {
      setStats({
        totalTransactions: num(json?.totalTransactions),
        processingRate: num(json?.processingRate),
        errorRate: num(json?.errorRate),
        dailyCapacity: num(json?.dailyCapacity),
      })

      const domains: HttpDomainMetrics[] = Array.isArray(json?.http?.domains)
        ? json.http.domains.map((domain: any) => ({
            domain: String(domain?.domain ?? ""),
            attempts: num(domain?.attempts),
            successes: num(domain?.successes),
            notModified304: num(domain?.notModified304),
            errors4xx: num(domain?.errors4xx),
            errors5xx: num(domain?.errors5xx),
            backoffs: num(domain?.backoffs),
            avgLatencyMs: num(domain?.avgLatencyMs),
            lastStatus: Number.isFinite(domain?.lastStatus) ? Number(domain.lastStatus) : undefined,
            lastUpdated: num(domain?.lastUpdated),
          }))
        : []

      setHttpDomains([...domains].sort((a, b) => b.attempts - a.attempts).slice(0, 8))

      // Weight each domain's latency by its attempt count so a quiet endpoint
      // cannot drag a provider's average towards zero.
      const grouped = new Map<string, ProviderMetrics & { weightedLatency: number }>()
      for (const domain of domains) {
        const key = mapDomainToProvider(domain.domain)
        const entry =
          grouped.get(key) ?? { attempts: 0, nm304: 0, e4xx: 0, e5xx: 0, backoffs: 0, avgMs: 0, weightedLatency: 0 }
        entry.attempts += domain.attempts
        entry.nm304 += domain.notModified304
        entry.e4xx += domain.errors4xx
        entry.e5xx += domain.errors5xx
        entry.backoffs += domain.backoffs
        entry.weightedLatency += domain.avgLatencyMs * domain.attempts
        grouped.set(key, entry)
      }

      const compact: Record<string, ProviderMetrics> = {}
      for (const [key, entry] of grouped) {
        compact[key] = {
          attempts: entry.attempts,
          nm304: entry.nm304,
          e4xx: entry.e4xx,
          e5xx: entry.e5xx,
          backoffs: entry.backoffs,
          avgMs: entry.attempts > 0 ? entry.weightedLatency / entry.attempts : 0,
        }
      }
      setProviderHttp(compact)
      return
    }

    if (name === "transactions") {
      const list = Array.isArray(json?.items) ? json.items : []
      setTxItems(
        list.map((tx: any) => ({
          txid: typeof tx?.txid === "string" ? tx.txid : "",
          type: typeof tx?.type === "string" ? tx.type : "unknown",
          provider: typeof tx?.provider === "string" ? tx.provider : "",
          collected_at: typeof tx?.collected_at === "string" ? tx.collected_at : "",
          onchain_at: typeof tx?.onchain_at === "string" ? tx.onchain_at : null,
          status: typeof tx?.status === "string" ? tx.status : "unknown",
        })),
      )
      return
    }

    if (name === "providers" && json?.results) {
      setProviders({
        weatherapi: toProvider(json.results.weatherapi),
        waqi: toProvider(json.results.waqi),
        owm: toProvider(json.results.owm),
      })
    }
  }, [])

  const load = useCallback(async () => {
    const endpoints = [
      { name: "wallets", url: "/api/bsv/wallets" },
      { name: "queue", url: "/api/bsv/queue" },
      { name: "workers", url: "/api/bsv/workers" },
      { name: "stats", url: "/api/bsv/stats" },
      { name: "transactions", url: `/api/bsv/tx-log?limit=${TX_LOG_LIMIT}` },
      { name: "providers", url: "/api/providers/status" },
    ] as const

    setPending(endpoints.map((endpoint) => endpoint.name))

    // Two endpoints (wallet balances and the transaction log) read from
    // WhatsOnChain and can take a minute. Each response is applied the moment it
    // arrives, so the panel paints without waiting for the slowest service; the
    // deadline only stops a genuinely hung request.
    const failed: string[] = []

    await Promise.all(
      endpoints.map(async (endpoint) => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS)
        try {
          const res = await fetch(endpoint.url, { cache: "no-store", signal: controller.signal })
          if (!res.ok) {
            failed.push(endpoint.name)
            return
          }
          applyPayload(endpoint.name, await res.json())
          setLoadedEndpoints((previous) =>
            previous.includes(endpoint.name) ? previous : [...previous, endpoint.name],
          )
        } catch {
          failed.push(endpoint.name)
        } finally {
          clearTimeout(timeout)
          setPending((previous) => previous.filter((name) => name !== endpoint.name))
          // Paint as soon as anything has arrived; the slow endpoints keep
          // filling in behind the "still waiting on" notice.
          setLoading(false)
        }
      }),
    )

    setFailedEndpoints(failed)
    setError(
      failed.length === 0
        ? null
        : `These services did not respond: ${failed.join(", ")}. Values shown for them may be stale.`,
    )
    setFetchedAt(Date.now())
    setNow(Date.now())
    setLoading(false)
  }, [applyPayload])

  useEffect(() => {
    void load()
    const poll = setInterval(() => void load(), POLL_MS)
    // A separate one-second clock keeps countdowns live without re-fetching.
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
    }
  }, [load, tick])

  const handleRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const backlog = queue.highPriority + queue.normalPriority
  const attempted = queue.completed + queue.failed
  const successRate = attempted > 0 ? (queue.completed / attempted) * 100 : null
  const runningWorkers = workers.filter((worker) => worker.isRunning).length
  const allWorkersRunning = workers.length > 0 && runningWorkers === workers.length
  const totalWalletBalance = wallets.reduce((sum, wallet) => sum + wallet.balance, 0)
  const largestWalletBalance = wallets.reduce((max, wallet) => Math.max(max, wallet.balance), 0)

  // An empty list is only conclusive once its request has returned. Until then a
  // zero would read as "none configured", which is a different and alarming
  // claim.
  const walletsKnown = loadedEndpoints.includes("wallets")
  const workersKnown = loadedEndpoints.includes("workers")
  const queueKnown = loadedEndpoints.includes("queue")
  const statsKnown = loadedEndpoints.includes("stats")
  const transactionsKnown = loadedEndpoints.includes("transactions")

  // Transactions logged in the last hour. The log is capped at TX_LOG_LIMIT rows,
  // so this is described as a sample when the cap is reached.
  const hourAgo = (now ?? 0) - 60 * 60 * 1000
  const recentTransactions =
    now == null
      ? null
      : txItems.filter((tx) => {
          const timestamp = Date.parse(tx.onchain_at ?? tx.collected_at)
          return Number.isFinite(timestamp) && timestamp >= hourAgo
        }).length

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 font-display text-3xl font-bold">
          <Shield className="h-8 w-8" aria-hidden />
          BSV blockchain monitor
        </h1>
        <p className="mt-1 text-muted-foreground">
          Wallet, transaction queue and worker health for the BSV mainnet recording service.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Fetched: {fetchedAt ? formatTimeAgo(fetchedAt) : MISSING}
        </p>
      </div>
      <Button onClick={handleRefresh} disabled={refreshing}>
        <RefreshCw className={cn("mr-2 h-4 w-4", refreshing && "animate-spin")} aria-hidden />
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </div>
  )

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        {header}
        <p className="text-sm text-muted-foreground">
          Loading the BSV service state. Wallet balances and the transaction log are read from
          WhatsOnChain and can take a minute; the rest of the panel appears as soon as it arrives.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      {header}

      {pending.length > 0 && (
        <p className="text-xs text-muted-foreground" role="status">
          Still waiting on: {pending.join(", ")}. Those values will fill in when they arrive.
        </p>
      )}

      {error && (
        <PanelError
          title="Some BSV services did not respond"
          message={error}
          onRetry={handleRefresh}
          retrying={refreshing}
        />
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Transactions (24h)</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {statsKnown ? formatNumber(stats.totalTransactions) : MISSING}
            </p>
            <p className="text-xs text-muted-foreground">
              {!transactionsKnown || recentTransactions == null
                ? `Last hour: ${MISSING}`
                : `+${formatNumber(recentTransactions)} in the last hour${
                    txItems.length >= TX_LOG_LIMIT ? " (sampled)" : ""
                  }`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Processing rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {statsKnown ? `${formatNumber(stats.processingRate, 1)} tx/s` : MISSING}
            </p>
            <p className="text-xs text-muted-foreground">Current queue throughput</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Error rate (24h)</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {statsKnown ? `${formatNumber(stats.errorRate, 1)}%` : MISSING}
            </p>
            <p className="text-xs text-muted-foreground">
              {queueKnown
                ? `${formatNumber(queue.failed)} failed transaction${queue.failed === 1 ? "" : "s"} in the queue`
                : "Reading the queue…"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Daily capacity</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" aria-hidden />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {statsKnown ? formatNumber(stats.dailyCapacity) : MISSING}
            </p>
            <p className="text-xs text-muted-foreground">Projected transactions per day at this rate</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="wallets" className="space-y-4">
        <TabsList className="flex w-full flex-wrap gap-1 overflow-x-auto sm:w-auto">
          <TabsTrigger value="wallets">Wallets</TabsTrigger>
          <TabsTrigger value="queue">Transaction queue</TabsTrigger>
          <TabsTrigger value="workers">Workers</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="wallets" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {walletsKnown
                ? `${formatNumber(wallets.length)} wallet${wallets.length === 1 ? "" : "s"} · ${formatNumber(
                    totalWalletBalance,
                    8,
                  )} BSV in total`
                : "Reading wallet balances from WhatsOnChain…"}
            </p>
            {walletsKnown && (
              <Badge variant="outline" className="font-mono text-xs">
                {formatNumber(totalWalletBalance * SATOSHIS_PER_BSV)} satoshis
              </Badge>
            )}
          </div>

          {!walletsKnown ? (
            <p className="text-sm text-muted-foreground">
              Wallet balances are fetched from WhatsOnChain and can take a minute to arrive.
            </p>
          ) : wallets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No wallets are configured, so the service cannot broadcast.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {wallets.map((wallet) => {
                // Scale each bar against the largest wallet so the bars stay
                // comparable even when every balance is above the old 0.5 BSV
                // denominator.
                const share =
                  largestWalletBalance > 0 ? (wallet.balance / largestWalletBalance) * 100 : 0
                return (
                  <Card key={`${wallet.index}-${wallet.address}`}>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Wallet className="h-5 w-5" aria-hidden />
                        Wallet {wallet.index + 1}
                      </CardTitle>
                      <CardDescription className="break-all font-mono text-xs">
                        {wallet.address.length > 24
                          ? `${wallet.address.slice(0, 12)}…${wallet.address.slice(-12)}`
                          : wallet.address || "No address"}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Balance</span>
                        <span className="font-semibold">{formatNumber(wallet.balance, 8)} BSV</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Transactions</span>
                        <span className="font-semibold">{formatNumber(wallet.transactionCount)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Last used</span>
                        <span className="text-xs text-muted-foreground">
                          {wallet.lastUsed == null ? "Never" : formatTimeAgo(wallet.lastUsed)}
                        </span>
                      </div>
                      <div
                        className="h-2 w-full overflow-hidden rounded-full bg-secondary"
                        role="img"
                        aria-label={`Balance relative to the largest wallet: ${formatNumber(share, 0)}%`}
                      >
                        <div
                          className="h-2 rounded-full bg-primary transition-all duration-300"
                          style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                        />
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="queue" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5" aria-hidden />
                  Queue status
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center">
                    <p className="text-2xl font-bold text-blue-600">{formatNumber(queue.highPriority)}</p>
                    <p className="text-sm text-muted-foreground">High priority</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-green-600">
                      {formatNumber(queue.normalPriority)}
                    </p>
                    <p className="text-sm text-muted-foreground">Normal priority</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-yellow-600">{formatNumber(queue.processing)}</p>
                    <p className="text-sm text-muted-foreground">Processing</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-purple-600">{formatNumber(queue.completed)}</p>
                    <p className="text-sm text-muted-foreground">Completed</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Success rate</span>
                    <span>{successRate == null ? MISSING : `${formatNumber(successRate, 1)}%`}</span>
                  </div>
                  <Progress
                    value={successRate ?? 0}
                    aria-label="Transaction success rate"
                  />
                  {attempted === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Nothing has finished processing yet, so there is no success rate to report.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Network className="h-5 w-5" aria-hidden />
                  Queue performance
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Processing rate</dt>
                    <dd>
                      <Badge variant="secondary">{formatNumber(stats.processingRate, 1)} tx/s</Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Queued</dt>
                    <dd>
                      <Badge variant="outline">{formatNumber(backlog)}</Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Failed</dt>
                    <dd>
                      <Badge variant={queue.failed > 0 ? "destructive" : "outline"}>
                        {formatNumber(queue.failed)}
                      </Badge>
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="workers" className="space-y-4">
          {!workersKnown ? (
            <p className="text-sm text-muted-foreground">Reading worker statistics…</p>
          ) : workers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No worker statistics are available. Start the workers with{" "}
              <code className="rounded bg-muted px-1 py-0.5">npm run workers</code>.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {workers.map((worker) => (
                <Card key={worker.workerId}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Shield className="h-5 w-5" aria-hidden />
                      {worker.workerId}
                    </CardTitle>
                    <CardDescription>
                      <span className="mt-2 flex items-center gap-2">
                        <span
                          className={cn(
                            "h-2 w-2 rounded-full",
                            worker.isRunning ? "bg-green-500" : "bg-red-500",
                          )}
                          aria-hidden
                        />
                        <span className={worker.isRunning ? "text-green-600" : "text-red-600"}>
                          {worker.isRunning ? "Running" : "Stopped"}
                        </span>
                      </span>
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-muted-foreground">Runs:</span>
                        <div className="font-semibold">{formatNumber(worker.totalRuns)}</div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Transactions:</span>
                        <div className="font-semibold">{formatNumber(worker.totalTransactions)}</div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Errors:</span>
                        <div className={cn("font-semibold", worker.errors > 0 && "text-red-600")}>
                          {formatNumber(worker.errors)}
                        </div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Avg time:</span>
                        <div className="font-semibold">{formatMetric(worker.averageProcessingTime, "ms", 0)}</div>
                      </div>
                    </div>
                    <div className="mt-3 space-y-1 border-t pt-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Last run:</span>
                        <span>{worker.lastRun == null ? "Never" : formatTimeAgo(worker.lastRun)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Next run:</span>
                        <Badge variant="outline" className="font-mono">
                          {formatCountdown(worker.nextRun, now)}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-5 w-5" aria-hidden />
                  Recent transactions
                </CardTitle>
                <CardDescription>Latest {TX_LOG_LIMIT} rows from the transaction log</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-96 space-y-3 overflow-y-auto">
                  {txItems.map((tx) => {
                    const statusColour =
                      tx.status === "confirmed"
                        ? "bg-green-500"
                        : tx.status === "failed"
                          ? "bg-red-500"
                          : "bg-blue-500"
                    // Only real 64-character ids have a WhatsOnChain page.
                    const linkable = isValidTxid(tx.txid)
                    return (
                      <div
                        key={tx.txid}
                        className="flex items-center justify-between gap-3 rounded-lg border p-3"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span className={cn("h-3 w-3 shrink-0 rounded-full", statusColour)} aria-hidden />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium capitalize">
                              {tx.type.replace(/_/g, " ")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatDateTime(tx.onchain_at ?? tx.collected_at)}
                            </p>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-sm">
                            {linkable ? (
                              <a
                                href={getExplorerUrl(tx.txid)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline"
                              >
                                {tx.txid.slice(0, 8)}…
                              </a>
                            ) : (
                              (tx.txid ? `${tx.txid.slice(0, 8)}…` : MISSING)
                            )}
                          </p>
                          <p className="text-xs capitalize text-muted-foreground">{tx.status}</p>
                        </div>
                      </div>
                    )
                  })}
                  {txItems.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {transactionsKnown
                        ? "No transactions have been logged yet."
                        : "Reading the transaction log from WhatsOnChain…"}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" aria-hidden />
                  Transaction statistics
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Transactions (24h)</dt>
                    <dd className="font-semibold">{formatNumber(stats.totalTransactions)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Confirmed in the queue</dt>
                    <dd className="font-semibold text-green-600">{formatNumber(queue.completed)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Pending in the sample</dt>
                    <dd className="font-semibold text-yellow-600">
                      {formatNumber(txItems.filter((tx) => tx.status === "pending").length)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Failed in the queue</dt>
                    <dd className="font-semibold text-red-600">{formatNumber(queue.failed)}</dd>
                  </div>
                </dl>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Success rate</span>
                    <span>{successRate == null ? MISSING : `${formatNumber(successRate, 1)}%`}</span>
                  </div>
                  <Progress value={successRate ?? 0} className="h-2" aria-label="Transaction success rate" />
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Capacity</CardTitle>
                <CardDescription>Projected daily volume at the current processing rate</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt>Projected per day</dt>
                    <dd className="font-semibold text-green-600">{formatNumber(stats.dailyCapacity)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt>Recorded in the last 24 hours</dt>
                    <dd className="font-semibold">{formatNumber(stats.totalTransactions)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt>Headroom</dt>
                    <dd className="font-semibold">
                      {stats.totalTransactions > 0
                        ? `${formatNumber(stats.dailyCapacity / stats.totalTransactions, 1)}×`
                        : MISSING}
                    </dd>
                  </div>
                </dl>
                <div className="mt-4 space-y-1">
                  <Progress
                    value={
                      stats.dailyCapacity > 0
                        ? Math.min(100, (stats.totalTransactions / stats.dailyCapacity) * 100)
                        : 0
                    }
                    className="h-2"
                    aria-label="Recorded transactions as a share of projected daily capacity"
                  />
                  <p className="text-xs text-muted-foreground">
                    Recorded volume against projected capacity.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>System health</CardTitle>
                <CardDescription>Overall service status</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Service reachability</dt>
                    <dd>
                      <Badge
                        variant={failedEndpoints.length === 0 ? "default" : "destructive"}
                        className={failedEndpoints.length === 0 ? "bg-green-600" : ""}
                      >
                        {failedEndpoints.length === 0 ? "All responding" : `${failedEndpoints.length} failing`}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Error rate (24h)</dt>
                    <dd>
                      <Badge
                        variant={stats.errorRate < 5 ? "default" : "destructive"}
                        className={stats.errorRate < 5 ? "bg-green-600" : ""}
                      >
                        {formatNumber(stats.errorRate, 1)}%
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Workers</dt>
                    <dd>
                      <Badge
                        variant={allWorkersRunning ? "default" : "destructive"}
                        className={allWorkersRunning ? "bg-green-600" : ""}
                      >
                        {workers.length === 0
                          ? "None reported"
                          : `${runningWorkers}/${workers.length} running`}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-sm">Queue backlog</dt>
                    <dd>
                      <Badge
                        variant={backlog < 100 ? "default" : "destructive"}
                        className={backlog < 100 ? "bg-green-600" : ""}
                      >
                        {formatNumber(backlog)} queued
                      </Badge>
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Provider health</CardTitle>
                <CardDescription>Live probe results for the upstream data providers</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  {(
                    [
                      { key: "weatherapi", label: "WeatherAPI" },
                      { key: "waqi", label: "WAQI" },
                      { key: "owm", label: "OpenWeatherMap" },
                    ] as const
                  ).map(({ key, label }) => {
                    const state = providers?.[key]
                    return (
                      <div key={key} className="flex items-center justify-between gap-3">
                        <dt className="text-sm">{label}</dt>
                        <dd className="min-w-0 text-right">
                          <Badge variant={state?.ok ? "default" : "destructive"}>
                            {state?.ok ? "OK" : "Error"}
                          </Badge>
                          {state?.message && (
                            <p className="truncate text-xs text-muted-foreground" title={state.message}>
                              {state.message}
                            </p>
                          )}
                        </dd>
                      </div>
                    )
                  })}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>HTTP metrics by domain</CardTitle>
                <CardDescription>Requests, cache hits and errors per upstream host</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-2 pr-4">Domain</th>
                        <th className="py-2 pr-4">Requests</th>
                        <th className="py-2 pr-4">304</th>
                        <th className="py-2 pr-4">4xx</th>
                        <th className="py-2 pr-4">5xx</th>
                        <th className="py-2 pr-4">Backoffs</th>
                        <th className="py-2 pr-4">Avg ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {httpDomains.map((domain) => (
                        <tr key={domain.domain} className="border-t">
                          <td className="max-w-[14rem] truncate py-2 pr-4 font-mono" title={domain.domain}>
                            {domain.domain}
                          </td>
                          <td className="py-2 pr-4">{formatNumber(domain.attempts)}</td>
                          <td className="py-2 pr-4">{formatNumber(domain.notModified304)}</td>
                          <td className="py-2 pr-4">{formatNumber(domain.errors4xx)}</td>
                          <td className="py-2 pr-4">{formatNumber(domain.errors5xx)}</td>
                          <td className="py-2 pr-4">{formatNumber(domain.backoffs)}</td>
                          <td className="py-2 pr-4">{formatNumber(domain.avgLatencyMs, 0)}</td>
                        </tr>
                      ))}
                      {httpDomains.length === 0 && (
                        <tr>
                          <td className="py-2 text-muted-foreground" colSpan={7}>
                            No HTTP metrics have been recorded yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>HTTP metrics by provider</CardTitle>
                <CardDescription>
                  Domains grouped by provider; average latency is weighted by request count
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-2 pr-4">Provider</th>
                        <th className="py-2 pr-4">Requests</th>
                        <th className="py-2 pr-4">304</th>
                        <th className="py-2 pr-4">4xx</th>
                        <th className="py-2 pr-4">5xx</th>
                        <th className="py-2 pr-4">Backoffs</th>
                        <th className="py-2 pr-4">Avg ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(providerHttp).map(([provider, metrics]) => (
                        <tr key={provider} className="border-t">
                          <td className="py-2 pr-4">{provider}</td>
                          <td className="py-2 pr-4">{formatNumber(metrics.attempts)}</td>
                          <td className="py-2 pr-4">{formatNumber(metrics.nm304)}</td>
                          <td className="py-2 pr-4">{formatNumber(metrics.e4xx)}</td>
                          <td className="py-2 pr-4">{formatNumber(metrics.e5xx)}</td>
                          <td className="py-2 pr-4">{formatNumber(metrics.backoffs)}</td>
                          <td className="py-2 pr-4">{formatNumber(metrics.avgMs, 0)}</td>
                        </tr>
                      ))}
                      {Object.keys(providerHttp).length === 0 && (
                        <tr>
                          <td className="py-2 text-muted-foreground" colSpan={7}>
                            No provider metrics have been recorded yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function toProvider(value: unknown): ProviderStatusItem {
  if (!value || typeof value !== "object") return { ok: false, message: "No status reported" }
  const record = value as { ok?: boolean; message?: string }
  return {
    ok: record.ok === true,
    message: typeof record.message === "string" ? record.message : "",
  }
}
