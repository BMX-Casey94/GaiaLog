export interface CacheStore {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
}

export interface DedupeStore {
  // Returns true if newly added; false if already present
  add(key: string): Promise<boolean>
  has(key: string): Promise<boolean>
}

export interface CursorStore {
  get(providerId: string, resourceKey?: string): Promise<string | number | null>
  set(providerId: string, cursor: string | number, resourceKey?: string): Promise<void>
}

export interface BudgetLimits {
  perSecond?: number
  perDay?: number
}

export type BudgetDenialReason = 'per_second' | 'per_day'

export interface BudgetCheckResult {
  allowed: boolean
  // Present only when allowed === false.
  reason?: BudgetDenialReason
  // Time until the caller may retry (ms). For per_second this is when the
  // oldest token leaves the sliding window; for per_day it is time to the next
  // UTC midnight rollover.
  retryAfterMs?: number
}

export interface BudgetStore {
  configure(providerId: string, limits: BudgetLimits): Promise<void>
  // Richer, non-mutating check. Callers use `reason` to decide between a short
  // bounded wait (per_second) and failing fast (per_day).
  checkBudget(providerId: string, tokens?: number): Promise<BudgetCheckResult>
  // Backwards-compatible boolean wrapper around checkBudget().
  canConsume(providerId: string, tokens?: number): Promise<boolean>
  consume(providerId: string, tokens?: number): Promise<boolean>
  getRemaining(providerId: string): Promise<{ perSecondRemaining: number | null; perDayRemaining: number | null }>
}

type CacheEntry = { value: unknown; expiresAt: number }

export class InMemoryCacheStore implements CacheStore {
  private store = new Map<string, CacheEntry>()

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return null
    }
    return entry.value as T
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + Math.max(0, ttlMs)
    this.store.set(key, { value, expiresAt })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

export class InMemoryDedupeStore implements DedupeStore {
  private ttlMs: number
  private map = new Map<string, number>() // key -> expiresAt

  constructor(ttlMs?: number) {
    const envTtl = Number(process.env.DEDUPE_TTL_MS)
    this.ttlMs = Number.isFinite(envTtl) && envTtl > 0 ? envTtl : (ttlMs ?? 5 * 60 * 1000) // default 5 minutes
  }

  private sweepExpired(now: number): void {
    for (const [key, exp] of this.map.entries()) {
      if (exp <= now) this.map.delete(key)
    }
  }

  async add(key: string): Promise<boolean> {
    const now = Date.now()
    this.sweepExpired(now)
    const exp = this.map.get(key)
    if (exp && exp > now) return false
    this.map.set(key, now + this.ttlMs)
    return true
  }

  async has(key: string): Promise<boolean> {
    const now = Date.now()
    this.sweepExpired(now)
    const exp = this.map.get(key)
    return !!exp && exp > now
  }
}

export class InMemoryCursorStore implements CursorStore {
  private map = new Map<string, string | number>()

  private makeKey(providerId: string, resourceKey?: string): string {
    return resourceKey ? `${providerId}::${resourceKey}` : providerId
  }

  async get(providerId: string, resourceKey?: string): Promise<string | number | null> {
    const key = this.makeKey(providerId, resourceKey)
    return this.map.has(key) ? (this.map.get(key) as string | number) : null
  }

  async set(providerId: string, cursor: string | number, resourceKey?: string): Promise<void> {
    const key = this.makeKey(providerId, resourceKey)
    this.map.set(key, cursor)
  }
}

type BudgetState = {
  limits: BudgetLimits
  // True sliding-window log of consumption timestamps (ms) inside the last
  // 1000 ms. A fixed-window counter let a burst that straddled a window
  // boundary consume up to 2x the configured per-second limit.
  secTimestamps: number[]
  // Per-day (UTC) counter
  dayKey: string
  dayCount: number
}

const PER_SECOND_WINDOW_MS = 1000

function msUntilNextUtcMidnight(now: number): number {
  const d = new Date(now)
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)
  return Math.max(0, next - now)
}

export class InMemoryBudgetStore implements BudgetStore {
  private states = new Map<string, BudgetState>()

