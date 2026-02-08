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

export interface BudgetStore {
  configure(providerId: string, limits: BudgetLimits): Promise<void>
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
  // Per-second rolling window
  secWindowStart: number
  secCount: number
  // Per-day (UTC) counter
  dayKey: string
  dayCount: number
}

export class InMemoryBudgetStore implements BudgetStore {
  private states = new Map<string, BudgetState>()

  private getDayKey(): string {
    const now = new Date()
    return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`
  }

  async configure(providerId: string, limits: BudgetLimits): Promise<void> {
    const now = Date.now()
    const state: BudgetState = {
      limits,
      secWindowStart: now,
      secCount: 0,
      dayKey: this.getDayKey(),
      dayCount: 0,
    }
    this.states.set(providerId, state)
  }

  private getState(providerId: string): BudgetState {
    let state = this.states.get(providerId)
    if (!state) {
      state = {
        limits: {},
        secWindowStart: Date.now(),
        secCount: 0,
        dayKey: this.getDayKey(),
        dayCount: 0,
      }
      this.states.set(providerId, state)
    }
    // roll per-second window
    const now = Date.now()
    if (now - state.secWindowStart >= 1000) {
      state.secWindowStart = now
      state.secCount = 0
    }
    // roll day counter
    const currentDay = this.getDayKey()
    if (currentDay !== state.dayKey) {
      state.dayKey = currentDay
      state.dayCount = 0
    }
    return state
  }

  async canConsume(providerId: string, tokens: number = 1): Promise<boolean> {
    const state = this.getState(providerId)
    const { perSecond, perDay } = state.limits
    const secOk = perSecond == null || state.secCount + tokens <= perSecond
    const dayOk = perDay == null || state.dayCount + tokens <= perDay
    return secOk && dayOk
  }

  async consume(providerId: string, tokens: number = 1): Promise<boolean> {
    if (!(await this.canConsume(providerId, tokens))) return false
    const state = this.getState(providerId)
    state.secCount += tokens
    state.dayCount += tokens
    return true
  }

  async getRemaining(providerId: string): Promise<{ perSecondRemaining: number | null; perDayRemaining: number | null }> {
    const state = this.getState(providerId)
    const { perSecond, perDay } = state.limits
    const perSecondRemaining = perSecond == null ? null : Math.max(0, perSecond - state.secCount)
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


