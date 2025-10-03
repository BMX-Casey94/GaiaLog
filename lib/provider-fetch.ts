import { fetchMetricsStore } from './metrics'
import { budgetStore } from './stores'
export interface FetchMetrics {
  onAttempt?: (info: { url: string; attempt: number }) => void
  onSuccess?: (info: { url: string; attempt: number; status: number; ms: number }) => void
  onError?: (info: { url: string; attempt: number; error: unknown }) => void
  onBackoff?: (info: { url: string; attempt: number; delayMs: number }) => void
}

export interface FetchOptions {
  retries?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
  metrics?: FetchMetrics
  headers?: Record<string, string>
  etagKey?: string // cache key for ETag
  lastModifiedKey?: string // cache key for Last-Modified
  providerId?: string // optional provider id for per-provider budgets
  tokens?: number // optional token cost (default 1)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function jitter(ms: number): number {
  const delta = ms * 0.2
  return Math.max(0, ms + (Math.random() * 2 - 1) * delta)
}

const etagCache = new Map<string, string>()
const lastModCache = new Map<string, string>()

export async function fetchJsonWithRetry<T = any>(url: string, opts: FetchOptions = {}): Promise<T> {
  const {
    retries = 3,
    baseBackoffMs = 500,
    maxBackoffMs = 8000,
    metrics,
    headers = {},
    etagKey,
    lastModifiedKey,
    providerId,
    tokens = 1,
  } = opts

  let lastError: unknown = null
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    metrics?.onAttempt?.({ url, attempt })
    fetchMetricsStore.recordAttempt(url)
    // Optional per-provider budget guard
    if (providerId) {
      const allowed = await budgetStore.canConsume(providerId, tokens)
      if (!allowed) {
        // Wait briefly for the window to roll, then retry without advancing attempts
        await sleep(200)
        attempt--
        continue
      }
    }
    const start = Date.now()
    try {
      const reqHeaders: Record<string, string> = { ...headers }
      if (etagKey && etagCache.has(etagKey)) reqHeaders['If-None-Match'] = etagCache.get(etagKey) as string
      if (lastModifiedKey && lastModCache.has(lastModifiedKey)) reqHeaders['If-Modified-Since'] = lastModCache.get(lastModifiedKey) as string

      const res = await fetch(url, { headers: reqHeaders })
      if (providerId) {
        await budgetStore.consume(providerId, tokens)
      }
      const ms = Date.now() - start
      if (res.status === 304) {
        // Not modified – return a sentinel object the caller can detect
        metrics?.onSuccess?.({ url, attempt, status: res.status, ms })
        fetchMetricsStore.recordSuccess(url, res.status, ms)
        return ({ __notModified: true } as unknown) as T
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`)
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as T
      // Capture validators
      if (etagKey) {
        const et = res.headers.get('ETag')
        if (et) etagCache.set(etagKey, et)
      }
      if (lastModifiedKey) {
        const lm = res.headers.get('Last-Modified')
        if (lm) lastModCache.set(lastModifiedKey, lm)
      }
      metrics?.onSuccess?.({ url, attempt, status: res.status, ms })
      fetchMetricsStore.recordSuccess(url, res.status, ms)
      return data
    } catch (error) {
      lastError = error
      metrics?.onError?.({ url, attempt, error })
      fetchMetricsStore.recordError(url, (String(error).match(/HTTP\s(\d{3})/) || [])[1] ? Number((String(error).match(/HTTP\s(\d{3})/) || [])[1]) : undefined)
      if (attempt > retries) break
      let delay = Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, attempt - 1))
      delay = jitter(delay)
      metrics?.onBackoff?.({ url, attempt, delayMs: delay })
      fetchMetricsStore.recordBackoff(url)
      await sleep(delay)
    }
  }
  throw lastError
}


