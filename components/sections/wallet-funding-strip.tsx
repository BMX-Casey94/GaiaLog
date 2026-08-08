"use client"

import { useCallback, useEffect, useState } from "react"
import { Wallet, ExternalLink, RefreshCw } from "lucide-react"

interface WalletFundingRow {
  index: number
  label: string
  address: string
  confirmedSats: number
  unconfirmedSats: number
  totalSats: number
  explorerUrl: string
  error?: string
}

interface WalletFundingResponse {
  ok: boolean
  generatedAt?: string
  totalSats?: number
  wallets?: WalletFundingRow[]
}

function formatBsv(sats: number): string {
  return (sats / 1e8).toFixed(8)
}

function formatSats(sats: number): string {
  return sats.toLocaleString('en-GB')
}

function shortAddress(address: string): string {
  if (address.length <= 16) return address
  return `${address.slice(0, 8)}…${address.slice(-6)}`
}

function runwayTone(totalSats: number): string {
  // Rough visual cue only — not the worker funding-monitor math.
  if (totalSats <= 0) return 'text-red-400'
  if (totalSats < 1_000_000) return 'text-amber-400' // < 0.01 BSV
  if (totalSats < 5_000_000) return 'text-yellow-300' // < 0.05 BSV
  return 'text-cyan-300'
}

function WalletChip({ wallet }: { wallet: WalletFundingRow }) {
  const tone = wallet.error ? 'text-slate-400' : runwayTone(wallet.totalSats)
  return (
    <a
      href={wallet.explorerUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-3 shrink-0 rounded-xl border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10 hover:border-cyan-400/30 transition-colors"
    >
      <div className="w-9 h-9 rounded-full bg-cyan-400/15 flex items-center justify-center shrink-0">
        <Wallet className="h-4 w-4 text-cyan-400" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <span>{wallet.label}</span>
          <span className="font-mono text-xs text-slate-400">{shortAddress(wallet.address)}</span>
          <ExternalLink className="h-3 w-3 text-slate-500" />
        </div>
        {wallet.error ? (
          <div className="text-xs text-slate-500 mt-0.5">Balance unavailable</div>
        ) : (
          <div className={`text-sm font-semibold tabular-nums mt-0.5 ${tone}`}>
            {formatBsv(wallet.totalSats)} BSV
            <span className="ml-2 text-xs font-normal text-slate-400">
              ({formatSats(wallet.totalSats)} sats)
            </span>
          </div>
        )}
      </div>
    </a>
  )
}

export function WalletFundingStrip() {
  const [wallets, setWallets] = useState<WalletFundingRow[]>([])
  const [totalSats, setTotalSats] = useState(0)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchFunding = useCallback(async () => {
    try {
      const res = await fetch('/api/blockchain/wallet-funding', { cache: 'no-store' })
      const data = (await res.json()) as WalletFundingResponse
      if (!res.ok || !data.ok || !Array.isArray(data.wallets)) {
        throw new Error('Failed to load wallet funding')
      }
      setWallets(data.wallets)
      setTotalSats(Number(data.totalSats || 0))
      setUpdatedAt(data.generatedAt || new Date().toISOString())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchFunding()
    const id = setInterval(() => { void fetchFunding() }, 60_000)
    return () => clearInterval(id)
  }, [fetchFunding])

  // Three identical groups for a seamless -33.333% loop. Extra horizontal
  // padding on each group creates a clear pause between W3 → W1 so the strip
  // reads as three wallets, not an endless chain.
  const groups = wallets.length > 0 ? [0, 1, 2] : []

  return (
    <section
      aria-label="Treasury wallet funding"
      className="relative w-full border-y border-white/10 bg-black/60 backdrop-blur-sm"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-4">
        <div className="shrink-0">
          <div className="text-xs uppercase tracking-wider text-cyan-400/90 font-medium">
            Treasury funding
          </div>
          <div className="text-sm text-slate-300 tabular-nums">
            {loading && wallets.length === 0
              ? 'Loading balances…'
              : error && wallets.length === 0
                ? 'Unable to load balances'
                : `Total ${formatBsv(totalSats)} BSV`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => { void fetchFunding() }}
          className="shrink-0 inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-cyan-300 transition-colors"
          aria-label="Refresh wallet balances"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          {updatedAt
            ? `Updated ${new Date(updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
            : 'Refresh'}
        </button>
      </div>

      <div className="relative overflow-hidden pb-4">
        <div className="pointer-events-none absolute inset-y-0 left-0 w-10 sm:w-16 bg-gradient-to-r from-black to-transparent z-10" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-10 sm:w-16 bg-gradient-to-l from-black to-transparent z-10" />

        {wallets.length === 0 ? (
          <div className="px-4 sm:px-6 lg:px-8 text-sm text-slate-500 py-2">
            {loading ? 'Fetching wallet balances…' : (error || 'No wallet data')}
          </div>
        ) : (
          <div className="flex w-max animate-wallet-funding-marquee hover:[animation-play-state:paused]">
            {groups.map((group) => (
              <div
                key={group}
                className="flex gap-3 shrink-0 px-10 sm:px-16"
                aria-hidden={group > 0 ? true : undefined}
              >
                {wallets.map((wallet) => (
                  <WalletChip key={`${group}-${wallet.label}`} wallet={wallet} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
