"use client"

import { GlowCard } from "@/components/ui/spotlight-card"
import { MapPin, ExternalLink, Database } from "lucide-react"
import { getKeyMetrics } from "@/lib/family-metrics"
import { DATA_TYPE_CONFIG, formatTimestamp, type ExplorerReading } from "./explorer-types"

export function ReadingCard({ item }: { item: ExplorerReading }) {
  const config = DATA_TYPE_CONFIG[item.dataType] || {
    label: item.dataType,
    icon: Database,
    color: 'purple',
    glowColor: 'purple' as const,
    accent: 'text-purple-400',
  }
  const Icon = config.icon
  const { date, time } = formatTimestamp(item.timestamp)
  const keyMetrics = getKeyMetrics(item.dataType, item.metrics)

  let displayLocation = item.location
  if (displayLocation && /^Sensor\s+\d+/i.test(displayLocation) && item.lat != null && item.lon != null) {
    const latDir = item.lat >= 0 ? 'N' : 'S'
    const lonDir = item.lon >= 0 ? 'E' : 'W'
    const country = displayLocation.replace(/^Sensor\s+\d+\s*/i, '').trim()
    displayLocation = country
      ? `${country} (${Math.abs(item.lat).toFixed(2)}°${latDir}, ${Math.abs(item.lon).toFixed(2)}°${lonDir})`
      : `${Math.abs(item.lat).toFixed(2)}°${latDir}, ${Math.abs(item.lon).toFixed(2)}°${lonDir}`
  }

  return (
    <GlowCard glowColor={config.glowColor} customSize className="h-full min-h-[280px]">
      <div className="shrink-0 flex items-center justify-center gap-2 -mx-4 -mt-4 px-4 py-2.5 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
        <Icon className={`h-4 w-4 ${config.accent}`} />
        <span className={`font-semibold text-sm ${config.accent}`}>{config.label}</span>
      </div>

      <div className="flex-1 flex flex-col justify-center min-h-0 gap-3 py-1">
        <div>
          {displayLocation ? (
            <div className="flex items-start gap-2 text-white mb-1.5 min-w-0">
              <MapPin className="h-3.5 w-3.5 text-purple-400 flex-shrink-0 mt-0.5" />
              <span className="font-medium text-sm flex-1 min-w-0 line-clamp-2">{displayLocation}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-slate-500 mb-1.5">
              <MapPin className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="text-sm italic">Unknown location</span>
            </div>
          )}
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>{date}</span>
            <span className="text-slate-700">|</span>
            <span>{time}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {keyMetrics.slice(0, 6).map((metric, i) => (
            <div key={i} className="bg-slate-900/60 rounded-lg px-2.5 py-1.5">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">{metric.label}</div>
              <div className="text-xs font-medium text-white truncate">{metric.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 flex items-center justify-between gap-2 -mx-4 -mb-4 px-4 py-2.5 border-t border-slate-700/30">
        <span className="text-[10px] text-slate-600 font-mono min-w-0 truncate">
          {item.txid.slice(0, 8)}...{item.txid.slice(-6)}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {!(item.confirmed || item.blockHeight > 0) && (
            <span
              className="text-[10px] uppercase tracking-wide text-slate-500"
              title="Broadcast accepted; awaiting first block confirmation."
            >
              Unconfirmed
            </span>
          )}
          <a
            href={item.wocUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors"
          >
            View TX
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </GlowCard>
  )
}

export function ReadingCardSkeleton() {
  return (
    <div className="glass-card p-4 animate-pulse flex flex-col h-full min-h-[280px]">
      <div className="shrink-0 flex items-center justify-center -mx-4 -mt-4 px-4 py-2.5 bg-slate-800/40 border-b border-slate-700/40 rounded-t-2xl">
        <div className="h-4 w-28 bg-slate-700/60 rounded" />
      </div>
      <div className="flex-1 flex flex-col justify-center min-h-0 gap-3 py-1">
        <div className="space-y-2">
          <div className="h-4 w-3/4 bg-slate-800 rounded" />
          <div className="h-3 w-1/2 bg-slate-800/60 rounded" />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 bg-slate-900/60 rounded-lg" />
          ))}
        </div>
      </div>
      <div className="shrink-0 flex items-center justify-between -mx-4 -mb-4 px-4 py-2.5 border-t border-slate-700/30">
        <div className="h-3 w-24 bg-slate-800/60 rounded" />
        <div className="h-3 w-14 bg-slate-800/60 rounded" />
      </div>
    </div>
  )
}
