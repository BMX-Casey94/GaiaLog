import { fetchMetricsStore } from './metrics'
import { budgetStore } from './stores'
import { providerConfigs, type BreakerConfig } from './provider-registry'

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
  timeoutMs?: number
  metrics?: FetchMetrics
  headers?: Record<string, string>
  etagKey?: string // cache key for ETag
  lastModifiedKey?: string // cache key for Last-Modified
  providerId?: string // optional provider id for per-provider budgets
  tokens?: number // optional token cost (default 1)
  jsonFallbackValue?: unknown // optional fallback for persistently malformed JSON bodies
}

// ─── Typed errors ────────────────────────────────────────────────────────────

/**
 * Thrown when a provider's rate budget cannot serve the request. A per-day
 * denial is permanent for the current UTC day; a per-second denial survives a
 * bounded number of short waits before we surface it.
 */
export class ProviderBudgetExhaustedError extends Error {
  readonly providerId: string
  readonly reason: 'per_second' | 'per_day'
  readonly retryAfterMs?: number
  readonly url?: string

  constructor(providerId: string, reason: 'per_second' | 'per_day', retryAfterMs?: number, url?: string) {
    super(
      `Provider ${providerId} budget exhausted (${reason})` +
      (retryAfterMs != null ? `, retry after ${Math.ceil(retryAfterMs)}ms` : ''),
    )
    this.name = 'ProviderBudgetExhaustedError'
    this.providerId = providerId
    this.reason = reason
    this.retryAfterMs = retryAfterMs
    this.url = url
  }
}

/** Thrown when a provider's circuit breaker is open; callers should fail fast. */
export class ProviderCircuitOpenError extends Error {
  readonly providerId: string
  readonly retryAfterMs: number
  readonly url?: string

