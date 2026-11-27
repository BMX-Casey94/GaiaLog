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

const EXPLORER_PAGE_SIZE = 24
const PAGE_CACHE_LIMIT = 4

type ExplorerFilters = {
  q: string
  type: string | null
  from: string
  to: string
}

function explorerFilterKey(filters: ExplorerFilters): string {
  return JSON.stringify(filters)
}

function explorerPageKey(filters: ExplorerFilters, pageNum: number): string {
  return `${explorerFilterKey(filters)}|${pageNum}`
}

async function fetchExplorerPage(
  filters: ExplorerFilters,
  pageNum: number,
  signal: AbortSignal,
): Promise<SearchResults> {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.type) params.set('type', filters.type)
  if (filters.from) params.set('from', new Date(`${filters.from}T00:00:00.000Z`).toISOString())
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59.999Z`).toISOString())
  params.set('page', String(pageNum))
  params.set('pageSize', String(EXPLORER_PAGE_SIZE))

  const res = await fetch(`/api/explorer/search?${params}`, { signal })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  if (!res.ok || !data?.success) {
    throw new Error(
      (data && typeof data.error === 'string' && data.error) ||
        `Search failed (HTTP ${res.status})`,
    )
  }

  return data.data as SearchResults
}

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
  const activeSearchAbortRef = useRef<AbortController | null>(null)
  const pageCacheRef = useRef(new Map<string, SearchResults>())
  const inflightRef = useRef(new Map<string, { controller: AbortController; promise: Promise<SearchResults> }>())
  const [firstPageSettled, setFirstPageSettled] = useState(false)

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

  const rememberPage = useCallback((key: string, data: SearchResults) => {
    const cache = pageCacheRef.current
    cache.delete(key)
    cache.set(key, data)
    while (cache.size > PAGE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }, [])

  const applyReadingTotal = useCallback((data: SearchResults) => {
    const fastTotal = Number(data.pagination?.total)
    if (!Number.isFinite(fastTotal) || fastTotal < 0) return
    setStats((prev) => ({ ...prev, totalReadings: fastTotal }))
  }, [])

  const abortOtherFilters = useCallback((filters: ExplorerFilters) => {
    const prefix = `${explorerFilterKey(filters)}|`
    for (const [key, entry] of inflightRef.current) {
      if (key.startsWith(prefix)) continue
      entry.controller.abort()
      inflightRef.current.delete(key)
    }
  }, [])

  const loadPage = useCallback((filters: ExplorerFilters, pageNum: number): Promise<SearchResults> => {
    const key = explorerPageKey(filters, pageNum)
    const cached = pageCacheRef.current.get(key)
    if (cached) return Promise.resolve(cached)

    const existing = inflightRef.current.get(key)
    if (existing) return existing.promise

    const controller = new AbortController()
    const promise = fetchExplorerPage(filters, pageNum, controller.signal)
      .then((data) => {
        rememberPage(key, data)
        return data
      })
      .finally(() => {
        const current = inflightRef.current.get(key)
        if (current?.promise === promise) inflightRef.current.delete(key)
      })

    inflightRef.current.set(key, { controller, promise })
    return promise
  }, [rememberPage])

  const prefetchNextPage = useCallback((filters: ExplorerFilters, data: SearchResults) => {
    if (!data.pagination.hasMore) return
    const nextPage = data.pagination.page + 1
    const key = explorerPageKey(filters, nextPage)
    if (pageCacheRef.current.has(key) || inflightRef.current.has(key)) return
    void loadPage(filters, nextPage).catch((e) => {
      if (e instanceof Error && e.name === 'AbortError') return
    })
  }, [loadPage])

  const handleSearch = useCallback(async (
    pageNum: number = 1,
    queryOverride?: string,
  ) => {
    const q = queryOverride !== undefined ? queryOverride : searchQuery
    const filters: ExplorerFilters = {
      q,
      type: selectedType,
      from: dateFrom,
      to: dateTo,
    }
    const key = explorerPageKey(filters, pageNum)

    // A new filter drops every other in-flight page. The page being opened
    // keeps its request, including one already started as a silent prefetch.
    activeSearchAbortRef.current?.abort()
    abortOtherFilters(filters)

    const cached = pageCacheRef.current.get(key)
    if (cached) {
      setResults(cached)
      setPage(pageNum)
      setError(null)
      setLoading(false)
      setFirstPageSettled(true)
      applyReadingTotal(cached)
      prefetchNextPage(filters, cached)
      return
    }

    const controller = new AbortController()
    activeSearchAbortRef.current = controller
    setLoading(true)
    setError(null)

    try {
      const data = await loadPage(filters, pageNum)
      if (controller.signal.aborted) return
      setResults(data)
      setPage(pageNum)
      applyReadingTotal(data)
      prefetchNextPage(filters, data)
    } catch (e) {
      if (controller.signal.aborted) return
      if (e instanceof Error && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setFirstPageSettled(true)
      }
    }
  }, [searchQuery, selectedType, dateFrom, dateTo, abortOtherFilters, applyReadingTotal, loadPage, prefetchNextPage])

  // Stats wait until the first page of readings has settled, so the cards
  // are not competing with the aggregate queries on the opening request.
  useEffect(() => {
    if (!firstPageSettled) return
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
  }, [firstPageSettled])

  // Drop a selected type if stats say that family has no live rows.
  useEffect(() => {
    if (!selectedType || stats.byType == null) return
    if ((stats.byType[selectedType] ?? 0) > 0) return
    setSelectedType(null)
  }, [selectedType, stats.byType])

  // Initial search on mount.
  //
  // Seeded from `?q=` so the `SearchAction` advertised in the homepage JSON-LD
  // actually runs a search. Read from `window.location` inside the effect
  // rather than `useSearchParams`, which would force this statically rendered
  // page to become dynamic or require a Suspense boundary.
  const mountedRef = useRef(false)
  useEffect(() => {
    const initialQuery = new URLSearchParams(window.location.search).get("q") ?? ""
    if (initialQuery) {
      // Suppress the debounced auto-search that would otherwise fire a second,
      // identical request when `searchQuery` changes below.
      suppressAutoSearchUntilRef.current = Date.now() + 900
      setSearchQuery(initialQuery)
      handleSearch(1, initialQuery)
    } else {
      handleSearch(1)
    }
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
      <main>
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
      <section className="pt-8 pb-16 px-4 sm:px-6 lg:px-8 relative" aria-labelledby="explorer-results-heading">
        <h2 id="explorer-results-heading" className="sr-only">
          Environmental readings
        </h2>
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
      </main>

      <Footer />
      <NodeExplorerPromoBar />
    </div>
  )
}
