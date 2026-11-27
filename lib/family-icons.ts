import {
  Activity,
  AlertTriangle,
  Building2,
  Cloud,
  CloudRain,
  Compass,
  Database,
  Droplets,
  Flame,
  Gauge,
  Leaf,
  Navigation,
  Pickaxe,
  ShieldCheck,
  Sun,
  Trees,
  Waves,
  Wind,
  type LucideIcon,
} from "lucide-react"
import type { DataFamily } from "@/lib/stream-registry"

/** Icons used on the homepage verification cards and the explorer filters. */
export const FAMILY_ICONS: Record<DataFamily, LucideIcon> = {
  air_quality: Wind,
  water_levels: Waves,
  seismic_activity: Activity,
  advanced_metrics: Gauge,
  geomagnetism: Compass,
  volcanic_activity: Flame,
  space_weather: Sun,
  upper_atmosphere: Cloud,
  biodiversity: Leaf,
  conservation_status: ShieldCheck,
  hydrology: Droplets,
  flood_risk: CloudRain,
  land_use_change: Trees,
  natural_events: AlertTriangle,
  mining_activity: Pickaxe,
  transport_tracking: Navigation,
  planning_development: Building2,
}

export function familyIcon(id: string): LucideIcon {
  return FAMILY_ICONS[id as DataFamily] ?? Database
}
