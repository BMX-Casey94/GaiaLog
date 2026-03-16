import { budgetStore, BudgetLimits, cursorStore } from './stores'
import {
  DATASET_DESCRIPTORS,
  DatasetId,
  ProviderId,
  PROVIDER_DESCRIPTORS,
  QueueLane,
  QueuePriority,
} from './stream-registry'
import { RolloutGate, RolloutRule, getRequestedRolloutGate, isRolloutGateEnabled } from './rollout-controls'

export type { ProviderId, DatasetId } from './stream-registry'

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
  queueLane: QueueLane
  defaultPriority: QueuePriority
  configuredEnabled: boolean
  enabled: boolean
  chunkSize: number
  maxInFlight: number
  tokenCost: number
  kind: typeof PROVIDER_DESCRIPTORS[ProviderId]['kind']
  throughputClass: typeof PROVIDER_DESCRIPTORS[ProviderId]['throughputClass']
  keyRequired: boolean
  blockchainFriendly: boolean
  attributionRequired?: boolean
  sourceAliases: string[]
  countries?: {
    allow?: string[]
    deny?: string[]
    quotas?: Record<string, { perDay?: number; perMinute?: number }>
  }
  requestedRolloutGate: RolloutGate
  rolloutEnabled: boolean
  rollout: RolloutRule
}

export interface ProviderDatasetConfig {
  id: DatasetId
  providerId: ProviderId
  family: typeof DATASET_DESCRIPTORS[DatasetId]['family']
  displayName: string
  sourceLabel: string
  cadence: ProviderCadenceConfig
  budgets: BudgetLimits
  throttle: ThrottleConfig
  queueLane: QueueLane
  defaultPriority: QueuePriority
  configuredEnabled: boolean
  enabled: boolean
  chunkSize: number
  maxInFlight: number
  tokenCost: number
  keyRequired: boolean
  blockchainFriendly: boolean
  kind: typeof DATASET_DESCRIPTORS[DatasetId]['kind']
  metricPreviewKeys?: string[]
  requestedRolloutGate: RolloutGate
  rolloutEnabled: boolean
  rollout: RolloutRule
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

const text = (v: string | undefined, d: string) => {
  const trimmed = (v || '').trim()
  return trimmed || d
}

const bool = (v: string | undefined, d: boolean) => {
  if (v == null || v.trim() === '') return d
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())
}

const toEnvPrefix = (value: string) => value.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()

