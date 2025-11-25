"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Navigation } from "@/components/navigation"
import { GlowCard } from "@/components/ui/spotlight-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Footer } from "@/components/sections/footer"
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
  Clock,
  Hash
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

// Metric type labels and icons
const DATA_TYPE_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  air_quality: { label: "Air Quality", icon: Database, color: "blue" },
  water_levels: { label: "Water Levels", icon: Droplets, color: "cyan" },
  seismic_activity: { label: "Seismic Activity", icon: Activity, color: "orange" },
  advanced_metrics: { label: "Advanced Metrics", icon: Thermometer, color: "purple" },
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

// Get key metrics for each data type
function getKeyMetrics(dataType: string, metrics: Record<string, any>): Array<{ label: string; value: string }> {
  switch (dataType) {
    case 'air_quality':
      return [
        { label: 'AQI', value: formatMetricValue('aqi', metrics.air_quality_index ?? metrics.aqi) },
        { label: 'PM2.5', value: `${formatMetricValue('pm25', metrics.fine_particulate_matter_pm25 ?? metrics.pm25)} µg/m³` },
        { label: 'PM10', value: `${formatMetricValue('pm10', metrics.coarse_particulate_matter_pm10 ?? metrics.pm10)} µg/m³` },
        { label: 'CO', value: formatMetricValue('co', metrics.carbon_monoxide ?? metrics.co) },
        { label: 'NO₂', value: formatMetricValue('no2', metrics.nitrogen_dioxide ?? metrics.no2) },
        { label: 'O₃', value: formatMetricValue('o3', metrics.ozone ?? metrics.o3) },
      ].filter(m => m.value !== '-' && m.value !== 'undefined µg/m³')
      
    case 'water_levels':
      return [
        { label: 'Level', value: `${formatMetricValue('level', metrics.river_level ?? metrics.sea_level ?? metrics.level)} m` },
        { label: 'Tide', value: `${formatMetricValue('tide', metrics.tide_height)} m` },
        { label: 'Temp', value: `${formatMetricValue('temp', metrics.water_temperature_c)} °C` },
        { label: 'Salinity', value: `${formatMetricValue('sal', metrics.salinity_psu)} PSU` },
        { label: 'DO', value: `${formatMetricValue('do', metrics.dissolved_oxygen_mg_l)} mg/L` },
      ].filter(m => m.value !== '- m' && m.value !== '- °C' && m.value !== '- PSU' && m.value !== '- mg/L')
      
    case 'seismic_activity':
      return [
        { label: 'Magnitude', value: `${formatMetricValue('mag', metrics.magnitude)} M` },
        { label: 'Depth', value: `${formatMetricValue('depth', metrics.depth_miles ?? metrics.depth)} mi` },
        { label: 'Latitude', value: formatMetricValue('lat', metrics.latitude ?? metrics.lat) },
        { label: 'Longitude', value: formatMetricValue('lon', metrics.longitude ?? metrics.lon) },
      ].filter(m => m.value !== '- M' && m.value !== '- mi')
      
    case 'advanced_metrics':
      return [
        { label: 'UV Index', value: formatMetricValue('uv', metrics.uv_index) },
        { label: 'Soil Moisture', value: `${formatMetricValue('sm', metrics.soil_moisture_pct ?? metrics.soil_moisture)} %` },
        { label: 'Wildfire Risk', value: `${formatMetricValue('wr', metrics.wildfire_risk)}/10` },
        { label: 'Env Score', value: `${formatMetricValue('es', metrics.environmental_score ?? metrics.environmental_quality_score)}/100` },
        { label: 'Temp', value: `${formatMetricValue('temp', metrics.temperature_c)} °C` },
        { label: 'Humidity', value: `${formatMetricValue('hum', metrics.humidity_pct)} %` },
      ].filter(m => !m.value.includes('-'))
      
    default:
      return Object.entries(metrics).slice(0, 6).map(([k, v]) => ({
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
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])
  
  // Search function
  const handleSearch = useCallback(async (pageNum: number = 1) => {
    setLoading(true)
    setError(null)
    setShowSuggestions(false)
    
    try {
      const params = new URLSearchParams()
      if (searchQuery) params.set('q', searchQuery)
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
  useEffect(() => {
    handleSearch(1)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  
  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-950 to-black">
      <Navigation />
      
      {/* Coming Soon Overlay */}
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-md flex items-center justify-center">
        <div className="text-center px-6 py-5 rounded-xl border border-white/10 bg-white/5 shadow-xl">
          <h2 className="text-lg md:text-xl font-semibold text-white mb-2">Feature coming soon</h2>
          <p className="text-sm text-slate-300">We're working to bring this to you shortly.</p>
        </div>
      </div>
      
      {/* Hero Section */}
      <section className="relative pt-32 pb-16 px-4 sm:px-6 lg:px-8">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-purple-900/20 via-transparent to-transparent pointer-events-none" />
        
        <div className="relative max-w-7xl mx-auto text-center">
          <h1 className="text-4xl md:text-5xl font-bold text-white mb-4">
            Data Explorer
          </h1>
          <p className="text-lg text-slate-400 max-w-2xl mx-auto mb-8">
            Search and explore years of environmental data recorded immutably on the BSV blockchain.
            Every reading is verifiable on-chain.
          </p>
          
          {/* Stats */}
          {stats && (
            <div className="flex flex-wrap justify-center gap-6 mb-12">
              <div className="flex items-center gap-2 text-slate-300">
                <Hash className="h-4 w-4 text-purple-400" />
                <span className="font-semibold">{stats.totalReadings?.toLocaleString() || 0}</span>
                <span className="text-slate-500">readings</span>
              </div>
              <div className="flex items-center gap-2 text-slate-300">
                <MapPin className="h-4 w-4 text-cyan-400" />
                <span className="font-semibold">{stats.uniqueLocations?.toLocaleString() || 0}</span>
                <span className="text-slate-500">locations</span>
              </div>
              <div className="flex items-center gap-2 text-slate-300">
                <Globe className="h-4 w-4 text-green-400" />
                <span className="font-semibold">{stats.network || 'testnet'}</span>
              </div>
            </div>
          )}
          
          {/* Search Bar */}
          <div ref={searchRef} className="relative max-w-2xl mx-auto mb-8">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
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
                  if (e.key === 'Enter') handleSearch(1)
                }}
                className="w-full h-14 pl-12 pr-4 text-lg bg-slate-900/50 border-slate-700 text-white placeholder:text-slate-500 focus:border-purple-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              )}
            </div>
            
            {/* Suggestions Dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute z-50 w-full mt-2 bg-slate-900 border border-slate-700 rounded-lg shadow-xl overflow-hidden">
                {suggestions.map((s, i) => (
                  <button
                    key={`${s.location}-${s.dataType}-${i}`}
                    onClick={() => {
                      setSearchQuery(s.location)
                      setShowSuggestions(false)
                      handleSearch(1)
                    }}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-800 text-left transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <MapPin className="h-4 w-4 text-purple-400" />
                      <span className="text-white">{s.location}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant="secondary" className="bg-slate-800 text-slate-300">
                        {DATA_TYPE_CONFIG[s.dataType]?.label || s.dataType}
                      </Badge>
                      <span className="text-xs text-slate-500">{s.readingCount} readings</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          
          {/* Filters */}
          <div className="flex flex-wrap justify-center gap-4 mb-8">
            {/* Type Filter */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant={selectedType === null ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedType(null)}
                className={selectedType === null 
                  ? "bg-purple-600 hover:bg-purple-700" 
                  : "border-slate-700 text-slate-300 hover:bg-slate-800 bg-transparent"}
              >
                All Types
              </Button>
              {Object.entries(DATA_TYPE_CONFIG).map(([key, config]) => {
                const Icon = config.icon
                return (
                  <Button
                    key={key}
                    variant={selectedType === key ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedType(selectedType === key ? null : key)}
                    className={selectedType === key 
                      ? "bg-purple-600 hover:bg-purple-700" 
                      : "border-slate-700 text-slate-300 hover:bg-slate-800 bg-transparent"}
                  >
                    <Icon className="h-4 w-4 mr-1" />
                    {config.label}
                  </Button>
                )
              })}
            </div>
            
            {/* Date Filters Toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
              className="border-slate-700 text-slate-300 hover:bg-slate-800 bg-transparent"
            >
              <Filter className="h-4 w-4 mr-1" />
              Date Range
            </Button>
          </div>
          
          {/* Date Range Filters */}
          {showFilters && (
            <div className="flex flex-wrap justify-center gap-4 mb-8">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-slate-400" />
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-40 bg-slate-900/50 border-slate-700 text-white"
                />
                <span className="text-slate-500">to</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-40 bg-slate-900/50 border-slate-700 text-white"
                />
              </div>
              {(dateFrom || dateTo) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setDateFrom(''); setDateTo(''); }}
                  className="text-slate-400 hover:text-white"
                >
                  Clear Dates
                </Button>
              )}
            </div>
          )}
          
          {/* Search Button */}
          <Button
            onClick={() => handleSearch(1)}
            disabled={loading}
            className="bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-700 hover:to-cyan-700 text-white px-8"
          >
            <Search className="h-4 w-4 mr-2" />
            {loading ? 'Searching...' : 'Search Blockchain'}
          </Button>
        </div>
      </section>
      
      {/* Results Section */}
      <section className="py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          {/* Error */}
          {error && (
            <div className="text-center py-8">
              <div className="text-red-400 mb-4">{error}</div>
              <Button onClick={() => handleSearch(1)} variant="outline" className="border-slate-700 text-slate-300">
                Try Again
              </Button>
            </div>
          )}
          
          {/* Results Count */}
          {results && !error && (
            <div className="text-center mb-8">
              <p className="text-slate-400">
                Found <span className="text-white font-semibold">{results.pagination.total.toLocaleString()}</span> readings
                {searchQuery && <> matching <span className="text-purple-400">&quot;{searchQuery}&quot;</span></>}
              </p>
            </div>
          )}
          
          {/* Results Grid */}
          {results && results.items.length > 0 && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 mb-8">
                {results.items.map((item) => {
                  const config = DATA_TYPE_CONFIG[item.dataType] || { label: item.dataType, icon: Database, color: 'purple' }
                  const Icon = config.icon
                  const { date, time } = formatTimestamp(item.timestamp)
                  const keyMetrics = getKeyMetrics(item.dataType, item.metrics)
                  
                  return (
                    <GlowCard 
                      key={item.txid} 
                      glowColor={config.color as any}
                      customSize 
                      className="h-auto min-h-[280px]"
                    >
                      {/* Header */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Icon className={`h-4 w-4 text-${config.color}-400`} />
                          <span className="text-sm font-medium text-slate-300">{config.label}</span>
                        </div>
                        <Badge variant="secondary" className="bg-slate-800/50 text-slate-400 text-xs">
                          Block #{item.blockHeight}
                        </Badge>
                      </div>
                      
                      {/* Location & Time */}
                      <div className="mb-4">
                        {item.location && (
                          <div className="flex items-center gap-2 text-white mb-1">
                            <MapPin className="h-3 w-3 text-purple-400" />
                            <span className="font-medium truncate">{item.location}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-4 text-xs text-slate-500">
                          <span>{date}</span>
                          <span>{time}</span>
                        </div>
                      </div>
                      
                      {/* Metrics Grid */}
                      <div className="grid grid-cols-2 gap-2 mb-4">
                        {keyMetrics.slice(0, 6).map((metric, i) => (
                          <div key={i} className="bg-slate-900/50 rounded-lg p-2">
                            <div className="text-xs text-slate-500 mb-0.5">{metric.label}</div>
                            <div className="text-sm font-medium text-white truncate">{metric.value}</div>
                          </div>
                        ))}
                      </div>
                      
                      {/* Footer */}
                      <div className="mt-auto pt-3 border-t border-slate-800/50 flex items-center justify-between">
                        <div className="text-xs text-slate-600 font-mono truncate max-w-[120px]">
                          {item.txid.slice(0, 8)}...{item.txid.slice(-8)}
                        </div>
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
                    className="border-slate-700 text-slate-300 hover:bg-slate-800 bg-transparent"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  
                  <span className="text-slate-400">
                    Page {page} of {results.pagination.totalPages}
                  </span>
                  
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleSearch(page + 1)}
                    disabled={!results.pagination.hasMore || loading}
                    className="border-slate-700 text-slate-300 hover:bg-slate-800 bg-transparent"
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              )}
            </>
          )}
          
          {/* No Results */}
          {results && results.items.length === 0 && !loading && (
            <div className="text-center py-16">
              <Globe className="h-16 w-16 text-slate-700 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-white mb-2">No Results Found</h3>
              <p className="text-slate-400 mb-6">
                Try adjusting your search query or filters
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
                className="border-slate-700 text-slate-300 hover:bg-slate-800 bg-transparent"
              >
                Clear All Filters
              </Button>
            </div>
          )}
          
          {/* Loading State */}
          {loading && !results && (
            <div className="text-center py-16">
              <div className="animate-spin h-12 w-12 border-4 border-purple-500 border-t-transparent rounded-full mx-auto mb-4" />
              <p className="text-slate-400">Searching the blockchain...</p>
            </div>
          )}
        </div>
      </section>
      
      <Footer />
    </div>
  )
}