  constructor(providerId: string, retryAfterMs: number, url?: string) {
    super(`Provider ${providerId} circuit open, retry after ${Math.ceil(retryAfterMs)}ms`)
    this.name = 'ProviderCircuitOpenError'
    this.providerId = providerId
    this.retryAfterMs = retryAfterMs
    this.url = url
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function jitter(ms: number): number {
  const delta = ms * 0.2
  return Math.max(0, ms + (Math.random() * 2 - 1) * delta)
}

// ─── Bounded validator caches ────────────────────────────────────────────────

const VALIDATOR_CACHE_MAX_ENTRIES = 2000
const etagCache = new Map<string, string>()
const lastModCache = new Map<string, string>()

// Bounded insert: evicts the oldest insertion once the cap is reached, so a
// long-lived process cannot grow these maps without limit.
function setCapped(map: Map<string, string>, key: string, value: string): void {
  if (map.has(key)) {
    map.delete(key)
  } else if (map.size >= VALIDATOR_CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(key, value)
}

// ─── Per-provider circuit breaker ────────────────────────────────────────────
//
// Implements BreakerConfig from provider-registry:
//   consecutiveFailures  – trip immediately after N straight failures
//   errorRateThreshold   – trip when failures/calls exceeds this over the window
//   minCallsForErrorRate – ...but only once this many calls are recorded
//   burst429PerMinute    – trip when this many 429s land in the rolling window
//   cooldownMs           – how long the circuit stays open

const BREAKER_WINDOW_MS = 60 * 1000
// Hard cap so a pathological burst cannot grow the 429 log without bound.
const BREAKER_MAX_429_TRACKED = 200

interface BreakerState {
  consecutiveFailures: number
  windowStart: number
  windowCalls: number
  windowFailures: number
  timestamps429: number[]
  openUntil: number
  openedAt: number
  openReason: string | null
  // True once the cooldown has elapsed and exactly one probe call is allowed.
  // A failed probe re-opens the circuit immediately rather than waiting for
  // another full failure streak.
  halfOpen: boolean
}

function createBreakerState(): BreakerState {
  return {
    consecutiveFailures: 0,
    windowStart: 0,
    windowCalls: 0,
    windowFailures: 0,
    timestamps429: [],
    openUntil: 0,
    openedAt: 0,
    openReason: null,
    halfOpen: false,
  }
}

const breakerGlobal = globalThis as { __GAIALOG_PROVIDER_BREAKERS__?: Map<string, BreakerState> }
if (!breakerGlobal.__GAIALOG_PROVIDER_BREAKERS__) {
  breakerGlobal.__GAIALOG_PROVIDER_BREAKERS__ = new Map<string, BreakerState>()
}
const breakerStates = breakerGlobal.__GAIALOG_PROVIDER_BREAKERS__

function getBreakerConfig(providerId: string): BreakerConfig | null {
  const cfg = (providerConfigs as Record<string, { breaker?: BreakerConfig } | undefined>)[providerId]
  return cfg?.breaker ?? null
}

function getBreakerState(providerId: string): BreakerState {
  let state = breakerStates.get(providerId)
  if (!state) {
    state = createBreakerState()
    breakerStates.set(providerId, state)
  }
  return state
}

function rollBreakerWindow(state: BreakerState, now: number): void {
  if (state.windowStart === 0 || now - state.windowStart >= BREAKER_WINDOW_MS) {
    state.windowStart = now
    state.windowCalls = 0
    state.windowFailures = 0
  }
  if (state.timestamps429.length > 0) {
    const cutoff = now - BREAKER_WINDOW_MS
    let drop = 0
    while (drop < state.timestamps429.length && state.timestamps429[drop] <= cutoff) drop++
    if (drop > 0) state.timestamps429.splice(0, drop)
  }
}

function openCircuit(providerId: string, state: BreakerState, config: BreakerConfig, now: number, reason: string): void {
  state.openUntil = now + Math.max(0, config.cooldownMs)
  state.openedAt = now
  state.openReason = reason
  state.halfOpen = false
  // Start the cooldown from a clean slate so the half-open probe is meaningful.
  state.consecutiveFailures = 0
  state.windowStart = now
  state.windowCalls = 0
  state.windowFailures = 0
  state.timestamps429 = []
  console.warn(`⛔ Provider ${providerId} circuit opened (${reason}) for ${Math.round(config.cooldownMs / 1000)}s`)
}

/** Throws ProviderCircuitOpenError when the circuit is open for this provider. */
function assertCircuitClosed(providerId: string, config: BreakerConfig | null, url: string): void {
  if (!config) return
  const state = getBreakerState(providerId)
  const now = Date.now()
  if (state.openUntil > now) {
    throw new ProviderCircuitOpenError(providerId, state.openUntil - now, url)
  }
  if (state.openUntil > 0) {
    // Cooldown elapsed – move to half-open and let one probe call through.
    state.openUntil = 0
    state.halfOpen = true
    state.consecutiveFailures = 0
    state.windowStart = now
    state.windowCalls = 0
    state.windowFailures = 0
    state.timestamps429 = []
  }
}

function recordBreakerCall(providerId: string, config: BreakerConfig | null): void {
  if (!config) return
  const state = getBreakerState(providerId)
  rollBreakerWindow(state, Date.now())
  state.windowCalls += 1
}

function recordBreakerSuccess(providerId: string, config: BreakerConfig | null): void {
  if (!config) return
  const state = getBreakerState(providerId)
  rollBreakerWindow(state, Date.now())
  state.consecutiveFailures = 0
  // A successful half-open probe proves the provider recovered.
  if (state.halfOpen) {
    state.halfOpen = false
    state.openReason = null
  }
}

function recordBreakerFailure(providerId: string, config: BreakerConfig | null): void {
  if (!config) return
  const state = getBreakerState(providerId)
  const now = Date.now()
  rollBreakerWindow(state, now)
  state.consecutiveFailures += 1
  state.windowFailures += 1

  // A failed half-open probe re-opens immediately: the retry after cooldown
  // did not work, so waiting for another full streak would let bad traffic
  // through on every retry cycle.
  if (state.halfOpen) {
    openCircuit(providerId, state, config, now, 'half-open probe failed')
    return
  }

  if (config.consecutiveFailures > 0 && state.consecutiveFailures >= config.consecutiveFailures) {
    openCircuit(providerId, state, config, now, `${state.consecutiveFailures} consecutive failures`)
    return
  }

  if (
    config.minCallsForErrorRate > 0 &&
    state.windowCalls >= config.minCallsForErrorRate &&
    state.windowCalls > 0 &&
    state.windowFailures / state.windowCalls >= config.errorRateThreshold
  ) {
    const rate = state.windowFailures / state.windowCalls
    openCircuit(providerId, state, config, now, `error rate ${(rate * 100).toFixed(0)}% over ${state.windowCalls} calls`)
  }
}

function recordBreaker429(providerId: string, config: BreakerConfig | null): void {
  if (!config) return
  const state = getBreakerState(providerId)
  const now = Date.now()
  rollBreakerWindow(state, now)
  state.timestamps429.push(now)
  if (state.timestamps429.length > BREAKER_MAX_429_TRACKED) {
    state.timestamps429.splice(0, state.timestamps429.length - BREAKER_MAX_429_TRACKED)
  }
  if (config.burst429PerMinute > 0 && state.timestamps429.length >= config.burst429PerMinute) {
    openCircuit(providerId, state, config, now, `${state.timestamps429.length} 429s in ${Math.round(BREAKER_WINDOW_MS / 1000)}s`)
  }
}

export interface ProviderCircuitSnapshot {
  providerId: string
  open: boolean
  retryAfterMs: number
  consecutiveFailures: number
  windowCalls: number
  windowFailures: number
  recent429s: number
  openReason: string | null
  halfOpen: boolean
}

/** Snapshot of breaker state for a provider, for health/status endpoints. */
export function getProviderCircuitSnapshot(providerId: string): ProviderCircuitSnapshot {
  const state = getBreakerState(providerId)
  const now = Date.now()
  rollBreakerWindow(state, now)
  return {
    providerId,
    open: state.openUntil > now,
    retryAfterMs: Math.max(0, state.openUntil - now),
    consecutiveFailures: state.consecutiveFailures,
    windowCalls: state.windowCalls,
    windowFailures: state.windowFailures,
    recent429s: state.timestamps429.length,
    openReason: state.openReason,
    halfOpen: state.halfOpen,
  }
}

/** Clears breaker state for one provider (or all when omitted). */
export function resetProviderCircuit(providerId?: string): void {
  if (providerId) breakerStates.delete(providerId)
  else breakerStates.clear()
}

// ─── Budget guard ────────────────────────────────────────────────────────────

// A per-second denial is worth waiting for briefly; a per-day denial is not.
const MAX_BUDGET_WAITS = 3
const MAX_BUDGET_WAIT_MS = 1000
const MIN_BUDGET_WAIT_MS = 250

async function awaitBudget(providerId: string, tokens: number, url: string): Promise<void> {
  for (let waitIndex = 0; ; waitIndex++) {
    const check = await budgetStore.checkBudget(providerId, tokens)
    if (check.allowed) {
      // Reserve before the request so concurrent callers cannot both pass the
      // check and then both spend the last slot. consume() re-checks atomically,
      // so a lost race returns false and we treat it as another per-second denial.
      if (await budgetStore.consume(providerId, tokens)) return
      if (waitIndex >= MAX_BUDGET_WAITS) {
        throw new ProviderBudgetExhaustedError(providerId, 'per_second', MIN_BUDGET_WAIT_MS, url)
      }
      await sleep(MIN_BUDGET_WAIT_MS)
      continue
    }

    if (check.reason === 'per_day') {
      // The window only rolls at UTC midnight; waiting here would hang the worker.
      throw new ProviderBudgetExhaustedError(providerId, 'per_day', check.retryAfterMs, url)
    }

    if (waitIndex >= MAX_BUDGET_WAITS) {
      throw new ProviderBudgetExhaustedError(providerId, 'per_second', check.retryAfterMs, url)
    }

    const delay = Math.min(MAX_BUDGET_WAIT_MS, Math.max(MIN_BUDGET_WAIT_MS, check.retryAfterMs ?? MIN_BUDGET_WAIT_MS))
    await sleep(delay)
  }
}

class JsonBodyParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonBodyParseError'
  }
}

async function fetchWithRetry<T>(url: string, opts: FetchOptions, parse: (response: Response) => Promise<T>): Promise<T> {
  const {
    retries = 3,
    baseBackoffMs = 500,
    maxBackoffMs = 8000,
    timeoutMs = 15000,
    metrics,
    headers = {},
    etagKey,
    lastModifiedKey,
    providerId,
    tokens = 1,
  } = opts

  const breakerConfig = providerId ? getBreakerConfig(providerId) : null

  let lastError: unknown = null
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    metrics?.onAttempt?.({ url, attempt })

    // Fail fast: an open circuit must not consume a retry slot or a budget slot.
    if (providerId) assertCircuitClosed(providerId, breakerConfig, url)

    fetchMetricsStore.recordAttempt(url)

    // Per-provider budget guard. Per-second denials get a bounded number of
    // short waits; per-day denials raise immediately. The attempt counter is
    // never rewound, so this loop cannot retry forever.
    if (providerId) {
      await awaitBudget(providerId, tokens, url)
      recordBreakerCall(providerId, breakerConfig)
    }

    const start = Date.now()
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      const reqHeaders: Record<string, string> = { ...headers }
      if (etagKey && etagCache.has(etagKey)) reqHeaders['If-None-Match'] = etagCache.get(etagKey) as string
      if (lastModifiedKey && lastModCache.has(lastModifiedKey)) reqHeaders['If-Modified-Since'] = lastModCache.get(lastModifiedKey) as string

      const controller = new AbortController()
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => controller.abort(), timeoutMs)
      }
      const res = await fetch(url, { headers: reqHeaders, signal: controller.signal })
      const ms = Date.now() - start
      if (res.status === 304) {
        // Not modified – return a sentinel object the caller can detect
        if (providerId) recordBreakerSuccess(providerId, breakerConfig)
        metrics?.onSuccess?.({ url, attempt, status: res.status, ms })
        fetchMetricsStore.recordSuccess(url, res.status, ms)
        return ({ __notModified: true } as unknown) as T
      }
      if (res.status === 429 || res.status >= 500) {
        if (providerId) {
          recordBreakerFailure(providerId, breakerConfig)
          if (res.status === 429) recordBreaker429(providerId, breakerConfig)
        }
        throw new Error(`HTTP ${res.status}`)
      }
      if (!res.ok) {
        // 4xx other than 429 is a client/config problem, not provider ill-health.
        throw new Error(`HTTP ${res.status}`)
      }
      const data = await parse(res)
      // Capture validators
      if (etagKey) {
        const et = res.headers.get('ETag')
        if (et) setCapped(etagCache, etagKey, et)
      }
      if (lastModifiedKey) {
        const lm = res.headers.get('Last-Modified')
        if (lm) setCapped(lastModCache, lastModifiedKey, lm)
      }
      if (providerId) recordBreakerSuccess(providerId, breakerConfig)
      metrics?.onSuccess?.({ url, attempt, status: res.status, ms })
      fetchMetricsStore.recordSuccess(url, res.status, ms)
      return data
    } catch (error) {
      if (error instanceof ProviderCircuitOpenError || error instanceof ProviderBudgetExhaustedError) {
        // Operational guard, not a provider error – never retried here.
        throw error
      }
      lastError = error
      metrics?.onError?.({ url, attempt, error })
      const statusMatch = String(error).match(/HTTP\s(\d{3})/)
      const status = statusMatch ? Number(statusMatch[1]) : undefined
      fetchMetricsStore.recordError(url, status)

      // Non-429 4xx responses do not indicate provider ill-health.
      if (providerId && status !== undefined && status < 500 && status !== 429) {
        recordBreakerSuccess(providerId, breakerConfig)
      } else if (providerId && status === undefined) {
        // A body the caller has explicitly opted to tolerate via
        // jsonFallbackValue must not trip the breaker: the provider answered
        // with a healthy status and several sources legitimately return an
        // empty or partial body. Everything else (timeout, network error,
        // untolerated malformed JSON) counts against the provider.
        const tolerated = error instanceof JsonBodyParseError && Object.prototype.hasOwnProperty.call(opts, 'jsonFallbackValue')
        if (tolerated) recordBreakerSuccess(providerId, breakerConfig)
        else recordBreakerFailure(providerId, breakerConfig)
      }

      if (attempt > retries) break
      let delay = Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, attempt - 1))
      delay = jitter(delay)
      metrics?.onBackoff?.({ url, attempt, delayMs: delay })
      fetchMetricsStore.recordBackoff(url)
      await sleep(delay)
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }
  throw lastError
}

export async function fetchJsonWithRetry<T = any>(url: string, opts: FetchOptions = {}): Promise<T> {
  try {
    return await fetchWithRetry(url, opts, async (response) => {
      const bodyText = await response.text()
      const trimmed = bodyText.trim()
      if (!trimmed) {
        throw new JsonBodyParseError('Empty JSON response body')
      }

      try {
        return JSON.parse(trimmed) as T
      } catch (error) {
        const preview = trimmed.replace(/\s+/g, ' ').slice(0, 200)
        const detail = error instanceof Error ? error.message : String(error)
        throw new JsonBodyParseError(`Malformed JSON response body (${detail})${preview ? `: ${preview}` : ''}`)
      }
    })
  } catch (error) {
    if (error instanceof JsonBodyParseError && Object.prototype.hasOwnProperty.call(opts, 'jsonFallbackValue')) {
      return opts.jsonFallbackValue as T
    }
    throw error
  }
}

export async function fetchTextWithRetry(url: string, opts: FetchOptions = {}): Promise<string> {
  return fetchWithRetry(url, opts, async (response) => await response.text())
}