const PROVIDER_ENV_OVERRIDES: Partial<Record<ProviderId, {
  rpsEnv: string
  perDayEnv?: string
  intervalEnv?: string
  enabledEnv?: string
  chunkEnv?: string
  maxInFlightEnv?: string
  tokenCostEnv?: string
}>> = {
  waqi: {
    rpsEnv: 'WAQI_RPS',
    perDayEnv: 'WAQI_PER_DAY',
    intervalEnv: 'WAQI_WORKER_INTERVAL_MS',
  },
  weatherapi: {
    rpsEnv: 'WEATHERAPI_RPS',
    perDayEnv: 'WEATHERAPI_PER_DAY',
    intervalEnv: 'ADVANCED_WORKER_INTERVAL_MS',
  },
  noaa: {
    rpsEnv: 'NOAA_RPS',
    perDayEnv: 'NOAA_PER_DAY',
    intervalEnv: 'NOAA_WORKER_INTERVAL_MS',
  },
  noaa_ndbc: {
    rpsEnv: 'NDBC_RPS',
    perDayEnv: 'NDBC_PER_DAY',
    intervalEnv: 'NDBC_WORKER_INTERVAL_MS',
  },
  noaa_space_weather: {
    rpsEnv: 'NOAA_SPACE_WEATHER_RPS',
    perDayEnv: 'NOAA_SPACE_WEATHER_PER_DAY',
    intervalEnv: 'NOAA_SPACE_WEATHER_WORKER_INTERVAL_MS',
  },
  usgs: {
    rpsEnv: 'USGS_RPS',
    perDayEnv: 'USGS_PER_DAY',
    intervalEnv: 'USGS_WORKER_INTERVAL_MS',
  },
  usgs_geomagnetism: {
    rpsEnv: 'USGS_GEOMAGNETISM_RPS',
    perDayEnv: 'USGS_GEOMAGNETISM_PER_DAY',
    intervalEnv: 'USGS_GEOMAGNETISM_WORKER_INTERVAL_MS',
  },
  usgs_volcanoes: {
    rpsEnv: 'USGS_VOLCANOES_RPS',
    perDayEnv: 'USGS_VOLCANOES_PER_DAY',
    intervalEnv: 'USGS_VOLCANOES_WORKER_INTERVAL_MS',
  },
  owm: {
    rpsEnv: 'OWM_RPS',
    perDayEnv: 'OWM_PER_DAY',
    intervalEnv: 'ADVANCED_WORKER_INTERVAL_MS',
  },
  sensor_community: {
    rpsEnv: 'SENSOR_COMMUNITY_RPS',
    perDayEnv: 'SENSOR_COMMUNITY_PER_DAY',
    intervalEnv: 'SENSOR_COMMUNITY_WORKER_INTERVAL_MS',
  },
  emsc: {
    rpsEnv: 'EMSC_RPS',
    perDayEnv: 'EMSC_PER_DAY',
    intervalEnv: 'EMSC_WORKER_INTERVAL_MS',
  },
  geonet: {
    rpsEnv: 'GEONET_RPS',
    perDayEnv: 'GEONET_PER_DAY',
    intervalEnv: 'GEONET_WORKER_INTERVAL_MS',
  },
  iris: {
    rpsEnv: 'IRIS_RPS',
    perDayEnv: 'IRIS_PER_DAY',
    intervalEnv: 'IRIS_WORKER_INTERVAL_MS',
  },
  opensensemap: {
    rpsEnv: 'OPENSENSEMAP_RPS',
    perDayEnv: 'OPENSENSEMAP_PER_DAY',
    intervalEnv: 'OPENSENSEMAP_WORKER_INTERVAL_MS',
  },
  intermagnet: {
    rpsEnv: 'INTERMAGNET_RPS',
    perDayEnv: 'INTERMAGNET_PER_DAY',
    intervalEnv: 'INTERMAGNET_WORKER_INTERVAL_MS',
  },
  copernicus_cams: {
    rpsEnv: 'COPERNICUS_CAMS_RPS',
    perDayEnv: 'COPERNICUS_CAMS_PER_DAY',
    intervalEnv: 'COPERNICUS_CAMS_WORKER_INTERVAL_MS',
  },
  nasa_power: {
    rpsEnv: 'NASA_POWER_RPS',
    perDayEnv: 'NASA_POWER_PER_DAY',
    intervalEnv: 'NASA_POWER_WORKER_INTERVAL_MS',
  },
  igra2: {
    rpsEnv: 'IGRA2_RPS',
    perDayEnv: 'IGRA2_PER_DAY',
    intervalEnv: 'IGRA2_WORKER_INTERVAL_MS',
  },
}

const DEFAULT_RATE_LIMITS: Record<ProviderId, BudgetLimits> = {
  waqi: { perSecond: 2, perDay: 100000 },
  weatherapi: { perSecond: 5 },
  noaa: { perSecond: 10, perDay: 100000 },
  noaa_ndbc: { perSecond: 5 },
  noaa_space_weather: { perSecond: 1 },
  usgs: { perSecond: 1 },
  usgs_geomagnetism: { perSecond: 1 },
  usgs_volcanoes: { perSecond: 1 },
  owm: { perSecond: 5 },
  sensor_community: { perSecond: 1 },
  emsc: { perSecond: 1 },
  geonet: { perSecond: 1 },
  iris: { perSecond: 1 },
  opensensemap: { perSecond: 1 },
  intermagnet: { perSecond: 1 },
  copernicus_cams: { perSecond: 1 },
  nasa_power: { perSecond: 1, perDay: 30 },
  igra2: { perSecond: 1 },
}

const DEFAULT_INTERVALS_MS: Record<ProviderId, number> = {
  waqi: 15 * 60 * 1000,
  weatherapi: 30 * 60 * 1000,
  noaa: 6 * 60 * 1000,
  noaa_ndbc: 5 * 60 * 1000,
  noaa_space_weather: 60 * 1000,
  usgs: 5 * 60 * 1000,
  usgs_geomagnetism: 60 * 1000,
  usgs_volcanoes: 10 * 60 * 1000,
  owm: 30 * 60 * 1000,
  sensor_community: 5 * 60 * 1000,
  emsc: 60 * 1000,
  geonet: 5 * 60 * 1000,
  iris: 15 * 60 * 1000,
  opensensemap: 15 * 60 * 1000,
  intermagnet: 60 * 1000,
  copernicus_cams: 6 * 60 * 60 * 1000,
  nasa_power: 12 * 60 * 60 * 1000,
  igra2: 12 * 60 * 60 * 1000,
}

