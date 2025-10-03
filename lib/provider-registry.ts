import { budgetStore, BudgetLimits, cursorStore } from './stores'

export type ProviderId = 'waqi' | 'weatherapi' | 'noaa' | 'usgs' | 'owm'

export interface ProviderCadenceConfig {
  // Default polling interval in milliseconds
  intervalMs: number
  // Minimum interval when data is very active
  minIntervalMs?: number
  // Maximum interval when data is very stable
  maxIntervalMs?: number
}

export interface ThrottleConfig {
  perSecond?: number
}

export interface BreakerConfig {
  consecutiveFailures: number
  errorRateThreshold: number // 0..1 over rolling window
  minCallsForErrorRate: number
  burst429PerMinute: number
  cooldownMs: number
}

export interface ProviderConfig {
  id: ProviderId
  purpose: string
  cadence: ProviderCadenceConfig
  budgets: BudgetLimits // perSecond / perDay
  throttle: ThrottleConfig
  breaker: BreakerConfig
  countries?: {
    allow?: string[]
    deny?: string[]
    quotas?: Record<string, { perDay?: number; perMinute?: number }>
  }
}

const DEFAULT_BREAKER: BreakerConfig = {
  consecutiveFailures: 5,
  errorRateThreshold: 0.4,
  minCallsForErrorRate: 20,
  burst429PerMinute: 3,
  cooldownMs: 2 * 60 * 1000,
}

const n = (v: string | undefined, d: number) => {
  const x = v != null ? Number(v) : NaN
  return Number.isFinite(x) && x >= 0 ? x : d
}

export const providerConfigs: Record<ProviderId, ProviderConfig> = {
  waqi: {
    id: 'waqi',
    purpose: 'Air quality anchor (rotating subset)',
    cadence: { intervalMs: 2 * 60 * 60 * 1000, minIntervalMs: 60 * 60 * 1000, maxIntervalMs: 8 * 60 * 60 * 1000 },
    budgets: { perSecond: n(process.env.WAQI_RPS, 1), perDay: n(process.env.WAQI_PER_DAY, 33) },
    throttle: { perSecond: n(process.env.WAQI_RPS, 1) },
    breaker: DEFAULT_BREAKER,
  },
  weatherapi: {
    id: 'weatherapi',
    purpose: 'Primary breadth for air/weather metrics',
    cadence: { intervalMs: 30 * 60 * 1000, minIntervalMs: 15 * 60 * 1000, maxIntervalMs: 60 * 60 * 1000 },
    budgets: { perSecond: n(process.env.WEATHERAPI_RPS, 5) },
    throttle: { perSecond: n(process.env.WEATHERAPI_RPS, 5) },
    breaker: DEFAULT_BREAKER,
  },
  noaa: {
    id: 'noaa',
    purpose: 'Water levels/tides (US stations, batched)',
    cadence: { intervalMs: 60 * 60 * 1000, minIntervalMs: 30 * 60 * 1000, maxIntervalMs: 2 * 60 * 1000 * 60 },
    budgets: { perSecond: n(process.env.NOAA_RPS, 5), perDay: n(process.env.NOAA_PER_DAY, 10000) },
    throttle: { perSecond: n(process.env.NOAA_RPS, 5) },
    breaker: DEFAULT_BREAKER,
  },
  usgs: {
    id: 'usgs',
    purpose: 'Seismic events (windowed)',
    cadence: { intervalMs: 15 * 60 * 1000, minIntervalMs: 5 * 60 * 1000, maxIntervalMs: 30 * 60 * 1000 },
    budgets: { perSecond: n(process.env.USGS_RPS, 1) },
    throttle: { perSecond: n(process.env.USGS_RPS, 1) },
    breaker: DEFAULT_BREAKER,
  },
  owm: {
    id: 'owm',
    purpose: 'Redundancy for weather/air quality',
    cadence: { intervalMs: 30 * 60 * 1000, minIntervalMs: 15 * 60 * 1000, maxIntervalMs: 60 * 60 * 1000 },
    budgets: { perSecond: n(process.env.OWM_RPS, 5) },
    throttle: { perSecond: n(process.env.OWM_RPS, 5) },
    breaker: DEFAULT_BREAKER,
  },
}

export async function initializeProviderBudgets(): Promise<void> {
  for (const cfg of Object.values(providerConfigs)) {
    await budgetStore.configure(cfg.id, cfg.budgets)
  }
}

export function getProviderConfig(id: ProviderId): ProviderConfig {
  return providerConfigs[id]
}

export async function getProviderCursor(provider: ProviderId, resourceKey?: string): Promise<string | number | null> {
  return cursorStore.get(provider, resourceKey)
}

export async function setProviderCursor(provider: ProviderId, cursor: string | number, resourceKey?: string): Promise<void> {
  return cursorStore.set(provider, cursor, resourceKey)
}


