"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import dynamic from "next/dynamic"
import { NodeExplorerPromoBar } from "@/components/explorer/node-explorer-promo-bar"
import { Button } from "@/components/ui/button"
import { Footer } from "@/components/sections/footer"
import { Globe } from "lucide-react"
import { StatsBar } from "./stats-bar"
import { SearchBar } from "./search-bar"
import { FilterBar } from "./filter-bar"
import { ReadingCard, ReadingCardSkeleton } from "./reading-card"
import { PaginationControls } from "./pagination-controls"
import { DATA_TYPE_CONFIG, type ExplorerStats, type SearchResults } from "./explorer-types"

// Decorative particle canvas — defer so it never blocks first paint.
const SparklesCore = dynamic(
  () => import("@/components/ui/sparkles").then((m) => m.SparklesCore),
  { ssr: false },
)

export function ExplorerClient() {
  // Search state
  const [searchQuery, setSearchQuery] = useState("")
  const suggestionsOpenRef = useRef(false)
  const suppressAutoSearchUntilRef = useRef<number>(0)

  // Filter state
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [showFilters, setShowFilters] = useState(false)

  // Results state
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  // Stats state
  const [stats, setStats] = useState<ExplorerStats>({
    totalReadings: 0,
    uniqueLocations: null,
    network: 'mainnet',
    byType: null,
  })

  const handleSearch = useCallback(async (
    pageNum: number = 1,
    queryOverride?: string,
  ) => {
    setLoading(true)
    setError(null)

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
      const text = await res.text()
      let data: any = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }

      if (!res.ok) {
        setError(
          (data && typeof data.error === 'string' && data.error) ||
            `Search failed (HTTP ${res.status})`,
        )
        return
      }

      if (data?.success) {
        setResults(data.data)
        setPage(pageNum)
        // Reuse the search total for the stats bar — avoids a second round-trip.
        const fastTotal = Number(data?.data?.pagination?.total)
        if (Number.isFinite(fastTotal) && fastTotal >= 0) {
          setStats((prev) => ({ ...prev, totalReadings: fastTotal }))
        }
      } else {
        setError(data?.error || 'Search failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [searchQuery, selectedType, dateFrom, dateTo])

  // Fetch stats once on mount (single request — the search response keeps the
  // readings total fresh, so no polling loop is needed).
  useEffect(() => {
    let cancelled = false

    async function fetchStats() {
      try {
        const res = await fetch('/api/explorer/stats')
        const text = await res.text()
        let data: any = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = null
        }
        if (cancelled) return
        if (!res.ok || !data?.success) {
          console.error('Failed to fetch stats:', res.status, data?.error || text.slice(0, 200))
          return
        }
        const byTypeRaw = data.data?.aggregates?.byType
        const byType =
          byTypeRaw && typeof byTypeRaw === 'object' && !Array.isArray(byTypeRaw)
            ? (byTypeRaw as Record<string, number>)
            : {}
        setStats((prev) => ({
          ...prev,
          network: data.data?.network || prev.network,
          uniqueLocations:
            typeof data.data?.uniqueLocations === 'number'
              ? data.data.uniqueLocations
              : prev.uniqueLocations,
          byType,
          // Keep the fast UI value if the stats endpoint returns a fallback zero.
          totalReadings:
            prev.totalReadings > 0 && (data.data?.totalReadings ?? 0) === 0
              ? prev.totalReadings
              : (data.data?.totalReadings ?? prev.totalReadings),
        }))
      } catch (e) {
        console.error('Failed to fetch stats:', e)
      }
    }

    fetchStats()
    return () => { cancelled = true }
  }, [])

  // Drop a selected type if stats say that family has no live rows.
  useEffect(() => {
    if (!selectedType || stats.byType == null) return
    if ((stats.byType[selectedType] ?? 0) > 0) return
    setSelectedType(null)
  }, [selectedType, stats.byType])

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

  // Auto-search when query changes (debounced, skip initial mount).
  // Suppressed while the autocomplete dropdown is open — the search fires on
  // Enter or suggestion selection instead, halving DB round-trips while typing.
  useEffect(() => {
    if (!mountedRef.current) return
    if (Date.now() < suppressAutoSearchUntilRef.current) return

    const q = searchQuery.trim()
    // Avoid hammering the API for single-character partials.
    if (q.length === 1) return

    const timer = window.setTimeout(() => {
      if (Date.now() < suppressAutoSearchUntilRef.current) return
      if (suggestionsOpenRef.current) return
      handleSearch(1)
    }, 450)

    return () => window.clearTimeout(timer)
  }, [searchQuery]) // eslint-disable-line react-hooks/exhaustive-deps

  const submitSearch = useCallback((query: string) => {
    suppressAutoSearchUntilRef.current = Date.now() + 900
    handleSearch(1, query)
  }, [handleSearch])

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-950 to-black pt-0 pb-44 sm:pb-28">
      {/* ─── Hero Section ─── */}
      <section className="relative overflow-hidden pt-28 sm:pt-32 pb-10 sm:pb-16 px-4 sm:px-6 lg:px-8">
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
          <div className="text-center mb-6 sm:mb-10">
            <h1 className="font-display text-3xl sm:text-4xl md:text-6xl font-bold mb-3 sm:mb-4 tracking-tight">
              <span className="gradient-heading">Data Explorer</span>
            </h1>
            <p className="text-xs sm:text-sm md:text-lg text-slate-300 mb-2 max-w-3xl mx-auto leading-relaxed">
              Search and explore environmental data recorded immutably on the BSV blockchain.
            </p>
            <p className="hidden md:block text-base text-slate-400 max-w-4xl mx-auto">
              Every reading is verifiable on-chain. Filter by location, data type, or date range.
            </p>
          </div>

          <StatsBar stats={stats} />

          <SearchBar
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            selectedType={selectedType}
            onSubmit={submitSearch}
            onSuggestionsOpenChange={(open) => { suggestionsOpenRef.current = open }}
          />

          <FilterBar
            selectedType={selectedType}
            setSelectedType={setSelectedType}
            dateFrom={dateFrom}
            setDateFrom={setDateFrom}
            dateTo={dateTo}
            setDateTo={setDateTo}
            showFilters={showFilters}
            setShowFilters={setShowFilters}
            typeCounts={stats.byType}
          />

          {/* Results summary */}
          <div className="text-center">
            {loading && (
              <div className="inline-flex items-center gap-2 text-slate-400 text-sm">
                <div className="h-3 w-3 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
                Searching...
              </div>
            )}

            {results && !error && !loading && (
              <p className="text-slate-400 text-sm md:text-base mt-2">
                Found <span className="text-white font-semibold">{results.pagination.total.toLocaleString('en-GB')}</span> readings
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

          {/* Skeleton grid while loading */}
          {loading && !error && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 mb-12">
              {Array.from({ length: 8 }).map((_, i) => (
                <ReadingCardSkeleton key={i} />
              ))}
            </div>
          )}

          {/* Results Grid */}
          {results && results.items.length > 0 && !loading && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 mb-12">
                {results.items.map((item) => (
                  <ReadingCard key={item.txid} item={item} />
                ))}
              </div>

              <PaginationControls
                page={page}
                totalPages={results.pagination.totalPages}
                hasMore={results.pagination.hasMore}
                loading={loading}
                onPageChange={(p) => handleSearch(p)}
              />
            </>
          )}

          {/* No Results */}
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
                  handleSearch(1, '')
                }}
                variant="outline"
                className="border-slate-600/50 text-slate-300 hover:bg-slate-800 bg-transparent"
              >
                Clear All Filters
              </Button>
            </div>
          )}
        </div>
      </section>

      <Footer />
      <NodeExplorerPromoBar />
    </div>
  )
}