const PROVIDER_KEY_ENV: Partial<Record<ProviderId, string>> = {
  waqi: 'WAQI_API_KEY',
  weatherapi: 'WEATHERAPI_KEY',
  owm: 'OWM_API_KEY',
  copernicus_cams: 'COPERNICUS_CAMS_API_KEY',
}

function getProviderEnvOverride(providerId: ProviderId) {
  return PROVIDER_ENV_OVERRIDES[providerId] || {
    rpsEnv: `${toEnvPrefix(providerId)}_RPS`,
    perDayEnv: `${toEnvPrefix(providerId)}_PER_DAY`,
    intervalEnv: `${toEnvPrefix(providerId)}_WORKER_INTERVAL_MS`,
  }
}

function getProviderBudgets(providerId: ProviderId): BudgetLimits {
  const defaults = DEFAULT_RATE_LIMITS[providerId]
  const envs = getProviderEnvOverride(providerId)
  const perSecond = n(process.env[envs.rpsEnv], defaults.perSecond ?? 0)
  const perDayEnv = envs.perDayEnv ? process.env[envs.perDayEnv] : undefined
  const budgets: BudgetLimits = {}
  if (defaults.perSecond != null || perSecond > 0) budgets.perSecond = perSecond
  if (perDayEnv != null && perDayEnv !== '') budgets.perDay = n(perDayEnv, defaults.perDay ?? 0)
  else if (defaults.perDay != null) budgets.perDay = defaults.perDay
  return budgets
}

function isProviderEnabled(providerId: ProviderId): boolean {
  const descriptor = PROVIDER_DESCRIPTORS[providerId]
  const prefix = toEnvPrefix(providerId)
  const envs = getProviderEnvOverride(providerId)
  const keyEnv = PROVIDER_KEY_ENV[providerId]
  const defaultEnabled = descriptor.keyRequired ? !!(keyEnv && process.env[keyEnv]) : true
  return bool(process.env[envs.enabledEnv || `${prefix}_ENABLED`], defaultEnabled)
}

function getProviderInterval(providerId: ProviderId): number {
  const envs = getProviderEnvOverride(providerId)
  return n(process.env[envs.intervalEnv || `${toEnvPrefix(providerId)}_WORKER_INTERVAL_MS`], DEFAULT_INTERVALS_MS[providerId])
}

function getProviderChunkSize(providerId: ProviderId): number {
  const dataset = Object.values(DATASET_DESCRIPTORS).find(candidate => candidate.providerId === providerId)
  const fallback = dataset?.defaultChunkSize || 100
  const envs = getProviderEnvOverride(providerId)
  return Math.max(1, n(process.env[envs.chunkEnv || `${toEnvPrefix(providerId)}_CHUNK_SIZE`], fallback))
}

function getProviderMaxInFlight(providerId: ProviderId): number {
  const fallback = Math.max(100, getProviderChunkSize(providerId) * 4)
  const envs = getProviderEnvOverride(providerId)
  return Math.max(1, n(process.env[envs.maxInFlightEnv || `${toEnvPrefix(providerId)}_MAX_IN_FLIGHT`], fallback))
}

function getProviderTokenCost(providerId: ProviderId): number {
  const envs = getProviderEnvOverride(providerId)
  return Math.max(1, n(process.env[envs.tokenCostEnv || `${toEnvPrefix(providerId)}_TOKEN_COST`], 1))
}

function getProviderPriority(providerId: ProviderId): QueuePriority {
  const prefix = toEnvPrefix(providerId)
  const fallback = ['seismic_activity', 'space_weather', 'volcanic_activity'].includes(PROVIDER_DESCRIPTORS[providerId].primaryFamily)
    ? 'high'
    : 'normal'
  return text(process.env[`${prefix}_QUEUE_PRIORITY`], fallback) === 'high' ? 'high' : 'normal'
}

function getProviderQueueLane(providerId: ProviderId): QueueLane {
  const prefix = toEnvPrefix(providerId)
  const fallback = PROVIDER_DESCRIPTORS[providerId].queueLane
  return text(process.env[`${prefix}_QUEUE_LANE`], fallback) === 'coverage' ? 'coverage' : 'throughput'
}

const PROVIDER_COUNTRIES: Partial<Record<ProviderId, ProviderConfig['countries']>> = {
  waqi: {},
  weatherapi: {},
  noaa: {},
}

