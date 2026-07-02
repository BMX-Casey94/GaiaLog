"use client"

import { Hash, MapPin, Globe } from "lucide-react"
import type { ExplorerStats } from "./explorer-types"

export function StatsBar({ stats }: { stats: ExplorerStats }) {
  return (
    <div className="max-w-3xl mx-auto mb-10">
      <div className="grid grid-cols-3 gap-4">
        <div className="glass-card p-4 text-center">
          <div className="flex items-center justify-center space-x-2 mb-1">
            <Hash className="h-4 w-4 text-purple-400" />
            <span className="text-sm text-slate-300">Readings</span>
          </div>
          <div className="text-2xl font-bold text-white">
            {(stats.totalReadings ?? 0).toLocaleString('en-GB')}
          </div>
        </div>
        <div className="glass-card p-4 text-center">
          <div className="flex items-center justify-center space-x-2 mb-1">
            <MapPin className="h-4 w-4 text-cyan-400" />
            <span className="text-sm text-slate-300">Locations</span>
          </div>
          <div className="text-2xl font-bold text-white">
            {typeof stats.uniqueLocations === 'number'
              ? stats.uniqueLocations.toLocaleString('en-GB')
              : '...'}
          </div>
        </div>
        <div className="glass-card p-4 text-center">
          <div className="flex items-center justify-center space-x-2 mb-1">
            <Globe className="h-4 w-4 text-green-400" />
            <span className="text-sm text-slate-300">Network</span>
          </div>
          <div className="text-2xl font-bold text-green-400 capitalize">
            {stats.network || 'mainnet'}
          </div>
        </div>
      </div>
    </div>
  )
}
