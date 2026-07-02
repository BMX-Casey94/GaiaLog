"use client"

import { useState, useEffect, useCallback } from "react"

export interface BlockchainTransaction {
  txid: string
  dataType: string
  timestamp: string
  status: string
  location: string | null
  provider: string | null
}

export interface BlockchainConnectionStatus {
  connected: boolean
  totalTransactions: number
  processingRate: number
  errorRate: number
  queueSize: number
  runningWorkers: number
}

const BSV_NETWORK_PARAM = "main"

export function getExplorerUrl(txid: string): string {
  return `https://whatsonchain.com/tx/${txid}?network=${BSV_NETWORK_PARAM}`
}

/**
 * Reads live blockchain state from the real service APIs:
 * - /api/blockchain/recent-readings — latest broadcast TX per data family
 * - /api/bsv/stats — wallet/queue/worker service statistics
 */
export function useBlockchain() {
  const [transactions, setTransactions] = useState<BlockchainTransaction[]>([])
  const [connectionStatus, setConnectionStatus] = useState<BlockchainConnectionStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const [readingsRes, statsRes] = await Promise.allSettled([
        fetch('/api/blockchain/recent-readings'),
        fetch('/api/bsv/stats'),
      ])

      if (readingsRes.status === 'fulfilled' && readingsRes.value.ok) {
        const data = await readingsRes.value.json()
        if (data?.success && Array.isArray(data.readings)) {
          setTransactions(
            data.readings.map((r: any) => ({
              txid: r.txid,
              dataType: r.type,
              timestamp: r.timestamp,
              status: r.status || 'confirmed',
              location: r.location ?? null,
              provider: r.data?.provider ?? null,
            }))
          )
        }
      }

      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const stats = await statsRes.value.json()
        setConnectionStatus({
          connected: stats?.success !== false,
          totalTransactions: Number(stats?.totalTransactions) || 0,
          processingRate: Number(stats?.processingRate) || 0,
          errorRate: Number(stats?.errorRate) || 0,
          queueSize: Number(stats?.queueSize) || 0,
          runningWorkers: Number(stats?.runningWorkers) || 0,
        })
      } else {
        setConnectionStatus((prev) => prev ? { ...prev, connected: false } : {
          connected: false,
          totalTransactions: 0,
          processingRate: 0,
          errorRate: 0,
          queueSize: 0,
          runningWorkers: 0,
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch blockchain status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 45000)
    return () => clearInterval(interval)
  }, [refresh])

  return {
    transactions,
    connectionStatus,
    loading,
    error,
    refresh,
    getExplorerUrl,
  }
}