const PROVIDER_ROLLOUT_RULES: Record<ProviderId, RolloutRule> = {
  waqi: { phase: 1, minimumGate: 'gate_a', note: 'Keep the existing WAQI utility online throughout the rollout.' },
  weatherapi: { phase: 1, minimumGate: 'gate_a', note: 'Keep the existing WeatherAPI-derived utility online throughout the rollout.' },
  noaa: { phase: 1, minimumGate: 'gate_a', recommendedOrder: 3, note: 'Expanded NOAA CO-OPS is one of the initial throughput multipliers.' },
  noaa_ndbc: { phase: 1, minimumGate: 'gate_a', recommendedOrder: 2, note: 'NOAA NDBC is a first-wave bulk source for the throughput lane.' },
  noaa_space_weather: { phase: 1, minimumGate: 'gate_b', note: 'High-value 1-min cadence solar wind sensor from DSCOVR/ACE.' },
  usgs: { phase: 1, minimumGate: 'gate_a', note: 'Keep the existing USGS seismic utility online throughout the rollout.' },
  usgs_geomagnetism: { phase: 1, minimumGate: 'gate_b', note: '14 USGS observatories with 1-min cadence magnetic field data.' },
  usgs_volcanoes: { phase: 1, minimumGate: 'gate_b', note: '170+ US volcanoes with alert levels and monitoring data.' },
  owm: { phase: 1, minimumGate: 'gate_a', note: 'Keep the existing OWM-derived utility online throughout the rollout.' },
  sensor_community: { phase: 1, minimumGate: 'gate_a', recommendedOrder: 1, note: 'Highest-yield no-key bulk source for early throughput expansion.' },
  emsc: { phase: 1, minimumGate: 'gate_a', recommendedOrder: 4, note: 'Real-time push seismic source for early throughput expansion.' },
  geonet: { phase: 1, minimumGate: 'gate_a', recommendedOrder: 5, note: 'NZ seismic network, promoted to gate_a for early coverage breadth.' },
  iris: { phase: 3, minimumGate: 'gate_d', note: 'Heavier seismic comparison feed deferred until confirmed throughput is healthy.' },
  opensensemap: { phase: 3, minimumGate: 'gate_d', note: 'Bulk community coverage feed deferred until later rollout gates.' },
  intermagnet: { phase: 2, minimumGate: 'gate_d', note: 'Deferred specialist geomagnetism feed until later rollout gates.' },
  copernicus_cams: { phase: 3, minimumGate: 'gate_d', note: 'Deferred lower-ROI gridded air-quality feed.' },
  nasa_power: { phase: 3, minimumGate: 'gate_d', note: 'Deferred lower-ROI gridded meteorology feed.' },
  igra2: { phase: 1, minimumGate: 'gate_b', note: '2700+ global radiosonde stations with twice-daily soundings.' },
}

export const providerConfigs: Record<ProviderId, ProviderConfig> = Object.fromEntries(
  (Object.keys(PROVIDER_DESCRIPTORS) as ProviderId[]).map((providerId) => {
    const descriptor = PROVIDER_DESCRIPTORS[providerId]
    const budgets = getProviderBudgets(providerId)
    const configuredEnabled = isProviderEnabled(providerId)
    const requestedRolloutGate = getRequestedRolloutGate()
    const rollout = PROVIDER_ROLLOUT_RULES[providerId]
    const rolloutEnabled = isRolloutGateEnabled(rollout.minimumGate, requestedRolloutGate)
    return [providerId, {
      id: providerId,
      purpose: descriptor.displayName,
      cadence: {
        intervalMs: getProviderInterval(providerId),
        minIntervalMs: Math.max(60 * 1000, Math.floor(getProviderInterval(providerId) / 2)),
        maxIntervalMs: Math.max(getProviderInterval(providerId), getProviderInterval(providerId) * 4),
      },
      budgets,
      throttle: { perSecond: budgets.perSecond },
      breaker: DEFAULT_BREAKER,
      queueLane: getProviderQueueLane(providerId),
      defaultPriority: getProviderPriority(providerId),
      configuredEnabled,
      enabled: configuredEnabled && rolloutEnabled,
      chunkSize: getProviderChunkSize(providerId),
      maxInFlight: getProviderMaxInFlight(providerId),
      tokenCost: getProviderTokenCost(providerId),
      kind: descriptor.kind,
      throughputClass: descriptor.throughputClass,
      keyRequired: descriptor.keyRequired,
      blockchainFriendly: descriptor.blockchainFriendly,
      attributionRequired: descriptor.attributionRequired,
      sourceAliases: descriptor.sourceAliases,
      countries: PROVIDER_COUNTRIES[providerId],
      requestedRolloutGate,
      rolloutEnabled,
      rollout,
    } satisfies ProviderConfig]
  }),
) as Record<ProviderId, ProviderConfig>

