"use client"

import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Database, Droplets, Activity, Cloud, RefreshCw } from "lucide-react"

export function DataSources() {
  const sources = [
    {
      name: "WAQI API",
      type: "Air Quality",
      icon: Cloud,
      refreshRate: "10 minutes",
      coverage: "Global",
      status: "operational",
    },
    {
      name: "NOAA Tides & Currents",
      type: "Water Levels",
      icon: Droplets,
      refreshRate: "10 minutes",
      coverage: "Global",
      status: "operational",
    },
    {
      name: "USGS Earthquake API",
      type: "Seismic Activity",
      icon: Activity,
      refreshRate: "10 minutes",
      coverage: "Global",
      status: "operational",
    },
    {
      name: "Environmental Monitoring",
      type: "UV, Soil, Wildfire Risk",
      icon: Database,
      refreshRate: "10 minutes",
      coverage: "Global",
      status: "operational",
    },
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {sources.map((source) => (
              <GlowCard key={source.name} glowColor="purple" customSize className="h-full">
                <div className="flex items-center space-x-3 mb-4">
                  <div className="w-10 h-10 bg-slate-950/60 rounded-full flex items-center justify-center">
                    <source.icon className="h-5 w-5 text-purple-300" />
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
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
