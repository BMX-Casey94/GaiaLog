"use client"

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react"
import { createPortal } from "react-dom"
import { Navigation } from "@/components/navigation"
import { NodeExplorerPromoBar } from "@/components/explorer/node-explorer-promo-bar"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Footer } from "@/components/sections/footer"
import { SparklesCore } from "@/components/ui/sparkles"
import { 
  Search, 
  MapPin, 
  Calendar, 
  ExternalLink, 
  Database, 
  Droplets, 
  Activity, 
  Thermometer,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  Globe,
  Hash,
  Layers
} from "lucide-react"

// Types
interface ExplorerReading {
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

interface SearchResults {
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

interface LocationSuggestion {
  location: string
  dataType: string
  readingCount: number
  lastReading: string
  coordinates: { lat: number; lon: number } | null
}

// Metric type labels, icons, and glow colours
const DATA_TYPE_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; glowColor: 'blue' | 'cyan' | 'orange' | 'purple'; accent: string }> = {
  air_quality: { label: "Air Quality", icon: Database, color: "blue", glowColor: "blue", accent: "text-blue-400" },
  water_levels: { label: "Water Levels", icon: Droplets, color: "cyan", glowColor: "cyan", accent: "text-cyan-400" },
  seismic_activity: { label: "Seismic Activity", icon: Activity, color: "orange", glowColor: "orange", accent: "text-orange-400" },
  advanced_metrics: { label: "Advanced Metrics", icon: Thermometer, color: "purple", glowColor: "purple", accent: "text-purple-400" },
}

// Format timestamp for display
function formatTimestamp(ts: string): { date: string; time: string } {
  const d = new Date(ts)
  return {
    date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  }
}

// Format metric value
function formatMetricValue(key: string, value: any): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'number') {
    if (key.includes('lat') || key.includes('lon') || key.includes('latitude') || key.includes('longitude')) {
      return value.toFixed(4)
    }
    return value.toFixed(2)
  }
  return String(value)
}