export const datasetConfigs: Record<DatasetId, ProviderDatasetConfig> = Object.fromEntries(
  (Object.keys(DATASET_DESCRIPTORS) as DatasetId[]).map((datasetId) => {
    const descriptor = DATASET_DESCRIPTORS[datasetId]
    const provider = providerConfigs[descriptor.providerId]
    const prefix = toEnvPrefix(datasetId)
    const configuredEnabled = bool(process.env[`${prefix}_ENABLED`], provider.configuredEnabled)
    const requestedRolloutGate = provider.requestedRolloutGate
    const rollout = provider.rollout
    const rolloutEnabled = isRolloutGateEnabled(rollout.minimumGate, requestedRolloutGate)
    const enabled = configuredEnabled && rolloutEnabled && provider.enabled
    const intervalMs = Math.max(60 * 1000, n(process.env[`${prefix}_INTERVAL_MS`], provider.cadence.intervalMs || descriptor.defaultIntervalMs))
    const chunkSize = Math.max(1, n(process.env[`${prefix}_CHUNK_SIZE`], provider.chunkSize || descriptor.defaultChunkSize))
    const maxInFlight = Math.max(1, n(process.env[`${prefix}_MAX_IN_FLIGHT`], provider.maxInFlight || Math.max(100, chunkSize * 4)))
    const perSecond = n(process.env[`${prefix}_RPS`], provider.budgets.perSecond ?? 0)
    const perDayEnv = process.env[`${prefix}_PER_DAY`]
    const budgets: BudgetLimits = {}
    if ((provider.budgets.perSecond ?? 0) > 0 || perSecond > 0) budgets.perSecond = perSecond
    if (perDayEnv != null && perDayEnv !== '') budgets.perDay = n(perDayEnv, provider.budgets.perDay ?? 0)
    else if (provider.budgets.perDay != null) budgets.perDay = provider.budgets.perDay
    return [datasetId, {
      id: datasetId,
      providerId: descriptor.providerId,
      family: descriptor.family,
      displayName: descriptor.displayName,
      sourceLabel: descriptor.sourceLabel,
      cadence: {
        intervalMs,
        minIntervalMs: Math.max(60 * 1000, Math.floor(intervalMs / 2)),
        maxIntervalMs: Math.max(intervalMs, intervalMs * 4),
      },
      budgets,
      throttle: { perSecond: budgets.perSecond },
      queueLane: text(process.env[`${prefix}_QUEUE_LANE`], descriptor.queueLane) === 'coverage' ? 'coverage' : 'throughput',
      defaultPriority: text(process.env[`${prefix}_QUEUE_PRIORITY`], descriptor.defaultPriority) === 'high' ? 'high' : 'normal',
      configuredEnabled,
      enabled,
      chunkSize,
      maxInFlight,
      tokenCost: Math.max(1, n(process.env[`${prefix}_TOKEN_COST`], provider.tokenCost)),
      keyRequired: descriptor.keyRequired,
      blockchainFriendly: descriptor.blockchainFriendly,
      kind: descriptor.kind,
      metricPreviewKeys: descriptor.metricPreviewKeys,
      requestedRolloutGate,
      rolloutEnabled,
      rollout,
    } satisfies ProviderDatasetConfig]
  }),
) as Record<DatasetId, ProviderDatasetConfig>

export async function initializeProviderBudgets(): Promise<void> {
  for (const cfg of Object.values(providerConfigs)) {
    await budgetStore.configure(cfg.id, cfg.budgets)
  }
  for (const cfg of Object.values(datasetConfigs)) {
    await budgetStore.configure(cfg.id, cfg.budgets)
  }
}

export function getProviderConfig(id: ProviderId): ProviderConfig {
  return providerConfigs[id]
}

export function getDatasetConfig(id: DatasetId): ProviderDatasetConfig {
  return datasetConfigs[id]
}

export function getEnabledProviderConfigs(): ProviderConfig[] {
  return Object.values(providerConfigs).filter(cfg => cfg.enabled)
}

export function getEnabledDatasetConfigs(): ProviderDatasetConfig[] {
  return Object.values(datasetConfigs).filter(cfg => cfg.enabled)
}

export async function getProviderCursor(provider: string, resourceKey?: string): Promise<string | number | null> {
  return cursorStore.get(provider, resourceKey)
}

export async function setProviderCursor(provider: string, cursor: string | number, resourceKey?: string): Promise<void> {
  return cursorStore.set(provider, cursor, resourceKey)
}


