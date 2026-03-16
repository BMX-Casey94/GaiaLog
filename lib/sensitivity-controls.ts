/**
 * GaiaLog Sensitivity & Redaction Controls
 *
 * Centralised policy enforcement for data that should be redacted, delayed,
 * or blocked before persistence and blockchain writes.  This module sits
 * between the collectors and the persistence/queue layer.
 *
 * Policy categories:
 *   1. Coordinate precision  – round exact co-ordinates to grid cells
 *   2. Delayed publishing    – hold back sensitive records for N hours
 *   3. Field redaction       – strip named fields from the blockchain payload
 *   4. Family gating         – block entire families from chain writes
 *   5. Species sensitivity   – suppress exact locations for known-sensitive taxa
 */

import type { DataFamily } from './stream-registry'
import type { ProviderId } from './stream-registry'

// ─── Configuration Types ─────────────────────────────────────────────────────

export type CoordinatePrecision = 'exact' | 'rounded_01' | 'rounded_1' | 'country_centroid' | 'suppressed'

export interface SensitivityPolicy {
  coordinatePrecision: CoordinatePrecision
  delayHours: number
  redactFields: string[]
  blockChainWrite: boolean
  reason?: string
}

export interface FamilyPolicy extends SensitivityPolicy {
  family: DataFamily
}

export interface ProviderPolicy extends SensitivityPolicy {
  providerId: ProviderId
}

// ─── Default Policies ────────────────────────────────────────────────────────

const DEFAULT_POLICY: SensitivityPolicy = {
  coordinatePrecision: 'exact',
  delayHours: 0,
  redactFields: [],
  blockChainWrite: false,
}

const FAMILY_POLICIES: Partial<Record<DataFamily, Partial<SensitivityPolicy>>> = {
  conservation_status: {
    coordinatePrecision: 'rounded_1',
    delayHours: 0,
    redactFields: [],
    reason: 'Conservation listings are public but exact locations should not be precise.',
  },
  biodiversity: {
    coordinatePrecision: 'rounded_01',
    delayHours: 0,
    redactFields: [],
    reason: 'General biodiversity observations may include sensitive taxa.',
  },
  transport_tracking: {
    coordinatePrecision: 'rounded_01',
    delayHours: 1,
    redactFields: ['callsign'],
    reason: 'Transport positions are delayed to avoid real-time tracking concerns.',
  },
  planning_development: {
    coordinatePrecision: 'exact',
    delayHours: 0,
    redactFields: ['applicant_name', 'agent_name', 'applicant_address'],
    reason: 'Planning data is public but personal applicant details should be redacted.',
  },
}

const PROVIDER_POLICIES: Partial<Record<ProviderId, Partial<SensitivityPolicy>>> = {
  movebank: {
    coordinatePrecision: 'rounded_1',
    delayHours: 24,
    redactFields: ['individual_id', 'tag_id'],
    reason: 'Animal tracking data is highly sensitive for endangered species.',
  },
  aisstream: {
    coordinatePrecision: 'rounded_01',
    delayHours: 1,
    redactFields: [],
    reason: 'Vessel positions delayed to avoid operational intelligence exposure.',
  },
}

const SENSITIVE_TAXA_PATTERNS = [
  /rhinocer/i, /elephant/i, /pangolin/i, /tiger/i, /gorilla/i,
  /orangutan/i, /snow\s*leopard/i, /vaquita/i, /saola/i,
  /kakapo/i, /amur\s*leopard/i, /sumatran/i, /javan\s*rhino/i,
  /black\s*rhino/i, /hawksbill/i, /leatherback/i,
]

// ─── Policy Resolution ───────────────────────────────────────────────────────

export function resolvePolicy(
  family?: DataFamily | null,
  providerId?: ProviderId | null,
): SensitivityPolicy {
  const base = { ...DEFAULT_POLICY }

  if (family && FAMILY_POLICIES[family]) {
    const fp = FAMILY_POLICIES[family]!
    if (fp.coordinatePrecision) base.coordinatePrecision = fp.coordinatePrecision
    if (fp.delayHours != null) base.delayHours = Math.max(base.delayHours, fp.delayHours)
    if (fp.redactFields) base.redactFields = [...base.redactFields, ...fp.redactFields]
    if (fp.blockChainWrite) base.blockChainWrite = true
    if (fp.reason) base.reason = fp.reason
  }

  if (providerId && PROVIDER_POLICIES[providerId]) {
    const pp = PROVIDER_POLICIES[providerId]!
    if (pp.coordinatePrecision && precisionRank(pp.coordinatePrecision) > precisionRank(base.coordinatePrecision)) {
      base.coordinatePrecision = pp.coordinatePrecision
    }
    if (pp.delayHours != null) base.delayHours = Math.max(base.delayHours, pp.delayHours)
    if (pp.redactFields) base.redactFields = [...new Set([...base.redactFields, ...pp.redactFields])]
    if (pp.blockChainWrite) base.blockChainWrite = true
    if (pp.reason) base.reason = pp.reason
  }

  return base
}

