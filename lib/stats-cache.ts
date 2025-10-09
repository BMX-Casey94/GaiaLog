/**
 * Server-side stats caching with TTL and stale data fallback
 * Prevents expensive DB queries from running too frequently
 */

interface CachedStats {
  airQuality: {
    aqi: number | null
    collected_at: string | null
  }
  blockchain: {
    totalTransactions: number
    lastTransaction: string | null
  }
  cachedAt: number
}

interface CachedBSVStats {
  totalTransactions: number
  processingRate: number
  errorRate: number
  dailyCapacity: number
  totalBalance: number
  totalWorkerTransactions: number
  walletCount: number
  runningWorkers: number
  queueSize: number
  completedTransactions: number
  failedTransactions: number
  cachedAt: number
}

class StatsCache<T extends { cachedAt: number }> {
  private cache: T | null = null
  private readonly TTL: number
  private fetching: Promise<T> | null = null

  constructor(ttlMs: number = 30000) {
    this.TTL = ttlMs
  }

  async getStats(fetchFn: () => Promise<Omit<T, 'cachedAt'>>): Promise<T> {
    const now = Date.now()
    
    // Return cached if fresh
    if (this.cache && (now - this.cache.cachedAt) < this.TTL) {
      return this.cache
    }

    // If already fetching, return that promise to avoid duplicate queries
    if (this.fetching) {
      return this.fetching
    }

    // Fetch new data
    this.fetching = fetchFn()
      .then(data => {
        this.cache = { ...data, cachedAt: now } as T
        this.fetching = null
        return this.cache
      })
      .catch(err => {
        this.fetching = null
        // Return stale cache if available, otherwise throw
        if (this.cache) {
          console.warn('Stats fetch failed, returning stale cache:', err)
          return this.cache
        }
        throw err
      })

    return this.fetching
  }

  getStale(): T | null {
    return this.cache
  }

  clear(): void {
    this.cache = null
    this.fetching = null
  }

  getCacheAge(): number | null {
    if (!this.cache) return null
    return Date.now() - this.cache.cachedAt
  }
}

// Export singleton instances for different stat types
export const heroStatsCache = new StatsCache<CachedStats>(15000) // 15 seconds TTL for faster updates
export const bsvStatsCache = new StatsCache<CachedBSVStats>(15000) // 15 seconds TTL for BSV stats

