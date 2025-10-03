// Simple in-memory cache for hero stats with TTL support
interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number
}

class HeroStatsCache {
  private cache = new Map<string, CacheEntry<any>>()
  private readonly DEFAULT_TTL = 30000 // 30 seconds

  set<T>(key: string, data: T, ttl: number = this.DEFAULT_TTL): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    })
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return null
    }

    return entry.data
  }

  clear(): void {
    this.cache.clear()
  }

  // Clean up expired entries
  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
      }
    }
  }

  // Get cache stats
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    }
  }
}

export const heroStatsCache = new HeroStatsCache()

// Clean up expired entries every 5 minutes
setInterval(() => {
  heroStatsCache.cleanup()
}, 5 * 60 * 1000)