// Safely extract a numeric metric, returning null when absent
function num(metrics: Record<string, any>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = metrics[k]
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

// Convert km to miles (USGS depth arrives in km)
function kmToMiles(km: number | null): number | null {
  return km !== null ? km * 0.621371 : null
}

/**
 * Build the key metrics array for each data type.
 *
 * Field name priority: on-chain renamed field first, then original worker field.
 * - Air Quality:       renamed (air_quality_index, fine_particulate_matter_pm25 …) → originals (aqi, pm25 …)
 * - Water Levels:      no renaming – fields as-is from NOAA worker
 * - Seismic Activity:  no renaming – depth arrives in km, converted to miles
 * - Advanced Metrics:  no renaming – soil_moisture is 0-1, multiplied to %
 */
function getKeyMetrics(dataType: string, m: Record<string, any>): Array<{ label: string; value: string }> {
  switch (dataType) {
    case 'air_quality': {
      const aqi   = num(m, 'air_quality_index', 'aqi')
      const pm25  = num(m, 'fine_particulate_matter_pm25', 'pm25')
      const pm10  = num(m, 'coarse_particulate_matter_pm10', 'pm10')
      const co    = num(m, 'carbon_monoxide', 'co')
      const no2   = num(m, 'nitrogen_dioxide', 'no2')
      const o3    = num(m, 'ozone', 'o3')
      return [
        aqi  !== null ? { label: 'AQI',  value: aqi.toFixed(0) } : null,
        pm25 !== null ? { label: 'PM2.5', value: `${pm25.toFixed(1)} µg/m³` } : null,
        pm10 !== null ? { label: 'PM10',  value: `${pm10.toFixed(1)} µg/m³` } : null,
        co   !== null ? { label: 'CO',    value: co.toFixed(2) } : null,
        no2  !== null ? { label: 'NO₂',   value: no2.toFixed(2) } : null,
        o3   !== null ? { label: 'O₃',    value: o3.toFixed(2) } : null,
      ].filter(Boolean) as Array<{ label: string; value: string }>
    }

    case 'water_levels': {
      const level    = num(m, 'river_level', 'sea_level', 'level')
      const tide     = num(m, 'tide_height')
      const temp     = num(m, 'water_temperature_c')
      const salinity = num(m, 'salinity_psu')
      const doVal    = num(m, 'dissolved_oxygen_mg_l')
      const turb     = num(m, 'turbidity_ntu')
      return [
        level    !== null ? { label: 'Level',    value: `${level.toFixed(2)} m` } : null,
        tide     !== null ? { label: 'Tide',     value: `${tide.toFixed(2)} m` } : null,
        temp     !== null ? { label: 'Temp',     value: `${temp.toFixed(1)} °C` } : null,
        salinity !== null ? { label: 'Salinity', value: `${salinity.toFixed(1)} PSU` } : null,
        doVal    !== null ? { label: 'DO',       value: `${doVal.toFixed(1)} mg/L` } : null,
        turb     !== null ? { label: 'Turbidity', value: `${turb.toFixed(1)} NTU` } : null,
      ].filter(Boolean) as Array<{ label: string; value: string }>
    }

    case 'seismic_activity': {
      const mag      = num(m, 'magnitude')
      const depthKm  = num(m, 'depth')
      const depthMi  = kmToMiles(depthKm)
      const lat      = num(m, 'latitude', 'lat')
      const lon      = num(m, 'longitude', 'lon')
      return [
        mag     !== null ? { label: 'Magnitude', value: `${mag.toFixed(1)} M` } : null,
        depthMi !== null ? { label: 'Depth',     value: `${depthMi.toFixed(1)} mi` } : null,
        lat     !== null ? { label: 'Latitude',  value: lat.toFixed(4) } : null,
        lon     !== null ? { label: 'Longitude', value: lon.toFixed(4) } : null,
      ].filter(Boolean) as Array<{ label: string; value: string }>
    }

    case 'advanced_metrics': {
      const uv        = num(m, 'uv_index')
      // soil_moisture arrives as 0-1 fraction; convert to percentage
      const soilRaw   = num(m, 'soil_moisture_pct', 'soil_moisture')
      const soilPct   = soilRaw !== null ? (soilRaw <= 1 ? soilRaw * 100 : soilRaw) : null
      const wildfire   = num(m, 'wildfire_risk')
      const envScore   = num(m, 'environmental_quality_score', 'environmental_score')
      const temp       = num(m, 'temperature_c')
      const humidity   = num(m, 'humidity_pct')
      return [
        uv       !== null ? { label: 'UV Index',      value: uv.toFixed(1) } : null,
        soilPct  !== null ? { label: 'Soil Moisture',  value: `${soilPct.toFixed(0)}%` } : null,
        wildfire !== null ? { label: 'Wildfire Risk',  value: `${wildfire.toFixed(0)}/10` } : null,
        envScore !== null ? { label: 'Env Score',      value: `${envScore.toFixed(0)}/100` } : null,
        temp     !== null ? { label: 'Temp',           value: `${temp.toFixed(1)} °C` } : null,
        humidity !== null ? { label: 'Humidity',       value: `${humidity.toFixed(0)}%` } : null,
      ].filter(Boolean) as Array<{ label: string; value: string }>
    }

    default:
      return Object.entries(m)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
        .slice(0, 6)
        .map(([k, v]) => ({
          label: k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          value: formatMetricValue(k, v)
        }))
  }
}

export default function ExplorerPage() {
  // Search state
  const [searchQuery, setSearchQuery] = useState("")
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const inputWrapperRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties | null>(null)
  const repositionRafRef = useRef<number | null>(null)
  const suppressAutoSearchUntilRef = useRef<number>(0)
  
  // Filter state
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [showFilters, setShowFilters] = useState(false)
  
  // Results state
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  
  // Stats state
  const [stats, setStats] = useState<any>(null)
  
  // Fetch location suggestions
  const fetchSuggestions = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSuggestions([])
      return
    }
    
    try {
      const res = await fetch(`/api/explorer/locations?q=${encodeURIComponent(query)}&limit=10`)
      const data = await res.json()
      if (data.success) {
        setSuggestions(data.data.suggestions)
      }
    } catch (e) {
      console.error('Failed to fetch suggestions:', e)
    }
  }, [])
  
  // Debounce suggestions
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSuggestions(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, fetchSuggestions])
  
  // Click outside to close suggestions
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node
      const inSearch = !!searchRef.current && searchRef.current.contains(target)
      const inDropdown = !!dropdownRef.current && dropdownRef.current.contains(target)
      if (!inSearch && !inDropdown) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Position suggestions dropdown above other sections (avoid overflow clipping)
  const repositionDropdown = useCallback(() => {
    if (!inputWrapperRef.current) return
    const rect = inputWrapperRef.current.getBoundingClientRect()
    const gap = 8
    const viewportH = window.innerHeight
    const spaceBelow = viewportH - rect.bottom - gap
    const spaceAbove = rect.top - gap

    // Prefer opening below; flip above when there's clearly more space up top.
    const openUp = spaceBelow < 220 && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, Math.min(360, (openUp ? spaceAbove : spaceBelow) - 16))

    const style: React.CSSProperties = {
      left: Math.max(8, rect.left),
      width: rect.width,
      maxHeight,
    }

    if (openUp) {
      // anchor to the top edge of the input wrapper
      style.bottom = Math.max(8, viewportH - rect.top + gap)
      style.top = 'auto'
    } else {
      style.top = Math.max(8, rect.bottom + gap)
      style.bottom = 'auto'
    }

    setDropdownStyle(prev => {
      // Avoid forcing re-renders on every scroll tick unless something changed
      const same =
        prev &&
        prev.left === style.left &&
        prev.top === style.top &&
        prev.bottom === style.bottom &&
        prev.width === style.width &&
        prev.maxHeight === style.maxHeight
      return same ? prev : style
    })
  }, [])

  const scheduleReposition = useCallback(() => {
    if (repositionRafRef.current !== null) return
    repositionRafRef.current = window.requestAnimationFrame(() => {
      repositionRafRef.current = null
      repositionDropdown()
    })
  }, [repositionDropdown])

  useLayoutEffect(() => {
    if (!showSuggestions || suggestions.length === 0) {
      setDropdownStyle(null)
      return
    }

    scheduleReposition()

    // capture scroll from any container
    const onScroll = () => scheduleReposition()
    const onResize = () => scheduleReposition()
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      if (repositionRafRef.current !== null) {
        window.cancelAnimationFrame(repositionRafRef.current)
        repositionRafRef.current = null
      }
    }
  }, [showSuggestions, suggestions.length, scheduleReposition])
  
  // Search function – accepts an optional explicit query so callers (e.g.
  // suggestion clicks) can bypass the stale-closure problem where React hasn't
  // flushed the new searchQuery state yet.
  const handleSearch = useCallback(async (
    pageNum: number = 1,
    queryOverride?: string,
    opts?: { closeSuggestions?: boolean }
  ) => {
    setLoading(true)
    setError(null)
    if (opts?.closeSuggestions ?? true) setShowSuggestions(false)
    
    try {
      const q = queryOverride !== undefined ? queryOverride : searchQuery
      const params = new URLSearchParams()
      if (q) params.set('q', q)
      if (selectedType) params.set('type', selectedType)
      if (dateFrom) params.set('from', new Date(dateFrom).toISOString())
      if (dateTo) params.set('to', new Date(dateTo).toISOString())
      params.set('page', String(pageNum))
      params.set('pageSize', '24')
      
      const res = await fetch(`/api/explorer/search?${params}`)
      const data = await res.json()
      
      if (data.success) {
        setResults(data.data)
        setPage(pageNum)
      } else {
        setError(data.error || 'Search failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [searchQuery, selectedType, dateFrom, dateTo])
  
  // Fetch stats on mount
  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch('/api/explorer/stats')
        const data = await res.json()
        if (data.success) {
          setStats(data.data)
        }
      } catch (e) {
        console.error('Failed to fetch stats:', e)
      }
    }
    fetchStats()
  }, [])
  
  // Initial search on mount
  const mountedRef = useRef(false)
  useEffect(() => {
    handleSearch(1)
    mountedRef.current = true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-search when filters change (skip initial mount)
  useEffect(() => {
    if (!mountedRef.current) return
    handleSearch(1)
  }, [selectedType, dateFrom, dateTo]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-search when query changes (debounced, skip initial mount)
  useEffect(() => {
    if (!mountedRef.current) return
    if (Date.now() < suppressAutoSearchUntilRef.current) return

    const q = searchQuery.trim()
    // Avoid hammering the API for single-character partials.
    if (q.length === 1) return

    const timer = window.setTimeout(() => {
      if (Date.now() < suppressAutoSearchUntilRef.current) return
      // Keep suggestions open while auto-searching.
      handleSearch(1, undefined, { closeSuggestions: false })
    }, 450)

    return () => window.clearTimeout(timer)
  }, [searchQuery]) // eslint-disable-line react-hooks/exhaustive-deps
  
  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-950 to-black pt-0 pb-44 sm:pb-28">
      <Navigation />
      
      {/* ─── Hero Section (matches home page style) ─── */}
      <section className="relative overflow-hidden pt-32 pb-16 px-4 sm:px-6 lg:px-8">
        {/* Background radial gradient + sparkles */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at center, rgba(88, 28, 135, 0.35) 0%, rgba(59, 7, 100, 0.2) 40%, rgba(4, 2, 8, 1) 75%)`,
          }}
        >
          <div className="opacity-20">
            <SparklesCore
              id="explorer-sparkles"
              background="transparent"
              minSize={0.4}
              maxSize={1.2}
              particleDensity={60}
              className="w-full h-full"
              particleColor="#FFFFFF"
              speed={0.8}
            />
          </div>
        </div>
        
        <div className="relative max-w-7xl mx-auto z-10">
          {/* Heading */}
          <div className="text-center mb-10">
            <h1 className="text-4xl md:text-6xl font-bold text-white mb-4">
              Data Explorer
            </h1>
            <p className="text-sm md:text-lg text-slate-300 mb-2 max-w-3xl mx-auto leading-relaxed">
              Search and explore environmental data recorded immutably on the BSV blockchain.
            </p>
            <p className="hidden md:block text-base text-slate-400 max-w-4xl mx-auto">
              Every reading is verifiable on-chain. Filter by location, data type, or date range.
            </p>
          </div>
          
          {/* Stats bar (glass-morphism, matches hero dashboard) */}
          {stats && (
            <div className="max-w-3xl mx-auto mb-10">
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 text-center">
                  <div className="flex items-center justify-center space-x-2 mb-1">
                    <Hash className="h-4 w-4 text-purple-400" />
                    <span className="text-sm text-slate-300">Readings</span>
                  </div>
                  <div className="text-2xl font-bold text-white">
                    {(stats.totalReadings ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 text-center">
                  <div className="flex items-center justify-center space-x-2 mb-1">
                    <MapPin className="h-4 w-4 text-cyan-400" />
                    <span className="text-sm text-slate-300">Locations</span>
                  </div>
                  <div className="text-2xl font-bold text-white">
                    {(stats.uniqueLocations ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="bg-transparent backdrop-blur-sm rounded-lg p-4 border border-slate-600/30 text-center">
                  <div className="flex items-center justify-center space-x-2 mb-1">
                    <Globe className="h-4 w-4 text-green-400" />
                    <span className="text-sm text-slate-300">Network</span>
                  </div>
                  <div className="text-2xl font-bold text-green-400 capitalize">
                    {stats.network || 'testnet'}
                  </div>
                </div>
              </div>
            </div>
          )}
          
          {/* Search Bar (glass-morphism) */}
          <div ref={searchRef} className="relative max-w-2xl mx-auto mb-8">
            <div ref={inputWrapperRef} className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400 z-10" />
              <Input
                type="text"
                placeholder="Search by location (e.g. London, New York, Tokyo...)"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  setShowSuggestions(true)
                }}
                onFocus={() => setShowSuggestions(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    suppressAutoSearchUntilRef.current = Date.now() + 900
                    handleSearch(1, undefined, { closeSuggestions: true })
                  }
                }}
                className="w-full h-14 pl-12 pr-12 text-lg bg-black/40 backdrop-blur-sm border-slate-600/40 text-white placeholder:text-slate-500 focus:border-purple-500 rounded-xl"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white z-10"
                >
                  <X className="h-5 w-5" />
                </button>
              )}
            </div>
            
            {/* Suggestions Dropdown */}
            {showSuggestions && suggestions.length > 0 && dropdownStyle && typeof document !== 'undefined' && createPortal(
              <div
                ref={dropdownRef}
                style={dropdownStyle}
                className="fixed z-[10000] bg-slate-900/95 backdrop-blur-md border border-slate-700/60 rounded-xl shadow-2xl overflow-y-auto overscroll-contain"
              >
                {suggestions.map((s, i) => (
                  <button
                    key={`${s.location}-${s.dataType}-${i}`}
                    onClick={() => {
                      setSearchQuery(s.location)
                      setShowSuggestions(false)
                      suppressAutoSearchUntilRef.current = Date.now() + 900
                      // Pass the location explicitly — React hasn't flushed
                      // the setSearchQuery state yet, so the closure still
                      // holds the old partial text.
                      handleSearch(1, s.location, { closeSuggestions: true })
                    }}
                    className="w-full px-4 py-3 flex items-center gap-4 hover:bg-slate-800/60 text-left transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <MapPin className="h-4 w-4 text-purple-400 flex-shrink-0" />
                      <span className="text-white truncate">{s.location}</span>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <Badge variant="secondary" className="bg-slate-800/80 text-slate-300 text-xs">
                        {DATA_TYPE_CONFIG[s.dataType]?.label || s.dataType}
                      </Badge>
                      <span className="text-xs text-slate-500 whitespace-nowrap">{s.readingCount} readings</span>
                    </div>
                  </button>
                ))}
              </div>,
              document.body
            )}
          </div>
          
          {/* Filters */}
          <div className="flex flex-wrap justify-center gap-3 mb-6">
            <Button
              variant={selectedType === null ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedType(null)}
              variant={selectedType === null ? "purple" : "outline"}
              className={selectedType === null 
                ? "" 
                : "border-slate-600/50 text-slate-300 hover:bg-slate-800/40 bg-transparent backdrop-blur-sm"}
            >
              <Layers className="h-4 w-4 mr-1.5" />
              All Types
            </Button>
            {Object.entries(DATA_TYPE_CONFIG).map(([key, config]) => {
              const Icon = config.icon
              return (
                <Button
                  key={key}
                  variant={selectedType === key ? "purple" : "outline"}
                  size="sm"
                  onClick={() => setSelectedType(selectedType === key ? null : key)}
                  className={selectedType === key 
                    ? "" 
                    : "border-slate-600/50 text-slate-300 hover:bg-slate-800/40 bg-transparent backdrop-blur-sm"}
                >
                  <Icon className="h-4 w-4 mr-1.5" />
                  {config.label}
                </Button>
              )
            })}
            <Button
              variant={showFilters ? "purple" : "outline"}
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
              className={showFilters ? "" : "border-slate-600/50 text-slate-300 hover:bg-slate-800/40 bg-transparent backdrop-blur-sm"}
            >
              <Filter className="h-4 w-4 mr-1.5" />
              Date Range
            </Button>
          </div>
          
          {/* Date Range Filters */}
          {showFilters && (
            <div className="flex flex-wrap justify-center gap-4 mb-6 animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="flex items-center gap-2 bg-black/30 backdrop-blur-sm border border-slate-600/30 rounded-lg px-4 py-2">
                <Calendar className="h-4 w-4 text-slate-400" />
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-40 bg-transparent border-none text-white p-0 h-auto focus-visible:ring-0"
                />
                <span className="text-slate-500">to</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-40 bg-transparent border-none text-white p-0 h-auto focus-visible:ring-0"
                />
              </div>
              {(dateFrom || dateTo) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setDateFrom(''); setDateTo(''); }}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Clear Dates
                </Button>
              )}
            </div>
          )}

          {/* Results summary (kept close to filters) */}
          <div className="text-center">
            {loading && (
              <div className="inline-flex items-center gap-2 text-slate-400 text-sm">
                <div className="h-3 w-3 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
                Searching...
              </div>
            )}

            {results && !error && !loading && (
              <p className="text-slate-400 text-sm md:text-base mt-2">
                Found <span className="text-white font-semibold">{results.pagination.total.toLocaleString()}</span> readings
                {searchQuery && <> matching <span className="text-purple-400">&quot;{searchQuery}&quot;</span></>}
                {selectedType && <> of type <span className="text-purple-400">{DATA_TYPE_CONFIG[selectedType]?.label || selectedType}</span></>}
              </p>
            )}
          </div>
        </div>
      </section>
      
      {/* ─── Results Section ─── */}
      <section className="pt-8 pb-16 px-4 sm:px-6 lg:px-8 relative">
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/50 via-slate-900/30 to-black/80 pointer-events-none" />
        <div className="relative max-w-7xl mx-auto">
          {/* Error */}
          {error && (
            <div className="text-center py-8">
              <div className="inline-flex items-center gap-2 bg-red-900/20 border border-red-800/30 rounded-lg px-4 py-3 text-red-400 mb-4">
                {error}
              </div>
              <div>
                <Button onClick={() => handleSearch(1)} variant="outline" className="border-slate-600/50 text-slate-300 hover:bg-slate-800 bg-transparent">
                  Try Again
                </Button>
              </div>
            </div>
          )}
          
          {/* Loading overlay (shown during subsequent searches when results already exist) */}
          {loading && results && (
            <div className="flex justify-center items-center py-16">
              <div className="flex flex-col items-center gap-4">
                <div className="animate-spin h-10 w-10 border-4 border-purple-500/30 border-t-purple-500 rounded-full" />
                <p className="text-slate-400 text-sm">Loading results...</p>
              </div>
            </div>
          )}

          {/* Results Grid */}
          {results && results.items.length > 0 && !loading && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 mb-12">
                {results.items.map((item) => {
                  const config = DATA_TYPE_CONFIG[item.dataType] || { label: item.dataType, icon: Database, color: 'purple', glowColor: 'purple' as const, accent: 'text-purple-400' }
                  const Icon = config.icon
                  const { date, time } = formatTimestamp(item.timestamp)
                  const keyMetrics = getKeyMetrics(item.dataType, item.metrics)
                  
                  return (
                    <GlowCard 
                      key={item.txid} 
                      glowColor={config.glowColor}
                      customSize 
                      className="flex flex-col"
                    >
                      {/* Card Header Bar (matches live-dashboard cards) */}
                      <div className="flex items-center justify-center space-x-2 -mx-4 -mt-4 px-4 py-3 bg-slate-800/60 border-b border-slate-700/50 rounded-t-2xl">
                        <Icon className={`h-4 w-4 ${config.accent}`} />
                        <span className={`font-semibold text-sm ${config.accent}`}>{config.label}</span>
                      </div>

                      {/* Location & Time */}
                      <div className="pt-3 pb-2">
                        {item.location ? (
                          <div className="flex items-start gap-2 text-white mb-1.5 min-w-0">
                            <MapPin className="h-3.5 w-3.5 text-purple-400 flex-shrink-0 mt-0.5" />
                            <span className="font-medium text-sm flex-1 min-w-0 line-clamp-2">{item.location}</span>
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
                      
                      {/* Metrics Grid */}
                      <div className="flex-1">
                        <div className="grid grid-cols-2 gap-1.5">
                          {keyMetrics.slice(0, 6).map((metric, i) => (
                            <div key={i} className="bg-slate-900/60 rounded-lg px-2.5 py-1.5">
                              <div className="text-[10px] text-slate-500 uppercase tracking-wider">{metric.label}</div>
                              <div className="text-xs font-medium text-white truncate">{metric.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      {/* Card Footer Bar (matches live-dashboard cards) */}
                      <div className="flex items-center justify-between -mx-4 -mb-4 px-4 py-2.5 border-t border-slate-700/30">
                        <span className="text-[10px] text-slate-600 font-mono">
                          {item.txid.slice(0, 8)}...{item.txid.slice(-6)}
                        </span>
                        {item.blockHeight > 0 ? (
                          <a
                            href={item.wocUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                          >
                            View TX
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span
                            className="flex items-center gap-1 text-xs text-slate-500"
                            title="Transaction is pending confirmation/indexing. If it was just broadcast, it can take a few minutes to appear on explorers."
                          >
                            Pending
                          </span>
                        )}
                      </div>
                    </GlowCard>
                  )
                })}
              </div>
              
              {/* Pagination */}
              {results.pagination.totalPages > 1 && (
                <div className="flex justify-center items-center gap-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleSearch(page - 1)}
                    disabled={page <= 1 || loading}
                    className="border-slate-600/50 text-slate-300 hover:bg-slate-800 bg-transparent"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="text-slate-500">Page</span>
                    <span className="text-white font-semibold">{page}</span>
                    <span className="text-slate-500">of</span>
                    <span className="text-white font-semibold">{results.pagination.totalPages}</span>
                  </div>
                  
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleSearch(page + 1)}
                    disabled={!results.pagination.hasMore || loading}
                    className="border-slate-600/50 text-slate-300 hover:bg-slate-800 bg-transparent"
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              )}
            </>
          )}
          
          {/* No Results (only show after loading completes) */}
          {results && results.items.length === 0 && !loading && !error && (
            <div className="text-center py-20">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-slate-800/50 border border-slate-700/40 mb-6">
                <Globe className="h-10 w-10 text-slate-600" />
              </div>
              <h3 className="text-xl font-semibold text-white mb-2">No Results Found</h3>
              <p className="text-slate-400 mb-8 max-w-md mx-auto">
                {searchQuery 
                  ? `No readings matching "${searchQuery}" were found. Try a different location or adjust your filters.`
                  : 'No readings have been indexed yet. Readings appear here automatically as transactions are broadcast.'}
              </p>
              <Button
                onClick={() => {
                  setSearchQuery('')
                  setSelectedType(null)
                  setDateFrom('')
                  setDateTo('')
                  handleSearch(1)
                }}
                variant="outline"
                className="border-slate-600/50 text-slate-300 hover:bg-slate-800 bg-transparent"
              >
                Clear All Filters
              </Button>
            </div>
          )}
          
          {/* Loading State */}
          {loading && !results && (
            <div className="text-center py-20">
              <div className="inline-flex items-center justify-center w-16 h-16 mb-6">
                <div className="animate-spin h-12 w-12 border-4 border-purple-500/30 border-t-purple-500 rounded-full" />
              </div>
              <p className="text-slate-400">Searching the blockchain...</p>
            </div>
          )}
        </div>
      </section>
      
      <Footer />
      <NodeExplorerPromoBar />
    </div>
  )
}
