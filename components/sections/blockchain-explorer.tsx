"use client"

import { useEffect, useState } from "react"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ExternalLink, Clock, Hash, Wallet } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getBSVNetwork, getBSVExplorerUrl, getBSVAddressUrl, isValidTxId } from "@/lib/utils"

interface ReadingData {
  provider?: string
}

interface Reading {
  txid: string
  type: string
  timestamp: string
  status?: string
  data: ReadingData
}

interface TransactionDisplay {
  id: string
  type: string
  timestamp: string
  status: string
  data: string
}

export function BlockchainExplorer() {
  const [transactions, setTransactions] = useState<TransactionDisplay[]>([])
  const [network, setNetwork] = useState<string>('test')
  const [loading, setLoading] = useState(true)
  const [showWalletModal, setShowWalletModal] = useState(false)

  const wallets = [
    { name: 'Wallet 1', address: '13S6zUA88PtDNy9DKHZuh3QQmy4d4eN4Se' },
    { name: 'Wallet 2', address: '1Jm2t7cmarKskV65UsigAr7tveS5WhPdJS' },
    { name: 'Wallet 3', address: '127HLeWpr66JU3SDmQJ9dmjBo6RgNsRU1w' },
  ]

  const fetchTransactions = async () => {
    try {
      const response = await fetch('/api/blockchain/recent-readings')
      const result = await response.json()
      
      if (result.success && result.readings) {
        // Normalise network value to 'main' | 'test'
        const netStr =
          result.network === 'mainnet' ? 'main'
          : result.network === 'testnet' ? 'test'
          : (result.network || 'test')
        setNetwork(netStr)
        
        // Transform the readings into display format
        // API returns max 4 entries (one latest transaction per data type)
        const displayTransactions: TransactionDisplay[] = result.readings
          .filter((reading: Reading) => reading.txid && reading.txid !== 'failed' && isValidTxId(reading.txid))
          .map((reading: Reading) => ({
            id: reading.txid,
            type: formatType(reading.type),
            timestamp: formatTimestamp(reading.timestamp),
            status: reading.status || 'confirmed',
            data: formatReadingData(reading.type, reading.data),
          }))
        
        setTransactions(displayTransactions)
      }
    } catch (error) {
      console.error('Error fetching blockchain transactions:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTransactions()
    // Refresh every 45 seconds
    const interval = setInterval(fetchTransactions, 45000)
    return () => clearInterval(interval)
  }, [])

  const formatType = (type: string): string => {
    const typeMap: { [key: string]: string } = {
      air_quality: 'Air Quality',
      water_levels: 'Water Levels',
      seismic_activity: 'Seismic Activity',
      advanced_metrics: 'Advanced Metrics',
    }
    return typeMap[type] || type
  }

  const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`
    
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
    
    const diffDays = Math.floor(diffHours / 24)
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
  }

  const formatReadingData = (type: string, data: ReadingData): string => {
    const provider = data.provider || 'Unknown'
    
    switch (type) {
      case 'air_quality':
        return `Air quality data recorded from various sources.`
      
      case 'water_levels':
        return `Water level measurements from ${provider}`
      
      case 'seismic_activity':
        return `Seismic activity detected by ${provider}`
      
      case 'advanced_metrics':
        return `Environmental metrics from various sources, processed via ${provider}`
      
      default:
        return `Environmental data recorded from ${provider}`
    }
  }

  const getWhatsonChainUrl = (txid: string): string =>
    getBSVExplorerUrl(txid, network as 'main' | 'test')

  return (
    <section id="blockchain" className="py-20 px-4 sm:px-6 lg:px-8 relative scroll-mt-24">
      <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-slate-900/20 to-slate-950/50 pointer-events-none"></div>
      <div className="relative z-10">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Blockchain Verification</h2>
            <p className="text-lg text-slate-400 max-w-2xl mx-auto">
              Every environmental measurement is cryptographically secured and stored on the BSV blockchain. Verify any
              data point independently.
            </p>
          </div>

          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
              {['Air Quality', 'Water Levels', 'Seismic Activity', 'Advanced Metrics'].map((label) => {
                const tx = transactions.find((t) => t.type === label)
                return (
                  <GlowCard key={label} glowColor="purple" customSize>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-4">
                        <div className="w-10 h-10 bg-slate-950/60 rounded-full flex items-center justify-center">
                          <Hash className="h-5 w-5 text-purple-300" />
                        </div>
                        <div>
                          <div className="flex items-center space-x-2 mb-1">
                            <span className="font-medium text-white">{label}</span>
                            {tx && (
                              <Badge 
                                variant="secondary" 
                                className={tx.status === 'pending' 
                                  ? "bg-yellow-900/50 text-yellow-400 rounded-sm" 
                                  : "bg-green-900/50 text-green-400 rounded-sm"}
                              >
                                {tx.status}
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm text-slate-400 mb-1">
                            {loading ? 'Loading...' : (tx ? tx.data : 'No recent transactions found yet.')}
                          </div>
                          {tx ? (
                            <div className="flex items-center space-x-2 text-xs text-slate-500">
                              <Clock className="h-3 w-3" />
                              <span>{tx.timestamp}</span>
                              <span>•</span>
                              <span className="font-mono">
                                {tx.id.slice(0, 8)}...{tx.id.slice(-8)}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                      {tx ? (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="text-purple-300 hover:text-purple-200"
                          onClick={() => window.open(getWhatsonChainUrl(tx.id), '_blank')}
                        >
                          <span className="sm:hidden inline-flex items-center">TX<ExternalLink className="ml-1 h-3 w-3" /></span>
                          <span className="hidden sm:inline">View BSV TX</span>
                          <ExternalLink className="ml-2 h-3 w-3 hidden sm:inline" />
                        </Button>
                      ) : null}
                    </div>
                  </GlowCard>
                )
              })}
            </div>
            
            <div className="text-center">
              <Button 
                variant="outline" 
                className="border-slate-600 text-slate-300 hover:bg-slate-800 bg-transparent"
                onClick={() => setShowWalletModal(true)}
              >
                View Transaction History
                <ExternalLink className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </>
        </div>
      </div>

      {/* Wallet Selection Modal */}
      <Dialog open={showWalletModal} onOpenChange={setShowWalletModal}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-white">Select Wallet</DialogTitle>
            <DialogDescription className="text-slate-400">
              Choose a wallet to view its complete transaction history on WhatsonChain
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-3 mt-4">
            {wallets.map((wallet, index) => (
              <button
                key={index}
                onClick={() => {
                  window.open(getBSVAddressUrl(wallet.address, network as 'main' | 'test'), '_blank')
                  setShowWalletModal(false)
                }}
                className="w-full flex items-center justify-between p-4 bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700 hover:border-purple-500/50 rounded-lg transition-all group"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-purple-900/30 rounded-full flex items-center justify-center group-hover:bg-purple-800/40 transition-colors">
                    <Wallet className="h-5 w-5 text-purple-400" />
                  </div>
                  <div className="text-left">
                    <div className="font-medium text-white">{wallet.name}</div>
                    <div className="text-xs text-slate-400 font-mono">
                      {wallet.address.slice(0, 8)}...{wallet.address.slice(-8)}
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-4 w-4 text-slate-400 group-hover:text-purple-400 transition-colors" />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
