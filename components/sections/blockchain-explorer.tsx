"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ExternalLink,
  ArrowRight,
  Clock,
  Check,
  X,
  MapPin,
  Wallet,
  Shield,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getBSVExplorerUrl, getBSVAddressUrl, isValidTxId } from "@/lib/utils"
import { DATA_FAMILY_DESCRIPTORS } from "@/lib/stream-registry"
import { familyIcon } from "@/lib/family-icons"
import { getKeyMetrics } from "@/lib/family-metrics"
import { explorerCardBadge, type ArcPhase } from "@/lib/arc-tx-status"
import { holdHomepageStage, whenHomepageStageOpen } from "@/lib/homepage-load-queue"

interface TransactionDisplay {
  id: string
  family: string
  location: string | null
  timestamp: string
  status: string
  arcPhase: ArcPhase | null
  metrics: Record<string, unknown>
}

function homepageBadgeClass(label: string): string {
  if (label === 'Rejected' || label === 'Reorg') {
    return 'bg-red-900/50 text-red-400 rounded-sm'
  }
  if (label === 'Confirmed') {
    return 'bg-green-900/50 text-green-400 rounded-sm'
  }
  // Pending and In mempool
  return 'bg-yellow-900/50 text-yellow-400 rounded-sm'
}

export function BlockchainExplorer() {
  const [txByFamily, setTxByFamily] = useState<Map<string, TransactionDisplay>>(new Map())
  const [network, setNetwork] = useState<string>('main')
  const [loading, setLoading] = useState(true)
  const [showWalletModal, setShowWalletModal] = useState(false)
  const [readingsSource, setReadingsSource] = useState<string | null>(null)

  const wallets = [
    { name: 'Wallet 1', address: '13S6zUA88PtDNy9DKHZuh3QQmy4d4eN4Se' },
    { name: 'Wallet 2', address: '1Jm2t7cmarKskV65UsigAr7tveS5WhPdJS' },
    { name: 'Wallet 3', address: '127HLeWpr66JU3SDmQJ9dmjBo6RgNsRU1w' },
  ]

  function formatTimestamp(timestamp: string): string {
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

  const fetchTransactions = useCallback(async () => {
    try {
      const response = await fetch('/api/blockchain/recent-readings')
      const result = await response.json()

      if (result.success && result.readings) {
        setReadingsSource(result.source ?? null)
        const netStr =
          result.network === 'mainnet' ? 'main'
          : result.network === 'testnet' ? 'test'
          : (result.network || 'main')
        setNetwork(netStr)

        const newMap = new Map<string, TransactionDisplay>()
        result.readings
          .filter((r: any) => r.txid && r.txid !== 'failed' && isValidTxId(r.txid))
          .forEach((r: any) => {
            newMap.set(r.type, {
              id: r.txid,
              family: r.type,
              location: r.location ?? null,
              timestamp: formatTimestamp(r.timestamp),
              status: r.status || 'confirmed',
              arcPhase: (r.arcPhase as ArcPhase | null | undefined) ?? null,
              metrics: r.data?.metrics ?? {},
            })
          })
        setTxByFamily(newMap)
      }
    } catch (error) {
      console.error('Error fetching blockchain transactions:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const release = holdHomepageStage(2)
    let cancelled = false
    let intervalId: ReturnType<typeof setInterval> | undefined
    let released = false
    const releaseOnce = () => {
      if (released) return
      released = true
      release()
    }

    void whenHomepageStageOpen(2).then(() => {
      if (cancelled) {
        releaseOnce()
        return
      }
      void fetchTransactions().finally(() => {
        releaseOnce()
        if (!cancelled) intervalId = setInterval(fetchTransactions, 45000)
      })
    })

    return () => {
      cancelled = true
      releaseOnce()
      if (intervalId) clearInterval(intervalId)
    }
  }, [fetchTransactions])

  const buildMetricsSummary = (family: string, metrics: Record<string, unknown>): string | null => {
    const items = getKeyMetrics(family, metrics, 3)
    if (items.length === 0) return null
    return items.map(m => `${m.label}: ${m.value}`).join(' • ')
  }

  const getWhatsonChainUrl = (txid: string): string =>
    getBSVExplorerUrl(txid, network as 'main' | 'test')

  return (
    <section id="blockchain" className="py-20 px-4 sm:px-6 lg:px-8 relative scroll-mt-24">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-purple-950/15 to-transparent pointer-events-none"></div>
      <div className="relative z-10">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="font-display text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">Blockchain Verification</h2>
            <p className="text-lg text-slate-400 max-w-2xl mx-auto">
              Every environmental measurement is cryptographically secured and stored on the BSV blockchain. Verify any
              data point independently.
            </p>
            {readingsSource === 'overlay' && txByFamily.size > 0 && (
              <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-green-900/30 border border-green-700/50">
                <Shield className="h-4 w-4 text-green-400" />
                <span className="text-sm font-medium text-green-400">Verified on-chain</span>
                <span className="text-xs text-slate-400">— Data from overlay index</span>
              </div>
            )}
          </div>

          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
              {loading && txByFamily.size === 0 && (
                <div className="md:col-span-2 text-center text-sm text-slate-500 py-8">
                  Loading recent on-chain readings…
                </div>
              )}
              {!loading && txByFamily.size === 0 && (
                <div className="md:col-span-2 text-center text-sm text-slate-500 py-8">
                  No recent on-chain readings in the current window yet.
                </div>
              )}
              {Object.values(DATA_FAMILY_DESCRIPTORS)
                .filter((descriptor) => txByFamily.has(descriptor.id))
                .map((descriptor) => {
                const tx = txByFamily.get(descriptor.id)!
                const metricsSummary = buildMetricsSummary(descriptor.id, tx.metrics)
                const description = metricsSummary ?? `${descriptor.label} data recorded`
                const badge = explorerCardBadge({
                  phase: tx.arcPhase,
                  confirmed: tx.status === 'confirmed',
                  blockHeight: 0,
                })

                const FamilyIcon = familyIcon(descriptor.id)
                const isRejected = badge.label === 'Rejected' || badge.label === 'Reorg'
                const isConfirmed = badge.label === 'Confirmed'
                const StatusIcon = isConfirmed ? Check : isRejected ? X : Clock
                const statusCircleClass = isConfirmed
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40'
                  : isRejected
                    ? 'bg-red-500/20 text-red-300 border-red-400/40'
                    : 'bg-amber-500/20 text-amber-300 border-amber-400/40'

                return (
                  <GlowCard key={descriptor.id} glowColor="purple" customSize className="h-full flex flex-col justify-between !gap-0">
                    <div>
                      <div className="flex items-start justify-between gap-3 -mr-4 -mt-4 min-w-0">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1 pt-3.5">
                          <div
                            className="w-8 h-8 shrink-0 bg-purple-500/15 border border-purple-400/25 flex items-center justify-center"
                            style={{ borderRadius: '12px 0 12px 0' }}
                          >
                            <FamilyIcon className="h-4 w-4 text-purple-300" />
                          </div>
                          <span className="font-semibold text-white leading-tight truncate">{descriptor.label}</span>
                        </div>
                        <button
                          type="button"
                          title={badge.title}
                          className="shrink-0 self-start border-b border-l border-purple-400/20 bg-purple-500/10 px-3 py-2.5 text-xs font-medium text-purple-200 transition-colors hover:bg-purple-500/20 hover:text-white"
                          style={{ borderRadius: '0 16px 0 12px' }}
                          onClick={() => window.open(getWhatsonChainUrl(tx.id), '_blank')}
                        >
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <span
                              className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${statusCircleClass}`}
                              aria-label={badge.label}
                            >
                              <StatusIcon className="h-2.5 w-2.5" strokeWidth={2.5} />
                            </span>
                            View TX
                            <ExternalLink className="h-3 w-3" />
                          </span>
                        </button>
                      </div>

                      <div className="mt-2.5 space-y-1.5 min-w-0">
                        <div className="text-sm text-slate-300/90 line-clamp-2">
                          {description}
                        </div>
                        {tx.location && (
                          <div className="flex items-start gap-1.5 text-xs text-slate-400 min-w-0">
                            <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5 text-purple-300/70" />
                            <span className="min-w-0 line-clamp-2 break-words">{tx.location}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between flex-wrap gap-2 text-xs text-slate-400 border-t border-white/5 pt-2.5 mt-3">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3 w-3 shrink-0 text-slate-500" />
                        <span>{tx.timestamp}</span>
                      </span>
                      <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-white/5 border border-white/10 text-slate-300">
                        {tx.id.slice(0, 8)}…{tx.id.slice(-8)}
                      </span>
                    </div>
                  </GlowCard>
                )
              })}
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button
                asChild
                className="w-full sm:w-auto bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white border border-purple-400/30 shadow-[0_8px_24px_-8px_rgba(168,85,247,0.55)]"
              >
                <Link href="/explorer">
                  Explore All On-Chain Readings
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button
                variant="outline"
                className="w-full sm:w-auto border-slate-600 text-slate-300 hover:bg-slate-800 bg-transparent"
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
