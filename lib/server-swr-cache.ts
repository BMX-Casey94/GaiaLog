/**
 * Lightweight in-memory stale-while-revalidate (SWR) cache for public read APIs.
 * Deduplicates concurrent refreshes so a traffic spike never causes a DB or
 * upstream API stampede.
 *
 * Failure semantics matter as much as caching here. A request-path cache must
 * never take the process down with it:
 *
 *   - A background refresh that rejects is logged and swallowed. The previous
 *     value keeps being served, so a transient database failure degrades into
 *     slightly stale data instead of an error response.
 *   - The rejected promise is never left dangling. Node 22 terminates the
 *     process on an unhandled rejection, so a fire-and-forget refresh with no
 *     catch is a silent 502 for the whole instance.
 */

interface CacheEntry<T> {
  value: T
  ts: number
}

export interface SwrResult<T> {
  value: T
  cached: boolean
  stale: boolean
}

export class ServerSwrCache<T> {
  private entry: CacheEntry<T> | null = null
  private inFlight: Promise<T> | null = null

  constructor(
    private readonly ttlMs: number,
    private readonly label: string = 'server-swr-cache',
  ) {}

  async get(fetcher: () => Promise<T>): Promise<SwrResult<T>> {
    const now = Date.now()

    if (this.entry) {
      const age = now - this.entry.ts
      if (age <= this.ttlMs) {
        return { value: this.entry.value, cached: true, stale: false }
      }
      // Serve stale immediately and refresh in the background. The refresh is
      // intentionally not awaited, so it must handle its own failure.
      void this.triggerRefresh(fetcher).catch(() => {})
      return { value: this.entry.value, cached: true, stale: true }
    }

    // Cold start: deduplicate concurrent initial callers.
    const value = await this.triggerRefresh(fetcher)
    return { value, cached: false, stale: false }
  }

  private triggerRefresh(fetcher: () => Promise<T>): Promise<T> {
    if (this.inFlight) return this.inFlight

    // The rejection is observed by every awaiting caller. It is logged once
    // here so the failure is diagnosable, and it is deliberately not cached:
    // the next call retries instead of pinning an error for a whole TTL.
    const refresh = fetcher().then((value) => {
      this.entry = { value, ts: Date.now() }
      return value
    })
    refresh.catch((error) => {
      console.warn(
        `[${this.label}] refresh failed, serving the previous value if any:`,
        error instanceof Error ? error.message : error,
      )
    })
    this.inFlight = refresh.finally(() => {
      this.inFlight = null
    })
    // `finally` re-throws, so keep the chain's rejection handled for callers
    // that do not await it (the stale path above).
    this.inFlight.catch(() => {})
    return this.inFlight
  }

  /** Current cached value regardless of age, for diagnostics. */
  peek(): T | null {
    return this.entry?.value ?? null
  }
}
