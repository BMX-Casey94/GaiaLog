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
//
// A delayed reading is held here until its release time, then handed back so it
// can proceed to the queue. The buffer previously stored `payload: {}` and
// `releaseExpiredDelays()` returned only the keys — nothing could be recovered
// from a release, so every delayed reading was dropped silently. The payload is
// now retained, bounded so a long provider outage cannot grow the buffer
// without limit.
//
// What is stored is the payload *after* redaction and coordinate rounding, not
// the raw reading: held data sits in process memory for up to the delay window,
// and there is no reason for the sensitive fields to be in it.

/** Maximum retained delayed readings. Oldest is evicted first at the cap. */
export const MAX_DELAYED_ITEMS = 5_000

export interface DelayedItem {
  key: string
  payload: any
}

interface DelayEntry {
  payload: any
  releaseAt: number
  queuedAt: number
}

// Insertion-ordered, so the first key in iteration is the oldest entry.
const _delayQueue = new Map<string, DelayEntry>()

let _delayEvictionWarnedAt = 0

function evictOldestIfFull(): void {
  while (_delayQueue.size >= MAX_DELAYED_ITEMS) {
    const oldest = _delayQueue.keys().next()
    if (oldest.done) return
    _delayQueue.delete(oldest.value)
    const now = Date.now()
    if (now - _delayEvictionWarnedAt > 60_000) {
      _delayEvictionWarnedAt = now
      console.warn(
        `⚠️  Sensitivity delay buffer at capacity (${MAX_DELAYED_ITEMS}); evicted oldest held reading. ` +
          `Held readings are being produced faster than their delay windows expire.`,
      )
    }
  }
}

/**
 * Returns true when this key must be held back.
 *
 * `payload` is what will be handed back on release. Omitting it retains the
 * previous behaviour of holding an empty placeholder, which is only useful to
 * callers that want the gate without the data.
 */
export function shouldDelay(
  key: string,
  delayHours: number,
  now: number = Date.now(),
  payload?: any,
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

  evictOldestIfFull()
  _delayQueue.set(key, {
    payload: payload ?? {},
    releaseAt: now + delayHours * 60 * 60 * 1000,
    queuedAt: now,
  })
  return true
}

export function getDelayedItemCount(): number {
  return _delayQueue.size
}

/** Release time (epoch ms) for a held key, or null when it is not held. */
export function getDelayedReleaseAt(key: string): number | null {
  return _delayQueue.get(key)?.releaseAt ?? null
}

/**
 * Remove and return every entry whose release time has passed.
 *
 * `keyPrefix` scopes the drain. Either a string prefix matched against the
 * buffer key, or a predicate for callers that need a richer rule. Keys are
 * built as `${workerId}:${family}:${providerId}:${timestamp}`, so a worker
 * passes its own `workerId` prefix and receives only the readings it collected —
 * two workers can never take the same released entry.
 *
 * Entries are deleted as they are returned, so each held reading is handed out
 * exactly once.
 */
export function releaseExpiredDelays(
  now: number = Date.now(),
  keyPrefix?: string | ((key: string) => boolean),
): DelayedItem[] {
  const matches = typeof keyPrefix === 'function'
    ? keyPrefix
    : keyPrefix
      ? (key: string) => key.startsWith(keyPrefix)
      : null
  const released: DelayedItem[] = []
  for (const [key, item] of _delayQueue) {
    if (now < item.releaseAt) continue
    if (matches && !matches(key)) continue
    _delayQueue.delete(key)
    released.push({ key, payload: item.payload })
  }
  return released
}

/**
 * Key-only form of {@link releaseExpiredDelays}.
 *
 * Retained for callers that only need to know what expired. Using it discards
 * the held payload, so the reading it described is lost — prefer the item form.
 */
export function releaseExpiredDelayKeys(now: number = Date.now()): string[] {
  return releaseExpiredDelays(now).map((item) => item.key)
}

/**
 * Put a released entry back into the buffer with a new release time.
 *
 * Lets a caller that could not act on a released reading — typically because the
 * queue refused it — return it to the buffer instead of dropping it. `releaseAt`
 * is absolute epoch milliseconds, so the caller controls the retry cadence
 * without needing to express it in the policy's unit of hours.
 *
 * An existing entry under the same key is replaced, so a re-hold is idempotent.
 */
export function reholdDelayedItem(key: string, releaseAt: number, payload: unknown): void {
  evictOldestIfFull()
  // Delete first so the re-inserted entry is treated as the newest for
  // eviction-order purposes rather than keeping its original insertion slot.
  _delayQueue.delete(key)
  _delayQueue.set(key, { payload, releaseAt, queuedAt: Date.now() })
}

// ─── Full Pipeline Application ───────────────────────────────────────────────

export interface SensitivityResult {
  allowed: boolean
  delayed: boolean
  policy: SensitivityPolicy
  payload: Record<string, unknown>
  coordinates: { lat: number | null; lon: number | null }
  /**
   * Present only when `delayed` is true. Carries what the caller must hold and
   * later re-feed into the pipeline once the delay expires.
   */
  delay?: {
    /** Buffer key; also the prefix-scoping key used when draining. */
    key: string
    /** Release time, epoch milliseconds. */
    releaseAt: number
    /** Redacted payload to enqueue on release. */
    payload: Record<string, unknown>
    /** Coordinates after the family/provider precision policy. */
    coordinates: { lat: number | null; lon: number | null }
  }
}

export function applySensitivityControls(
  payload: Record<string, unknown>,
  opts: {
    family?: DataFamily | null
    providerId?: ProviderId | null
    dedupeKey?: string
    lat?: number | null
    lon?: number | null
    /**
     * Builds the value kept in the hold buffer when this reading is delayed.
     *
     * Called with the already-redacted payload and rounded coordinates, so the
     * caller can attach the surrounding record (type, source, hash, …) needed to
     * re-enqueue the reading on release without re-deriving the policy. Defaults
     * to `{ payload, coordinates }`.
     */
    holdValue?: (redacted: Record<string, unknown>, coordinates: { lat: number | null; lon: number | null }) => unknown
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

  // Redact and round before anything is held: the delay buffer keeps memory
  // resident for the whole delay window, so sensitive fields must not be in it.
  const redacted = redactFields(payload, policy.redactFields)
  const coordinates = applyCoordinatePolicy(opts.lat, opts.lon, policy.coordinatePrecision)

  const now = Date.now()
  // Only build the held value when there is a delay to hold it for: the
  // callback allocates a full queue record, and the overwhelming majority of
  // readings carry delayHours = 0.
  const held = policy.delayHours > 0
    ? (opts.holdValue ? opts.holdValue(redacted, coordinates) : { payload: redacted, coordinates })
    : undefined
  const delayed = shouldDelay(dedupeKey, policy.delayHours, now, held)
  if (delayed) {
    return {
      allowed: false,
      delayed: true,
      policy,
      payload: redacted,
      coordinates,
      delay: {
        key: dedupeKey,
        releaseAt: now + policy.delayHours * 60 * 60 * 1000,
        payload: redacted,
        coordinates,
      },
    }
  }

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
