"use client"

import { useState, useEffect } from "react"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Database, Droplets, Activity, Cloud, RefreshCw, ChevronDown, ChevronUp } from "lucide-react"
import { DATA_FAMILY_DESCRIPTORS } from "@/lib/stream-registry"

const FAMILY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  air_quality: Cloud,
  water_levels: Droplets,
  seismic_activity: Activity,
  advanced_metrics: Database,
  default: Database,
}

function formatIntervalMs(ms: number): string {
  if (ms >= 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))} hour${ms >= 2 * 60 * 60 * 1000 ? 's' : ''}`
  if (ms >= 60 * 1000) return `${Math.round(ms / 60000)} min`
  if (ms >= 1000) return `${Math.round(ms / 1000)} sec`
  return `${ms}ms`
}

interface ProviderSource {
  id: string
  name: string
  type: string
  icon: React.ComponentType<{ className?: string }>
  refreshRate: string
  coverage: string
  status: string
}

const PAGE_SIZE = 8

export function DataSources() {
  const [sources, setSources] = useState<ProviderSource[]>([])
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const res = await fetch('/api/providers/status', { cache: 'no-store' })
        const data = await res.json()
        const providers = data?.controls?.providers ?? []
        const enabled = providers.filter((p: any) => p.enabled && p.rolloutEnabled)
        const mapped: ProviderSource[] = enabled.map((p: any) => {
          const familyLabel = DATA_FAMILY_DESCRIPTORS[p.primaryFamily as keyof typeof DATA_FAMILY_DESCRIPTORS]?.label ?? p.primaryFamily
          const Icon = FAMILY_ICONS[p.primaryFamily] ?? FAMILY_ICONS.default
          return {
            id: p.id,
            name: p.displayName ?? p.id,
            type: familyLabel,
            icon: Icon,
            refreshRate: formatIntervalMs(p.intervalMs ?? 600000),
            coverage: 'Global',
            status: p.enabled ? 'operational' : 'disabled',
          }
        })
        setSources(mapped)
      } catch {
        setSources([])
      } finally {
        setLoading(false)
      }
    }
    fetchProviders()
    const interval = setInterval(fetchProviders, 60000)
    return () => clearInterval(interval)
  }, [])

  const allSources = sources
  const visibleSources = showAll ? allSources : allSources.slice(0, PAGE_SIZE)
  const hasMore = allSources.length > PAGE_SIZE

  return (
    <section id="data-sources" className="py-20 px-4 sm:px-6 lg:px-8 relative scroll-mt-24">
      <div className="absolute inset-0 bg-gradient-to-b from-slate-950/50 via-slate-900/30 to-black/80 pointer-events-none"></div>
      <div className="relative z-10">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="font-display text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">Data Sources & APIs</h2>
            <p className="text-lg text-slate-400 max-w-2xl mx-auto">
              GaiaLog gathers environmental data from trusted, authoritative sources every 10 minutes and records that data immutably on the
              blockchain.
            </p>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="glass-card p-6 animate-pulse">
                  <div className="flex items-center space-x-3 mb-4">
                    <div className="w-10 h-10 bg-slate-800 rounded-full" />
                    <div className="space-y-2">
                      <div className="h-3 w-28 bg-slate-800 rounded" />
                      <div className="h-3 w-20 bg-slate-800/60 rounded" />
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="h-3 bg-slate-800/60 rounded" />
                    <div className="h-3 bg-slate-800/60 rounded" />
                    <div className="h-3 bg-slate-800/60 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : allSources.length === 0 ? (
            <div className="text-center text-slate-400 py-12">
              Provider status is temporarily unavailable. Please check back shortly.
            </div>
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {visibleSources.map((source) => {
              const Icon = source.icon
              return (
              <GlowCard key={source.id} glowColor="purple" customSize className="h-full">
                <div className="flex items-center space-x-3 mb-4">
                  <div className="w-10 h-10 bg-slate-950/60 rounded-full flex items-center justify-center">
                    <Icon className="h-5 w-5 text-purple-300" />
                  </div>
                  <div>
                    <div className="text-white font-semibold">{source.name}</div>
                    <div className="text-sm text-slate-400 font-normal">{source.type}</div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Refresh Rate</span>
                    <div className="flex items-center space-x-1 text-sm text-white">
                      <RefreshCw className="h-3 w-3" />
                      <span>{source.refreshRate}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Coverage</span>
                    <span className="text-sm text-white">{source.coverage}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Status</span>
                    <Badge variant="secondary" className="bg-green-900/50 text-green-400 rounded-sm">
                      {source.status}
                    </Badge>
                  </div>
                </div>
              </GlowCard>
            )})}
          </div>
          )}

          {hasMore && (
            <div className="text-center mt-8">
              <button
                onClick={() => setShowAll(v => !v)}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 hover:border-slate-500 transition-colors text-sm font-medium"
              >
                {showAll ? (
                  <>Show less <ChevronUp className="h-4 w-4" /></>
                ) : (
                  <>View more ({allSources.length - PAGE_SIZE} more) <ChevronDown className="h-4 w-4" /></>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
