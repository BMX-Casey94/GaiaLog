"use client"

import { useEffect, useMemo, useState } from "react"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { AlertOctagon, AlertTriangle, AlertCircle, Hash, ExternalLink } from "lucide-react"

type Alert = { code: string; severity: 'moderate' | 'high' | 'critical'; message: string; at: string }
type Snapshot = { success: boolean; network: 'main' | 'test'; generatedAt: string; alerts: Alert[]; recentTxs: string[] }

export function LiveBSVAlerts() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [network, setNetwork] = useState<'main' | 'test'>('test')
  const [error, setError] = useState<string | null>(null)
  const liveUrl = process.env.NEXT_PUBLIC_WOC_LIVE_URL

  const load = async () => {
    try {
      const res = await fetch('/api/live/woc/snapshot', { cache: 'no-store' })
      const j = await res.json()
      setSnap(j)
      if (j?.network) setNetwork(j.network)
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'fetch_failed')
    }
  }

  useEffect(() => {
    if (liveUrl) {
      const es = new EventSource(liveUrl)
      es.addEventListener('snapshot', (e: any) => {
        try {
          const j = JSON.parse(e.data)
          setSnap(j)
          if (j?.network) setNetwork(j.network)
        } catch {}
      })
      es.addEventListener('alert', (e: any) => {
        try {
          const a = JSON.parse(e.data)
          setSnap(prev => {
            if (!prev) return null
            return { ...prev, alerts: [a, ...(prev.alerts || [])].slice(0, 50) }
          })
        } catch {}
      })
      es.addEventListener('tx', (e: any) => {
        try {
          const { txid } = JSON.parse(e.data)
          setSnap(prev => {
            if (!prev) return null
            const dedup = [txid, ...(prev.recentTxs || [])].filter((v, i, arr) => arr.indexOf(v) === i)
            return { ...prev, recentTxs: dedup.slice(0, 50) }
          })
        } catch {}
      })
      es.onerror = () => {}
      return () => es.close()
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [liveUrl])

  const topAlerts = useMemo(() => {
    if (!snap?.alerts) return []
    const rank = { critical: 3, high: 2, moderate: 1 } as const
    return [...snap.alerts].sort((a, b) => rank[b.severity] - rank[a.severity]).slice(0, 4)
  }, [snap])

  const wocBase = useMemo(() => 'https://whatsonchain.com', [])

  return (
    <section className="py-20 px-4 sm:px-6 lg:px-8 relative">
      <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-slate-900/30 to-black/80 pointer-events-none"></div>
      <div className="relative">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-2">Live Blockchain Alerts</h2>
            <p className="text-base text-slate-400">Most severe BSV network signals sourced from WhatsOnChain.</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <GlowCard glowColor="purple" customSize disableGlow className="min-h-[12rem]">
              <div className="mb-2 text-purple-300 font-semibold text-center">Live Alerts</div>
              {topAlerts.length > 0 ? (
                <div className="space-y-3">
                  {topAlerts.map((a, i) => (
                    <div key={i} className="bg-slate-900/40 border border-slate-700/60 rounded-md p-3">
                      <div className="flex items-center gap-2 mb-1">
                        {a.severity === 'critical' && <AlertOctagon className="h-4 w-4 text-red-500" />}
                        {a.severity === 'high' && <AlertTriangle className="h-4 w-4 text-orange-500" />}
                        {a.severity === 'moderate' && <AlertCircle className="h-4 w-4 text-yellow-500" />}
                        <span className={
                          a.severity === 'critical' ? 'text-red-300' :
                          a.severity === 'high' ? 'text-orange-300' : 'text-yellow-300'
                        }>
                          {a.severity.toUpperCase()}
                        </span>
                      </div>
                      <div className="text-sm text-slate-300">{a.message}</div>
                      <div className="text-xs text-slate-500 mt-1">{new Date(a.at).toLocaleString('en-GB')}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-green-400 text-center">
                  <div className="text-lg font-bold mb-1">✓ All clear</div>
                  <div className="text-sm text-slate-400">No network warnings from WoC</div>
                </div>
              )}
              <div className="flex justify-center mt-3">
                <Badge variant="secondary" className="bg-purple-900/40 text-purple-300">
                  {snap?.generatedAt ? `Updated: ${new Date(snap.generatedAt).toLocaleTimeString('en-GB')}` : 'No data'}
                </Badge>
              </div>
            </GlowCard>

            <GlowCard glowColor="purple" customSize disableGlow className="min-h-[12rem] lg:col-span-2">
              <div className="mb-2 text-purple-300 font-semibold text-center">Recent Transactions</div>
              {snap?.recentTxs?.length ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {snap.recentTxs.slice(0, 6).map((tx) => (
                    <div key={tx} className="flex items-center justify-between bg-slate-900/40 border border-slate-700/60 rounded-md p-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-slate-950/60 rounded-full flex items-center justify-center">
                          <Hash className="h-4 w-4 text-purple-300" />
                        </div>
                        <div className="text-sm text-slate-300 font-mono">{tx.slice(0, 10)}…{tx.slice(-8)}</div>
                      </div>
                      <button
                        className="text-purple-300 hover:text-purple-200 text-sm inline-flex items-center"
                        onClick={() => window.open(`${wocBase}/tx/${tx}`, '_blank')}
                        aria-label="Open on WhatsOnChain"
                      >
                        View <ExternalLink className="h-3 w-3 ml-1" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center text-slate-400">No recent transactions</div>
              )}
            </GlowCard>
          </div>

          {error && <div className="text-center text-red-400 mt-4 text-sm">Error: {error}</div>}
        </div>
      </div>
    </section>
  )
}



