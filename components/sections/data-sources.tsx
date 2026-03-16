"use client"

import { useState, useEffect } from "react"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Database, Droplets, Activity, Cloud, RefreshCw } from "lucide-react"
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

export function DataSources() {
  const [sources, setSources] = useState<ProviderSource[]>([])
  const [loading, setLoading] = useState(true)

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

  const displaySources = sources.length > 0 ? sources : [
    { id: 'waqi', name: 'WAQI API', type: 'Air Quality', icon: Cloud, refreshRate: '10 min', coverage: 'Global', status: 'operational' },
    { id: 'noaa', name: 'NOAA Tides & Currents', type: 'Water Levels', icon: Droplets, refreshRate: '10 min', coverage: 'Global', status: 'operational' },
    { id: 'usgs', name: 'USGS Earthquake API', type: 'Seismic Activity', icon: Activity, refreshRate: '10 min', coverage: 'Global', status: 'operational' },
    { id: 'env', name: 'Environmental Monitoring', type: 'UV, Soil, Wildfire Risk', icon: Database, refreshRate: '10 min', coverage: 'Global', status: 'operational' },
  ]

  return (
    <section id="data-sources" className="py-20 px-4 sm:px-6 lg:px-8 relative scroll-mt-24">
      <div className="absolute inset-0 bg-gradient-to-b from-slate-950/50 via-slate-900/30 to-black/80 pointer-events-none"></div>
      <div className="relative z-10">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Data Sources & APIs</h2>
            <p className="text-lg text-slate-400 max-w-2xl mx-auto">
              GaiaLog gathers environmental data from trusted, authoritative sources every 10 minutes and records that data immutably on the
              blockchain.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {displaySources.map((source) => {
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
        </div>
      </div>
    </section>
  )
}
