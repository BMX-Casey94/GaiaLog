/**
 * Client-side request deduplication and short-TTL cache for shared homepage
 * endpoints (e.g. Hero and LiveDashboard both reading /api/explorer/latest-readings).
 */

interface ClientCacheEntry {
  data: unknown
  ts: number
}

const cache = new Map<string, ClientCacheEntry>()
const inFlight = new Map<string, Promise<unknown>>()

export async function fetchJsonDeduplicated<T>(
  url: string,
  options?: { ttlMs?: number; forceRefresh?: boolean },
): Promise<T> {
  const ttlMs = options?.ttlMs ?? 15_000
  const forceRefresh = options?.forceRefresh ?? false

  if (!forceRefresh) {
    const existing = cache.get(url)
    if (existing && Date.now() - existing.ts <= ttlMs) {
      return existing.data as T
    }
    const pending = inFlight.get(url)
    if (pending) {
      return pending as Promise<T>
    }
  }

  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`)
      }
      const data = (await res.json()) as T
      cache.set(url, { data, ts: Date.now() })
      return data
    })
    .finally(() => {
      inFlight.delete(url)
    })

  inFlight.set(url, promise)
  return promise
}
