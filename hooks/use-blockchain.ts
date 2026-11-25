"use client"

/**
 * Live BSV blockchain state for the admin dashboard.
 *
 * - `/api/blockchain/recent-readings` — the latest broadcast transaction per
 *   data family, already persisted and validated server-side.
 * - `/api/bsv/stats` — wallet, queue and worker service statistics.
 *
 * Mainnet only: this application never records to or reads from a test network.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { getExplorerUrl, isValidTxid } from "@/lib/bsv-links"

export interface BlockchainTransaction {
  txid: string
  dataType: string
  /** ISO timestamp of the reading, or of the broadcast when no reading time exists. */
  timestamp: string
  status: "pending" | "confirmed" | "failed"
  provider: string | null
}

export interface BlockchainConnectionStatus {
  connected: boolean
  totalTransactions: number
  processingRate: number
  errorRate: number
  queueSize: number
  runningWorkers: number
  /** Why the connection is considered down, when it is. */
  reason: string | null
}

const REFRESH_MS = 45_000

function normaliseStatus(value: unknown): BlockchainTransaction["status"] {
  if (value === "pending" || value === "failed" || value === "confirmed") return value
  return "confirmed"
}

export interface BlockchainFeed {
  transactions: BlockchainTransaction[]
  connectionStatus: BlockchainConnectionStatus | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useBlockchainFeed(): BlockchainFeed {
  const [transactions, setTransactions] = useState<BlockchainTransaction[]>([])
  const [connectionStatus, setConnectionStatus] = useState<BlockchainConnectionStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    const [readingsResult, statsResult] = await Promise.allSettled([
      fetch("/api/blockchain/recent-readings", { cache: "no-store" }),
      fetch("/api/bsv/stats", { cache: "no-store" }),
    ])

    if (!mountedRef.current) return

    let readingsProblem: string | null = null
    if (readingsResult.status === "fulfilled" && readingsResult.value.ok) {
      try {
        const data = await readingsResult.value.json()
        const readings = Array.isArray(data?.readings) ? data.readings : []
        setTransactions(
          readings
            .filter((reading: any) => isValidTxid(reading?.txid))
            .map((reading: any) => ({
              txid: reading.txid as string,
              dataType: typeof reading.type === "string" ? reading.type : "unknown",
              timestamp: typeof reading.timestamp === "string" ? reading.timestamp : "",
              status: normaliseStatus(reading.status),
              provider: typeof reading.data?.provider === "string" ? reading.data.provider : null,
            })),
        )
      } catch {
        readingsProblem = "Recent readings returned an unreadable response"
      }
    } else {
      readingsProblem =
        readingsResult.status === "rejected"
          ? "Recent readings are unavailable"
          : `Recent readings failed (${readingsResult.value.status})`
    }

    let statsProblem: string | null = null
    if (statsResult.status === "fulfilled" && statsResult.value.ok) {
      try {
        const stats = await statsResult.value.json()
        const totalTransactions = Number(stats?.totalTransactions) || 0
        const errorRate = Number(stats?.errorRate) || 0
        setConnectionStatus({
          connected: stats?.success !== false,
          totalTransactions,
          processingRate: Number(stats?.processingRate) || 0,
          errorRate,
          queueSize: Number(stats?.queueSize) || 0,
          runningWorkers: Number(stats?.runningWorkers) || 0,
          reason: stats?.success === false ? "The BSV stats service reported an error" : null,
        })
      } catch {
        statsProblem = "BSV statistics returned an unreadable response"
      }
    } else {
      statsProblem =
        statsResult.status === "rejected"
          ? "The BSV stats service is unreachable"
          : `BSV statistics failed (${statsResult.value.status})`
    }

    if (statsProblem) {
      setConnectionStatus((previous) => ({
        connected: false,
        totalTransactions: previous?.totalTransactions ?? 0,
        processingRate: previous?.processingRate ?? 0,
        errorRate: previous?.errorRate ?? 0,
        queueSize: previous?.queueSize ?? 0,
        runningWorkers: previous?.runningWorkers ?? 0,
        reason: statsProblem,
      }))
    }

    const problem = statsProblem ?? readingsProblem
    setError(problem)
    setLoading(false)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const id = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [refresh])

  return {
    transactions,
    connectionStatus,
    loading,
    error,
    refresh,
  }
}
