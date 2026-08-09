"use client"

import { Hash, MapPin, Globe } from "lucide-react"
import type { ExplorerStats } from "./explorer-types"

function formatFull(n: number): string {
  return n.toLocaleString("en-GB")
}

/** Compact form for narrow cards (e.g. 5.4M) so long totals do not overflow. */
function formatCompact(n: number): string {
  return new Intl.NumberFormat("en-GB", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n)
}

function StatValue({
  value,
  className = "text-white",
}: {
  value: number | null
  className?: string
}) {
  if (value == null) {
    return (
      <div className={`font-bold tabular-nums leading-tight ${className} text-sm sm:text-xl md:text-2xl`}>
        …
      </div>
    )
  }

  return (
    <div
      className={`font-bold tabular-nums leading-tight tracking-tight ${className} text-sm sm:text-xl md:text-2xl min-w-0`}
      title={formatFull(value)}
    >
      <span className="sm:hidden">{formatCompact(value)}</span>
      <span className="hidden sm:inline">{formatFull(value)}</span>
    </div>
  )
}

export function StatsBar({ stats }: { stats: ExplorerStats }) {
  return (
    <div className="max-w-3xl mx-auto mb-6 sm:mb-10 px-0">
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <div className="glass-card px-2 py-2.5 sm:p-4 text-center min-w-0 overflow-hidden">
          <div className="flex items-center justify-center gap-1 sm:gap-2 mb-0.5 sm:mb-1 min-w-0">
            <Hash className="h-3 w-3 sm:h-4 sm:w-4 text-purple-400 shrink-0" />
            <span className="text-[10px] sm:text-sm text-slate-300 truncate">Readings</span>
          </div>
          <StatValue value={stats.totalReadings ?? 0} />
        </div>
        <div className="glass-card px-2 py-2.5 sm:p-4 text-center min-w-0 overflow-hidden">
          <div className="flex items-center justify-center gap-1 sm:gap-2 mb-0.5 sm:mb-1 min-w-0">
            <MapPin className="h-3 w-3 sm:h-4 sm:w-4 text-cyan-400 shrink-0" />
            <span className="text-[10px] sm:text-sm text-slate-300 truncate">Locations</span>
          </div>
          <StatValue
            value={typeof stats.uniqueLocations === "number" ? stats.uniqueLocations : null}
          />
        </div>
        <div className="glass-card px-2 py-2.5 sm:p-4 text-center min-w-0 overflow-hidden">
          <div className="flex items-center justify-center gap-1 sm:gap-2 mb-0.5 sm:mb-1 min-w-0">
            <Globe className="h-3 w-3 sm:h-4 sm:w-4 text-green-400 shrink-0" />
            <span className="text-[10px] sm:text-sm text-slate-300 truncate">Network</span>
          </div>
          <div className="text-sm sm:text-xl md:text-2xl font-bold text-green-400 capitalize leading-tight truncate">
            {stats.network || "mainnet"}
          </div>
        </div>
      </div>
    </div>
  )
}