  private getDayKey(now: number = Date.now()): string {
    const d = new Date(now)
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`
  }

  async configure(providerId: string, limits: BudgetLimits): Promise<void> {
    const now = Date.now()
    const state: BudgetState = {
      limits,
      secTimestamps: [],
      dayKey: this.getDayKey(now),
      dayCount: 0,
    }
    this.states.set(providerId, state)
  }

  // Drops timestamps that have fallen out of the sliding window and rolls the
  // UTC day counter. Must be called before every check/mutation.
  private refresh(providerId: string, now: number): BudgetState {
    let state = this.states.get(providerId)
    if (!state) {
      state = {
        limits: {},
        secTimestamps: [],
        dayKey: this.getDayKey(now),
        dayCount: 0,
      }
      this.states.set(providerId, state)
    }

    const cutoff = now - PER_SECOND_WINDOW_MS
    if (state.secTimestamps.length > 0) {
      // Timestamps are appended in ascending order, so find the first live one.
      let drop = 0
      while (drop < state.secTimestamps.length && state.secTimestamps[drop] <= cutoff) drop++
      if (drop > 0) state.secTimestamps.splice(0, drop)
    }

    const currentDay = this.getDayKey(now)
    if (currentDay !== state.dayKey) {
      state.dayKey = currentDay
      state.dayCount = 0
    }

    return state
  }

  async checkBudget(providerId: string, tokens: number = 1): Promise<BudgetCheckResult> {
    const now = Date.now()
    const state = this.refresh(providerId, now)
    const { perSecond, perDay } = state.limits
    const cost = Math.max(1, Math.floor(tokens) || 1)

    if (perSecond != null && state.secTimestamps.length + cost > perSecond) {
      // How many in-window entries must expire before this request fits.
      const mustExpire = state.secTimestamps.length + cost - perSecond
      const pivot = state.secTimestamps[mustExpire - 1]
      const retryAfterMs = Number.isFinite(pivot)
        ? Math.max(0, pivot + PER_SECOND_WINDOW_MS - now)
        : PER_SECOND_WINDOW_MS
      return { allowed: false, reason: 'per_second', retryAfterMs }
    }

    if (perDay != null && state.dayCount + cost > perDay) {
      return { allowed: false, reason: 'per_day', retryAfterMs: msUntilNextUtcMidnight(now) }
    }

    return { allowed: true }
  }

  async canConsume(providerId: string, tokens: number = 1): Promise<boolean> {
    return (await this.checkBudget(providerId, tokens)).allowed
  }

  async consume(providerId: string, tokens: number = 1): Promise<boolean> {
    const check = await this.checkBudget(providerId, tokens)
    if (!check.allowed) return false
    const now = Date.now()
    // checkBudget() already refreshed state; re-read the same live object.
    const state = this.refresh(providerId, now)
    const cost = Math.max(1, Math.floor(tokens) || 1)
    // Only track per-second timestamps when a per-second limit exists; an
    // unlimited provider would otherwise accumulate needless entries.
    if (state.limits.perSecond != null) {
      for (let i = 0; i < cost; i++) state.secTimestamps.push(now)
    }
    state.dayCount += cost
    return true
  }

  async getRemaining(providerId: string): Promise<{ perSecondRemaining: number | null; perDayRemaining: number | null }> {
    const state = this.refresh(providerId, Date.now())
    const { perSecond, perDay } = state.limits
    const perSecondRemaining = perSecond == null ? null : Math.max(0, perSecond - state.secTimestamps.length)
    const perDayRemaining = perDay == null ? null : Math.max(0, perDay - state.dayCount)
    return { perSecondRemaining, perDayRemaining }
  }
}

// Persist singletons on globalThis to survive Next.js dev-mode module
// re-evaluations — losing the dedup/cursor/budget stores causes duplicate
// broadcasts and resets rate-limit counters.
const _st = globalThis as any
if (!_st.__GAIALOG_STORES__) {
  _st.__GAIALOG_STORES__ = {
    cache: new InMemoryCacheStore(),
    dedupe: new InMemoryDedupeStore(),
    cursor: new InMemoryCursorStore(),
    budget: new InMemoryBudgetStore(),
  }
}
export const cacheStore: InMemoryCacheStore = _st.__GAIALOG_STORES__.cache
export const dedupeStore: InMemoryDedupeStore = _st.__GAIALOG_STORES__.dedupe
export const cursorStore: InMemoryCursorStore = _st.__GAIALOG_STORES__.cursor
export const budgetStore: InMemoryBudgetStore = _st.__GAIALOG_STORES__.budget


