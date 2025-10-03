"use client"

import { useState, useEffect, useCallback } from "react"
import { bsvClient, type BlockchainTransaction, type WalletConfig } from "@/lib/bsv-client"

export function useBlockchain() {
  const [wallet, setWallet] = useState<WalletConfig | null>(null)
  const [transactions, setTransactions] = useState<BlockchainTransaction[]>([])
  const [connectionStatus, setConnectionStatus] = useState<{
    connected: boolean
    blockHeight: number
    networkFee: number
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initialize wallet
  const initializeWallet = useCallback(async (privateKey?: string) => {
    try {
      setLoading(true)
      setError(null)
      const walletInfo = await bsvClient.initializeWallet(privateKey)
      setWallet(walletInfo)
      return walletInfo
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize wallet")
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  // Record data on blockchain
  const recordData = useCallback(async (dataType: string, data: any) => {
    try {
      setLoading(true)
      setError(null)
      const transaction = await bsvClient.recordEnvironmentalData(dataType, data)
      setTransactions((prev) => [transaction, ...prev])
      return transaction
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record data")
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  // Refresh transaction history
  const refreshTransactions = useCallback(() => {
    const history = bsvClient.getTransactionHistory()
    setTransactions(history)
  }, [])

  // Check connection status
  const checkConnection = useCallback(async () => {
    try {
      const status = await bsvClient.getConnectionStatus()
      setConnectionStatus(status)
      return status
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check connection")
      return null
    }
  }, [])

  // Initialize on mount
  useEffect(() => {
    initializeWallet()
    checkConnection()
  }, [initializeWallet, checkConnection])

  // Refresh transactions periodically
  useEffect(() => {
    const interval = setInterval(refreshTransactions, 5000)
    return () => clearInterval(interval)
  }, [refreshTransactions])

  return {
    wallet,
    transactions,
    connectionStatus,
    loading,
    error,
    initializeWallet,
    recordData,
    refreshTransactions,
    checkConnection,
    getExplorerUrl: bsvClient.getExplorerUrl,
  }
}