// ─── Coordinate Rounding ─────────────────────────────────────────────────────

export function roundCoordinate(value: number, precision: CoordinatePrecision): number | null {
  switch (precision) {
    case 'exact':
      return value
    case 'rounded_01':
      return Math.round(value * 10) / 10
    case 'rounded_1':
      return Math.round(value)
    case 'country_centroid':
      return Math.round(value / 5) * 5
    case 'suppressed':
      return null
  }
}

export function applyCoordinatePolicy(
  lat: number | null | undefined,
  lon: number | null | undefined,
  precision: CoordinatePrecision,
): { lat: number | null; lon: number | null } {
  if (lat == null || lon == null) return { lat: null, lon: null }
  return {
    lat: roundCoordinate(lat, precision),
    lon: roundCoordinate(lon, precision),
  }
}

// ─── Field Redaction ─────────────────────────────────────────────────────────

export function redactFields<T extends Record<string, unknown>>(
  payload: T,
  fieldsToRedact: string[],
): T {
  if (fieldsToRedact.length === 0) return payload
  const redacted = { ...payload }
  for (const field of fieldsToRedact) {
    if (field in redacted) {
      delete (redacted as any)[field]
    }
  }
  return redacted
}

// ─── Species Sensitivity Check ───────────────────────────────────────────────

export function isSensitiveTaxon(speciesName: string): boolean {
  if (!speciesName) return false
  return SENSITIVE_TAXA_PATTERNS.some(pattern => pattern.test(speciesName))
}

export function applySensitiveSpeciesPolicy(
  payload: Record<string, unknown>,
  policy: SensitivityPolicy,
): { payload: Record<string, unknown>; policy: SensitivityPolicy } {
  const species = String(payload.species || payload.scientific_name || payload.scientificName || '')
  if (!isSensitiveTaxon(species)) return { payload, policy }

  const upgraded: SensitivityPolicy = {
    ...policy,
    coordinatePrecision: 'rounded_1',
    delayHours: Math.max(policy.delayHours, 48),
    reason: `Sensitive taxon detected: ${species}. Coordinates rounded and publishing delayed.`,
  }
  return { payload, policy: upgraded }
}

// ─── Delay Gate ──────────────────────────────────────────────────────────────

const _delayQueue = new Map<string, { payload: Record<string, unknown>; releaseAt: number }>()

export function shouldDelay(
  key: string,
  delayHours: number,
  now: number = Date.now(),
): boolean {
  if (delayHours <= 0) return false

  const existing = _delayQueue.get(key)
  if (existing) {
    if (now >= existing.releaseAt) {
      _delayQueue.delete(key)
      return false
    }
    return true
  }

  _delayQueue.set(key, { payload: {}, releaseAt: now + delayHours * 60 * 60 * 1000 })
  return true
}

export function getDelayedItemCount(): number {
  return _delayQueue.size
}

export function releaseExpiredDelays(now: number = Date.now()): string[] {
  const released: string[] = []
  for (const [key, item] of _delayQueue) {
    if (now >= item.releaseAt) {
      _delayQueue.delete(key)
      released.push(key)
    }
  }
  return released
}

// ─── Full Pipeline Application ───────────────────────────────────────────────

export interface SensitivityResult {
  allowed: boolean
  delayed: boolean
  policy: SensitivityPolicy
  payload: Record<string, unknown>
  coordinates: { lat: number | null; lon: number | null }
}

export function applySensitivityControls(
  payload: Record<string, unknown>,
  opts: {
    family?: DataFamily | null
    providerId?: ProviderId | null
    dedupeKey?: string
    lat?: number | null
    lon?: number | null
  },
): SensitivityResult {
  let policy = resolvePolicy(opts.family, opts.providerId)

  if (opts.family === 'biodiversity' || opts.family === 'conservation_status') {
    const result = applySensitiveSpeciesPolicy(payload, policy)
    policy = result.policy
  }

  if (policy.blockChainWrite) {
    return {
      allowed: false,
      delayed: false,
      policy,
      payload,
      coordinates: { lat: null, lon: null },
    }
  }

  const dedupeKey = opts.dedupeKey || `${opts.family}:${opts.providerId}:${Date.now()}`
  const delayed = shouldDelay(dedupeKey, policy.delayHours)
  if (delayed) {
    return {
      allowed: false,
      delayed: true,
      policy,
      payload,
      coordinates: { lat: null, lon: null },
    }
  }

  const redacted = redactFields(payload, policy.redactFields)
  const coordinates = applyCoordinatePolicy(opts.lat, opts.lon, policy.coordinatePrecision)

  return {
    allowed: true,
    delayed: false,
    policy,
    payload: redacted,
    coordinates,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function precisionRank(p: CoordinatePrecision): number {
  switch (p) {
    case 'exact': return 0
    case 'rounded_01': return 1
    case 'rounded_1': return 2
    case 'country_centroid': return 3
    case 'suppressed': return 4
  }
}
