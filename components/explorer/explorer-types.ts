import type React from "react"
import {
  Database,
  Droplets,
  Activity,
  Thermometer,
  Globe,
  Layers,
} from "lucide-react"
import { DATA_FAMILY_DESCRIPTORS } from "@/lib/stream-registry"

export interface ExplorerReading {
  txid: string
  dataType: string
  location: string | null
  lat: number | null
  lon: number | null
  timestamp: string
  metrics: Record<string, any>
  provider: string | null
  blockHeight: number
  wocUrl: string
}

export interface SearchResults {
  items: ExplorerReading[]
  pagination: {
    page: number
    pageSize: number
    total: number
    hasMore: boolean
    totalPages: number
  }
  aggregates: {
    totalReadings: number
    uniqueLocations: number
    dateRange: { min: string | null; max: string | null }
    byType: Record<string, number>
  }
}

export interface LocationSuggestion {
  location: string
  dataType: string
  readingCount: number
}

export interface ExplorerStats {
  totalReadings: number
  uniqueLocations: number | null
  network: string
}

const FAMILY_ICON_MAP: Record<string, React.ElementType> = {
  Database,
  Droplets,
  Activity,
  Thermometer,
  Magnet: Globe,
  Mountain: Layers,
  Orbit: Globe,
  Cloud: Globe,
}

export interface DataTypeConfig {
  label: string
  icon: React.ElementType
  color: string
  glowColor: 'blue' | 'purple' | 'green' | 'red' | 'orange' | 'cyan'
  accent: string
}

export const DATA_TYPE_CONFIG: Record<string, DataTypeConfig> = Object.fromEntries(
  Object.entries(DATA_FAMILY_DESCRIPTORS).map(([key, descriptor]) => [
    key,
    {
      label: descriptor.label,
      icon: FAMILY_ICON_MAP[descriptor.icon] || Database,
      color: descriptor.color === 'emerald' ? 'green' : descriptor.color === 'rose' ? 'red' : descriptor.color === 'indigo' ? 'purple' : descriptor.color === 'sky' ? 'cyan' : descriptor.color,
      glowColor: descriptor.glowColor === 'blue' || descriptor.glowColor === 'purple' || descriptor.glowColor === 'green' || descriptor.glowColor === 'red' || descriptor.glowColor === 'orange' || descriptor.glowColor === 'cyan'
        ? descriptor.glowColor
        : 'purple',
      accent: descriptor.accent,
    },
  ]),
)

export function formatTimestamp(ts: string): { date: string; time: string } {
  const d = new Date(ts)
  return {
    date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  }
}
