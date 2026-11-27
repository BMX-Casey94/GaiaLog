/**
 * BSV Broadcaster client (Arcade lineage).
 *
 * ## The contract that matters
 *
 * `POST {host}/tx` with `Content-Type: application/octet-stream` and BRC-30 EF
 * bytes. Verified against the live public hosts:
 *
 *   - BEEF is rejected — convert to EF first.
 *   - A JSON `{"rawTx": ...}` body is an ARC-compatibility form the current
 *     public hosts answer with 400, so it is not used here at all.
 *   - `202` means accepted (or a resubmit of a known txid). `503` is
 *     backpressure carrying `Retry-After`. `400` is terminal, with the numeric
 *     code in the body's `status`/`statusCode`.
 *
 * ## Why a terminal 400 must never cascade
 *
 * A 400 means this transaction is invalid or unpayable: malformed scripts
 * (461), fee below policy (465), double spend (`DOUBLE_SPEND_ATTEMPTED`). Every
 * host validates the same bytes against the same consensus rules, so replaying
 * the identical transaction at the next host returns the same rejection — while
 * costing a round trip and, on some hosts, counting against rate limits. Worse,
 * cascading turns a decisive answer into "all hosts failed", which masks the
 * real cause and invites a caller to retry a transaction that can never be
 * mined.
 *
 * The two exceptions are 476 (non-final locktime — the transaction becomes
 * valid once the locktime passes) and 465 (fee too low — a rebuilt transaction
 * at a higher fee can succeed). Those are reported as their own outcomes so a
 * caller can decide, and neither is retried automatically here.
 *
 * ## Host ladder
 *
 * `arcade-eu-1` → `arcade-us-1` → `arcade.gorillapool.io`, overridable with
 * `BSV_BROADCASTER_HOSTS`. `arcade-ap-1` is deliberately absent: it does not
 * resolve, so including it would add a guaranteed DNS failure to every ladder
 * walk. GorillaPool's host has a 10 MiB body cap and no Chaintracks service,
 * which matters only for header lookups (see `lib/spv/chaintracks-client.ts`),
 * not for submission.
 *
 * A host that answers `GET /health` with anything other than a healthy body is
 * skipped for submission, and a host that returns `503` is benched for the
 * `Retry-After` interval it asked for.
 *
 * ## Legacy fallback
 *
 * Only on transport or 503 exhaustion across every Broadcaster host — never
 * after a terminal 400 — does `submitTransaction` optionally hand the raw hex
 * to TAAL ARC, then GorillaPool ARC, and finally WhatsOnChain when
 * `BSV_BROADCAST_WOC_FALLBACK=true`. Those paths are marked `degraded` so a
 * caller can tell a Broadcaster acceptance apart from a relay acceptance: a
 * relay does not track lifecycle and will never produce a merkle proof.
 */

import { upsertArcBroadcastStatus, describeError } from '../arc-broadcast-status'

export type SubmitOutcomeKind =
  | 'accepted'
  | 'pending-retry'
  | 'non-final'
  | 'fee-too-low'
  | 'terminal'
  | 'transport'

export interface AcceptedOutcome {
  kind: 'accepted'
  txid: string
  txStatus: string
  host: string
  /** Raw `202` body, for persisting merkle paths and competing txids. */
  body: Record<string, unknown>
  httpStatus: number
  /** True when acceptance came from a legacy relay rather than the Broadcaster. */
  degraded: boolean
  /** Relay that accepted it, when `degraded`. */
  legacyProvider?: string
  /**
   * The callback token the submission was sent with, so the accepted row can
   * record which stream it will be reported on. Absent for relay acceptances.
   */
  callbackToken?: string | null
  retryAfterMs?: number
}

export interface PendingRetryOutcome {
  kind: 'pending-retry'
  reason: string
  host: string
  httpStatus: number
  retryAfterMs: number
  /** Errors seen across every host in the ladder, oldest first. */
  attempts: BroadcastAttempt[]
}

export interface NonFinalOutcome {
  kind: 'non-final'
  code: number
  message: string
  host: string
  httpStatus: number
}

export interface FeeTooLowOutcome {
  kind: 'fee-too-low'
  code: number
  message: string
  host: string
  httpStatus: number
}

export interface TerminalOutcome {
  kind: 'terminal'
  code: number | null
  txStatus: string | null
  message: string
  host: string
  httpStatus: number
  /** True when the broadcaster reported a competing spend. */
  doubleSpend: boolean
  attempts?: BroadcastAttempt[]
}

export interface TransportOutcome {
  kind: 'transport'
  reason: string
  httpStatus: number | null
  attempts: BroadcastAttempt[]
}

export type SubmitOutcome =
  | AcceptedOutcome
  | PendingRetryOutcome
  | NonFinalOutcome
  | FeeTooLowOutcome
  | TerminalOutcome
  | TransportOutcome

export interface BroadcastAttempt {
  host: string
  outcome: SubmitOutcomeKind
  httpStatus: number | null
  detail: string
}

interface HostState {
  /** Epoch ms before which this host must not be contacted. */
  blockedUntil: number
  /** Last observed `Retry-After`, in ms. */
  lastRetryAfterMs: number
  consecutiveFailures: number
}

const DEFAULT_HOSTS = [
  'https://arcade-eu-1.bsvblockchain.tech',
  'https://arcade-us-1.bsvblockchain.tech',
  'https://arcade.gorillapool.io',
] as const

/** Broadcaster error codes that mean "not now" rather than "never". */
const NON_FINAL_LOCKTIME_CODE = 476
const FEE_TOO_LOW_CODE = 465
/** ARC-compatible code for "transaction already known". */
const ALREADY_KNOWN_CODES = new Set([464, 258])

const SUBMIT_TIMEOUT_MS = Math.max(5_000, Number(process.env.BSV_BROADCASTER_TIMEOUT_MS || 30_000))
const HEALTH_TIMEOUT_MS = Math.max(1_000, Number(process.env.BSV_BROADCASTER_HEALTH_TIMEOUT_MS || 4_000))
const POLICY_TIMEOUT_MS = Math.max(1_000, Number(process.env.BSV_BROADCASTER_POLICY_TIMEOUT_MS || 4_000))
const POLICY_TTL_MS = 60_000
const DEFAULT_RETRY_AFTER_MS = Math.max(1_000, Number(process.env.BSV_BROADCASTER_DEFAULT_RETRY_MS || 5_000))
/** Cap on `Retry-After` honoured, so a hostile or broken header cannot bench every host for hours. */
const MAX_RETRY_AFTER_MS = Math.max(60_000, Number(process.env.BSV_BROADCASTER_MAX_RETRY_MS || 15 * 60_000))
/** Multiple applied to a policy fee rate, to clear the floor with headroom. */
const FEE_SAFETY_MULTIPLIER = Math.max(1, Number(process.env.BSV_BROADCASTER_FEE_SAFETY_MULTIPLIER || 1.15))

const hostState = new Map<string, HostState>()
/** host → { rate, fetchedAt } for `GET /policy`. */
const policyCache = new Map<string, { rateSatPerByte: number; fetchedAt: number }>()
const healthCache = new Map<string, { healthy: boolean; checkedAt: number }>()
const HEALTH_TTL_MS = Math.max(5_000, Number(process.env.BSV_BROADCASTER_HEALTH_TTL_MS || 30_000))

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const normalised = raw.trim().toLowerCase()
  if (normalised === 'true' || normalised === '1') return true
  if (normalised === 'false' || normalised === '0') return false
  return fallback
}

/** True unless `BSV_BROADCASTER_ENABLED=false` (staged rollback to legacy ARC). */
export function isBroadcasterEnabled(): boolean {
  return envBool('BSV_BROADCASTER_ENABLED', true)
}

function stateFor(host: string): HostState {
  let state = hostState.get(host)
  if (!state) {
    state = { blockedUntil: 0, lastRetryAfterMs: 0, consecutiveFailures: 0 }
    hostState.set(host, state)
  }
  return state
}

/** Normalise a host string: trim, drop a trailing slash, require http(s). */
function normaliseHost(raw: string): string | null {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return null
  if (!/^https?:\/\//i.test(trimmed)) return null
  // A host that already carries a path prefix would break `{host}/tx`.
  return trimmed
}

/**
 * The Broadcaster hosts to try, in order.
 *
 * Resolved per call rather than at module load so an operator can change
 * `BSV_BROADCASTER_HOSTS` without a redeploy. Invalid entries are dropped
 * rather than throwing: a typo in the middle of the ladder must not take the
 * whole submission path down.
 */
export function getBroadcasterHosts(): string[] {
  const configured = process.env.BSV_BROADCASTER_HOSTS
  if (configured && configured.trim() !== '') {
    const hosts = configured
      .split(',')
      .map(normaliseHost)
      .filter((host): host is string => host != null)
    if (hosts.length > 0) return hosts
    console.warn(
      `⚠️  BSV_BROADCASTER_HOSTS="${configured}" contains no usable host; using the public ladder`,
    )
  }
  return [...DEFAULT_HOSTS]
}

function parseRetryAfterMs(headerValue: string | null): number {
  if (!headerValue) return DEFAULT_RETRY_AFTER_MS
  const trimmed = headerValue.trim()
  // Either delta-seconds or an HTTP date. Both are in the spec.
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, Math.round(seconds * 1000)))
  }
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, dateMs - Date.now()))
  }
  return DEFAULT_RETRY_AFTER_MS
}

function benchHost(host: string, retryAfterMs: number): void {
  const state = stateFor(host)
  state.blockedUntil = Date.now() + retryAfterMs
  state.lastRetryAfterMs = retryAfterMs
  state.consecutiveFailures += 1
}

function clearHostBackoff(host: string): void {
  const state = stateFor(host)
  state.blockedUntil = 0
  state.lastRetryAfterMs = 0
  state.consecutiveFailures = 0
}

/**
 * Read `GET /policy` and return satoshis per byte.
 *
 * The live response nests the fee under `policy.miningFee`, but older builds
 * put `miningFee` at the top level, so both shapes are accepted. `bytes` is the
 * denominator and must be treated as a real field: a host quoting
 * `{satoshis: 100, bytes: 1000}` means 0.1 sat/byte, not 100.
 */
async function fetchPolicyRate(host: string): Promise<number | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), POLICY_TIMEOUT_MS)
  try {
    const response = await fetch(`${host}/policy`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const body = (await response.json().catch(() => null)) as
      | { policy?: { miningFee?: { satoshis?: unknown; bytes?: unknown } }; miningFee?: { satoshis?: unknown; bytes?: unknown } }
      | null
    const miningFee = body?.policy?.miningFee ?? body?.miningFee
    const satoshis = Number(miningFee?.satoshis)
    const bytes = Number(miningFee?.bytes)
    if (!Number.isFinite(satoshis) || !Number.isFinite(bytes) || satoshis <= 0 || bytes <= 0) {
      return null
    }
    const rate = satoshis / bytes
    return Number.isFinite(rate) && rate > 0 ? rate : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * The fee rate to build at: the highest policy rate across reachable hosts,
 * times a safety multiplier, floored at the caller's own value.
 *
 * Taking the maximum rather than the first host's answer means a transaction
 * built once will clear every host in the ladder — which matters, because a fee
 * rejection is terminal and cannot be retried at a cheaper host.
 */
export async function getCachedPolicyFeeRateSatPerByte(fallbackFloor: number): Promise<number> {
  const floor = Number.isFinite(fallbackFloor) && fallbackFloor > 0 ? fallbackFloor : 0.1
  const hosts = getBroadcasterHosts()
  const now = Date.now()

  let worstRate = 0
  let measuredAny = false

  const results = await Promise.all(
    hosts.map(async (host) => {
      const cached = policyCache.get(host)
      if (cached && now - cached.fetchedAt < POLICY_TTL_MS) {
        return cached.rateSatPerByte
      }
      const fetched = await fetchPolicyRate(host)
      if (fetched == null) return null
      policyCache.set(host, { rateSatPerByte: fetched, fetchedAt: now })
      return fetched
    }),
  )

  for (const rate of results) {
    if (rate == null) continue
    measuredAny = true
    worstRate = Math.max(worstRate, rate)
  }

  if (!measuredAny) {
    // Every host was unreachable: the caller's floor is the only number that
    // reflects a real deployment decision, so use it rather than inventing one.
    return floor
  }

  return Math.max(worstRate * FEE_SAFETY_MULTIPLIER, floor)
}

/**
 * The callback token for this process, or `null`.
 *
 * The SSE stream is scoped by token, so a token must be stable for the life of
 * the process: a token that changed per submit would leave the subscriber
 * listening to a channel nothing publishes to. Persisted rows keep the token
 * they were submitted with (`arc_broadcast_status.callback_token`), which is
 * what lets a restart resume the stream.
 */
export function getBroadcasterCallbackToken(): string | null {
  const configured = process.env.BSV_BROADCASTER_CALLBACK_TOKEN
  if (configured && configured.trim() !== '') return configured.trim()

  // Derived from a deploy-scoped secret so restarts resume the same stream,
  // rather than a random value that orphans every in-flight transaction's
  // callback channel.
  const seed =
    process.env.BSV_BROADCASTER_TOKEN_SEED
    || process.env.BSV_PRIVATE_KEY
    || process.env.BSV_WALLET_1_PRIVATE_KEY
    || ''
  if (!seed) return null
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `gaialog-${hash.toString(16).padStart(8, '0')}`
}

async function checkHostHealth(host: string): Promise<boolean> {
  const cached = healthCache.get(host)
  const now = Date.now()
  if (cached && now - cached.checkedAt < HEALTH_TTL_MS) return cached.healthy

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(`${host}/health`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    let healthy = response.ok
    if (healthy) {
      const body = (await response.json().catch(() => null)) as { healthy?: unknown; status?: unknown } | null
      // `healthy: false` with a 200 is a real state (no healthy data hubs).
      if (body && body.healthy === false) healthy = false
      if (body && typeof body.status === 'string' && /unhealthy|error|down/i.test(body.status)) {
        healthy = false
      }
    }
    healthCache.set(host, { healthy, checkedAt: now })
    return healthy
  } catch {
    healthCache.set(host, { healthy: false, checkedAt: now })
    return false
  } finally {
    clearTimeout(timeout)
  }
}

interface ParsedErrorBody {
  code: number | null
  txStatus: string | null
  message: string
  detail: string | null
  doubleSpend: boolean
  txid: string | null
}

function parseErrorBody(text: string): ParsedErrorBody {
  const base: ParsedErrorBody = {
    code: null,
    txStatus: null,
    message: '',
    detail: null,
    doubleSpend: false,
    txid: null,
  }
  if (!text) return base
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...base, message: text.slice(0, 300) }
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { ...base, message: text.slice(0, 300) }
  }
  const record = parsed as Record<string, unknown>
  // The numeric ARC-style code has appeared as `status`, `statusCode` and
  // inside `detail` across releases; read all three rather than trusting one.
  const rawCode = record.status ?? record.statusCode ?? record.code
  const code = typeof rawCode === 'number' && Number.isFinite(rawCode)
    ? rawCode
    : typeof rawCode === 'string' && /^\d+$/.test(rawCode)
      ? Number(rawCode)
      : null
  const txStatus = typeof record.txStatus === 'string' ? record.txStatus : null
  const title = typeof record.title === 'string' ? record.title : ''
  const detail = typeof record.detail === 'string' ? record.detail : null
  const error = typeof record.error === 'string' ? record.error : ''
  const reason = typeof record.reason === 'string' ? record.reason : ''
  const txid = typeof record.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(record.txid)
    ? record.txid.toLowerCase()
    : null
  const message = [title, error, reason].filter(Boolean).join(' — ') || detail || text.slice(0, 300)
  const doubleSpend =
    txStatus === 'DOUBLE_SPEND_ATTEMPTED'
    || /double[\s-]?spend/i.test(message)
    || (detail != null && /double[\s-]?spend/i.test(detail))
  return { code, txStatus, message: message.slice(0, 400), detail, doubleSpend, txid }
}

interface ParsedAcceptedBody {
  txid: string | null
  txStatus: string
  body: Record<string, unknown>
}

function parseAcceptedBody(text: string): ParsedAcceptedBody {
  let body: Record<string, unknown> = {}
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
    } catch {
      // Some hosts answer with a bare txid.
      const plain = text.replace(/"/g, '').trim()
      if (/^[0-9a-fA-F]{64}$/.test(plain)) body = { txid: plain }
    }
  }
  const rawTxid = body.txid
  const txid = typeof rawTxid === 'string' && /^[0-9a-fA-F]{64}$/.test(rawTxid)
    ? rawTxid.toLowerCase()
    : null
  const rawStatus = body.txStatus
  const txStatus = typeof rawStatus === 'string' && rawStatus.trim() !== ''
    ? rawStatus.trim()
    : 'ACCEPTED'
  return { txid, txStatus, body }
}

/** Submit to one host. Never throws; every failure is a typed outcome. */
async function submitToHost(input: {
  host: string
  efBytes: Uint8Array
  expectedTxid?: string
  callbackToken?: string | null
}): Promise<SubmitOutcome> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      Accept: 'application/json',
    }
    if (input.callbackToken) headers['X-CallbackToken'] = input.callbackToken

    // Own copy of the bytes: `fetch` may read the body after an await, and a
    // caller that reuses its EF buffer (a retry loop, a batch) must not be able
    // to change what is in flight. Also gives a plain ArrayBuffer-backed view,
    // which is what the fetch body types accept.
    const body = new Uint8Array(input.efBytes)

    const response = await fetch(`${input.host}/tx`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })

    const text = await response.text().catch(() => '')

    if (response.status === 202 || response.status === 200) {
      const parsed = parseAcceptedBody(text)
      if (!parsed.txid) {
        return {
          kind: 'transport',
          reason: `HTTP ${response.status} without a usable txid: ${text.slice(0, 160)}`,
          httpStatus: response.status,
          attempts: [],
        }
      }
      if (input.expectedTxid && parsed.txid !== input.expectedTxid.toLowerCase()) {
        return {
          kind: 'terminal',
          code: null,
          txStatus: parsed.txStatus,
          message:
            `${input.host} reported txid ${parsed.txid.slice(0, 16)}… but the submitted ` +
            `transaction hashes to ${input.expectedTxid.slice(0, 16)}…; refusing to trust it`,
          host: input.host,
          httpStatus: response.status,
          doubleSpend: false,
        }
      }
      // A 202 can already carry a rejection: the broadcaster answers resubmits
      // of known-bad txids with the persisted verdict.
      const statusUpper = parsed.txStatus.toUpperCase()
      if (statusUpper === 'REJECTED' || statusUpper === 'INVALID' || statusUpper === 'MALFORMED') {
        return {
          kind: 'terminal',
          code: null,
          txStatus: parsed.txStatus,
          message: `${input.host} answered 202 with terminal status ${parsed.txStatus}`,
          host: input.host,
          httpStatus: response.status,
          doubleSpend: false,
        }
      }
      if (statusUpper === 'DOUBLE_SPEND_ATTEMPTED') {
        return {
          kind: 'terminal',
          code: null,
          txStatus: parsed.txStatus,
          message: `${input.host} reported a competing spend for ${parsed.txid.slice(0, 16)}…`,
          host: input.host,
          httpStatus: response.status,
          doubleSpend: true,
        }
      }
      return {
        kind: 'accepted',
        txid: parsed.txid,
        txStatus: parsed.txStatus,
        host: input.host,
        body: parsed.body,
        httpStatus: response.status,
        degraded: false,
        callbackToken: input.callbackToken ?? null,
      }
    }

    if (response.status === 503) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      return {
        kind: 'pending-retry',
        reason: `${input.host} is applying backpressure (503)`,
        host: input.host,
        httpStatus: 503,
        retryAfterMs,
        attempts: [],
      }
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      return {
        kind: 'pending-retry',
        reason: `${input.host} rate-limited the submission (429)`,
        host: input.host,
        httpStatus: 429,
        retryAfterMs,
        attempts: [],
      }
    }

    if (response.status === 400) {
      const parsed = parseErrorBody(text)
      if (parsed.code === NON_FINAL_LOCKTIME_CODE) {
        return {
          kind: 'non-final',
          code: NON_FINAL_LOCKTIME_CODE,
          message: parsed.message || 'transaction locktime is not yet final',
          host: input.host,
          httpStatus: 400,
        }
      }
      if (parsed.code === FEE_TOO_LOW_CODE) {
        return {
          kind: 'fee-too-low',
          code: FEE_TOO_LOW_CODE,
          message: parsed.message || 'transaction fee is below policy',
          host: input.host,
          httpStatus: 400,
        }
      }
      if (parsed.code != null && ALREADY_KNOWN_CODES.has(parsed.code)) {
        // The broadcaster already holds this transaction. That is acceptance,
        // not failure — and it is how a resubmit after a dropped response lands.
        if (input.expectedTxid) {
          return {
            kind: 'accepted',
            txid: input.expectedTxid.toLowerCase(),
            txStatus: 'ACCEPTED',
            host: input.host,
            body: {},
            httpStatus: response.status,
            degraded: false,
            callbackToken: input.callbackToken ?? null,
          }
        }
      }
      return {
        kind: 'terminal',
        code: parsed.code,
        txStatus: parsed.txStatus,
        message: parsed.message || `rejected by ${input.host}`,
        host: input.host,
        httpStatus: 400,
        doubleSpend: parsed.doubleSpend,
      }
    }

    if (response.status >= 500) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      return {
        kind: 'pending-retry',
        reason: `${input.host} returned HTTP ${response.status}`,
        host: input.host,
        httpStatus: response.status,
        retryAfterMs,
        attempts: [],
      }
    }

    const parsed = parseErrorBody(text)
    return {
      kind: 'terminal',
      code: parsed.code,
      txStatus: parsed.txStatus,
      message: parsed.message || `unexpected HTTP ${response.status} from ${input.host}`,
      host: input.host,
      httpStatus: response.status,
      doubleSpend: parsed.doubleSpend,
    }
  } catch (error) {
    const message = describeError(error)
    return {
      kind: 'transport',
      reason: `${input.host}: ${message}`,
      httpStatus: null,
      attempts: [],
    }
  } finally {
    clearTimeout(timeout)
  }
}

function normaliseHex(hex: string): string {
  return String(hex ?? '').trim().toLowerCase()
}

interface LegacyResult {
  txid: string
  provider: string
  acceptedVia: string
  txStatus: string
}

async function postLegacyArc(input: {
  endpoint: string
  apiKey: string
  provider: string
  acceptedVia: string
  rawHex: string
  timeoutMs: number
}): Promise<LegacyResult | string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
    const response = await fetch(`${input.endpoint}/v1/tx`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rawTx: input.rawHex }),
      signal: controller.signal,
    })
    const text = await response.text().catch(() => '')
    if (response.status === 503 || response.status === 429) {
      return `${input.provider}: HTTP ${response.status}`
    }
    if (!response.ok) {
      return `${input.provider} ${response.status}: ${text.slice(0, 200)}`
    }
    let parsed: Record<string, unknown> = {}
    try {
      const candidate = JSON.parse(text || '{}')
      if (candidate && typeof candidate === 'object') parsed = candidate as Record<string, unknown>
    } catch {
      const plain = text.replace(/"/g, '').trim()
      if (/^[0-9a-fA-F]{64}$/.test(plain)) parsed = { txid: plain }
    }
    const txid = typeof parsed.txid === 'string' ? parsed.txid.toLowerCase() : null
    const txStatus = typeof parsed.txStatus === 'string' ? parsed.txStatus : ''
    if (!txid || !/^[0-9a-f]{64}$/.test(txid)) {
      return `${input.provider}: response carried no usable txid (${text.slice(0, 120)})`
    }
    if (/^(REJECTED|INVALID|MALFORMED|EVICTED|DOUBLE_SPEND_ATTEMPTED)$/i.test(txStatus)) {
      return `${input.provider}: rejected (${txStatus})`
    }
    return { txid, provider: input.provider, acceptedVia: input.acceptedVia, txStatus }
  } catch (error) {
    return `${input.provider}: ${describeError(error)}`
  } finally {
    clearTimeout(timeout)
  }
}

async function postWhatsOnChain(input: {
  rawHex: string
  timeoutMs: number
}): Promise<LegacyResult | string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const apiKey = process.env.WHATSONCHAIN_API_KEY
    if (apiKey) headers['woc-api-key'] = apiKey
    const response = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
      method: 'POST',
      headers,
      body: JSON.stringify({ txhex: input.rawHex }),
      signal: controller.signal,
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) return `WhatsOnChain ${response.status}: ${text.slice(0, 200)}`
    const txid = text.replace(/"/g, '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      return `WhatsOnChain: response carried no usable txid (${text.slice(0, 120)})`
    }
    return { txid, provider: 'whatsonchain', acceptedVia: 'whatsonchain', txStatus: 'SEEN_ON_NETWORK' }
  } catch (error) {
    return `WhatsOnChain: ${describeError(error)}`
  } finally {
    clearTimeout(timeout)
  }
}

const LEGACY_TIMEOUT_MS = Math.max(3_000, Number(process.env.BSV_BROADCAST_TIMEOUT_MS || 15_000))

/**
 * Last-resort relays. Only reached when every Broadcaster host failed at the
 * transport level or with 503 — never after a terminal rejection, because a
 * transaction the Broadcaster called invalid is invalid at TAAL too.
 */
async function submitLegacyFallback(input: {
  rawHex: string
  expectedTxid?: string
  allowWhatsOnChain: boolean
}): Promise<{ result: LegacyResult } | { errors: string[] }> {
  const errors: string[] = []
  if (!input.rawHex) {
    return { errors: ['no raw hex available for a legacy fallback'] }
  }

  const taal = await postLegacyArc({
    endpoint: (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/+$/, ''),
    apiKey: process.env.BSV_ARC_API_KEY || '',
    provider: 'taal_arc',
    acceptedVia: 'taal_arc',
    rawHex: input.rawHex,
    timeoutMs: LEGACY_TIMEOUT_MS,
  })
  if (typeof taal !== 'string') return { result: taal }
  errors.push(taal)

  const gorilla = await postLegacyArc({
    endpoint: (process.env.BSV_GORILLAPOOL_ARC_ENDPOINT || 'https://arc.gorillapool.io').replace(/\/+$/, ''),
    apiKey: process.env.BSV_GORILLAPOOL_API_KEY || '',
    provider: 'gorillapool_arc',
    acceptedVia: 'gorillapool_arc',
    rawHex: input.rawHex,
    timeoutMs: LEGACY_TIMEOUT_MS,
  })
  if (typeof gorilla !== 'string') return { result: gorilla }
  errors.push(gorilla)

  if (input.allowWhatsOnChain) {
    const woc = await postWhatsOnChain({ rawHex: input.rawHex, timeoutMs: LEGACY_TIMEOUT_MS })
    if (typeof woc !== 'string') return { result: woc }
    errors.push(woc)
  }

  return { errors }
}

/**
 * Submit one signed transaction.
 *
 * Walks the host ladder, skipping hosts inside a backpressure window and hosts
 * whose `/health` says they cannot serve. Stops at the first acceptance. Stops
 * immediately on a terminal rejection rather than trying the next host.
 */
export async function submitTransaction(input: {
  efBytes: Uint8Array
  rawHex: string
  expectedTxid?: string
  callbackToken?: string | null
  allowLegacyFallback?: boolean
}): Promise<SubmitOutcome> {
  if (!(input.efBytes instanceof Uint8Array) || input.efBytes.length === 0) {
    // The Broadcaster only accepts EF here. A caller that has none is a caller
    // that should not be submitting; say so instead of sending raw bytes that
    // would be rejected as malformed.
    return {
      kind: 'terminal',
      code: null,
      txStatus: null,
      message: 'submitTransaction requires EF bytes (BRC-30); the Broadcaster rejects raw and BEEF bodies',
      host: 'none',
      httpStatus: 0,
      doubleSpend: false,
    }
  }

  const expectedTxid = input.expectedTxid ? normaliseHex(input.expectedTxid) : undefined
  if (expectedTxid && !/^[0-9a-f]{64}$/.test(expectedTxid)) {
    return {
      kind: 'terminal',
      code: null,
      txStatus: null,
      message: `expectedTxid "${input.expectedTxid}" is not a 64-character hex id`,
      host: 'none',
      httpStatus: 0,
      doubleSpend: false,
    }
  }

  const hosts = getBroadcasterHosts()
  const attempts: BroadcastAttempt[] = []
  let sawTransport = false
  /** Hosts skipped purely because they are inside a backpressure window. */
  let skippedBackpressure = 0
  let lastRetryAfterMs = DEFAULT_RETRY_AFTER_MS
  const benchUntil: number[] = []

  for (let index = 0; index < hosts.length; index++) {
    const host = hosts[index]
    const state = stateFor(host)
    if (state.blockedUntil > Date.now()) {
      skippedBackpressure += 1
      benchUntil.push(state.blockedUntil)
      lastRetryAfterMs = Math.min(lastRetryAfterMs, state.lastRetryAfterMs || DEFAULT_RETRY_AFTER_MS)
      attempts.push({
        host,
        outcome: 'pending-retry',
        httpStatus: null,
        detail: `skipped: backpressure window ends in ${Math.ceil((state.blockedUntil - Date.now()) / 1000)}s`,
      })
      continue
    }

    const healthy = await checkHostHealth(host)
    if (!healthy) {
      attempts.push({ host, outcome: 'transport', httpStatus: null, detail: 'skipped: /health not healthy' })
      // An unhealthy host is a reachability failure, not backpressure: it may
      // clear on its own, so it must not block the legacy fallback.
      sawTransport = true
      continue
    }

    const outcome = await submitToHost({
      host,
      efBytes: input.efBytes,
      expectedTxid,
      callbackToken: input.callbackToken,
    })

    if (outcome.kind === 'accepted') {
      clearHostBackoff(host)
      return outcome
    }

    // A terminal verdict is authoritative: every host validates the same bytes,
    // so retrying elsewhere would repeat the same rejection.
    if (outcome.kind === 'terminal') {
      clearHostBackoff(host)
      return { ...outcome, attempts }
    }

    if (outcome.kind === 'non-final' || outcome.kind === 'fee-too-low') {
      return outcome
    }

    if (outcome.kind === 'pending-retry') {
      benchHost(host, outcome.retryAfterMs)
      benchUntil.push(Date.now() + outcome.retryAfterMs)
      lastRetryAfterMs = Math.min(lastRetryAfterMs, outcome.retryAfterMs)
      attempts.push({
        host,
        outcome: 'pending-retry',
        httpStatus: outcome.httpStatus,
        detail: outcome.reason,
      })
      continue
    }

    // transport
    sawTransport = true
    stateFor(host).consecutiveFailures += 1
    attempts.push({
      host,
      outcome: 'transport',
      httpStatus: outcome.httpStatus,
      detail: outcome.reason,
    })
  }

  // Every host either refused the connection or asked us to wait. Neither
  // proves anything about the transaction, and both mean the Broadcaster is not
  // currently able to accept it. Handing the bytes to a relay now would publish
  // a transaction that a Broadcaster would have accepted moments later, into a
  // lifecycle that tracks nothing — so ask the caller to retry instead.
  //
  // This is checked before the fallback, not after, because falling through is
  // exactly the bug: `sawTransport` being false was treated as "the relays
  // might work", when it actually meant "every host was backpressured".
  const backpressuredOnly = skippedBackpressure > 0 && attempts.every(
    (attempt) => attempt.outcome === 'pending-retry',
  )
  if (backpressuredOnly || (!sawTransport && benchUntil.length > 0)) {
    const futureWaits = benchUntil
      .map((until) => until - Date.now())
      .filter((wait) => wait > 0)
    const waitMs = Math.max(
      1_000,
      futureWaits.length > 0 ? Math.min(...futureWaits) : lastRetryAfterMs,
    )
    return {
      kind: 'pending-retry',
      reason: `all ${hosts.length} Broadcaster host(s) are applying backpressure`,
      host: hosts[0] ?? 'none',
      httpStatus: 503,
      retryAfterMs: waitMs,
      attempts,
    }
  }

  const allowFallback = input.allowLegacyFallback !== false
  if (allowFallback) {
    const fallback = await submitLegacyFallback({
      rawHex: input.rawHex,
      expectedTxid,
      allowWhatsOnChain: envBool('BSV_BROADCAST_WOC_FALLBACK', false),
    })
    if ('result' in fallback) {
      const result = fallback.result
      if (expectedTxid && result.txid !== expectedTxid) {
        return {
          kind: 'terminal',
          code: null,
          txStatus: null,
          message:
            `${result.provider} reported txid ${result.txid.slice(0, 16)}… but the submitted ` +
            `transaction hashes to ${expectedTxid.slice(0, 16)}…`,
          host: result.provider,
          httpStatus: 200,
          doubleSpend: false,
          attempts,
        }
      }
      return {
        kind: 'accepted',
        txid: result.txid,
        txStatus: result.txStatus,
        host: result.provider,
        body: {},
        httpStatus: 200,
        degraded: true,
        legacyProvider: result.provider,
      }
    }
    attempts.push({
      host: 'legacy-fallback',
      outcome: 'transport',
      httpStatus: null,
      detail: fallback.errors.join('; ').slice(0, 400),
    })
  }

  return {
    kind: 'transport',
    reason:
      `Broadcaster submission failed across ${hosts.length} host(s)` +
      (allowFallback ? ' and every legacy relay' : '') +
      `: ${attempts.map((attempt) => `${attempt.host} ${attempt.detail}`).join(' | ').slice(0, 500)}`,
    httpStatus: null,
    attempts,
  }
}

/**
 * Persist an accepted submission.
 *
 * Kept here rather than at every call site so the fields the SSE subscriber and
 * reconciler depend on (`accepted_endpoint`, `provider`, `callback_token`) are
 * written by one piece of code with one understanding of them.
 */
/**
 * Persist an accepted submission.
 *
 * Kept here rather than at every call site so the fields the SSE subscriber and
 * reconciler depend on (`accepted_endpoint`, `provider`, `callback_token`) are
 * written by one piece of code with one understanding of them.
 *
 * `callback_token` is the token the submission was actually sent with. Recording
 * it is what lets the subscriber resume the right stream after a restart: the
 * stream is scoped by token, and a token generated afresh would listen to a
 * channel nothing publishes to.
 */
export async function recordBroadcasterAcceptance(outcome: AcceptedOutcome): Promise<void> {
  const body = outcome.body ?? {}
  const merklePath = typeof body.merklePath === 'string' && body.merklePath.trim() !== ''
    ? body.merklePath.trim()
    : null
  const blockHash = typeof body.blockHash === 'string' && /^[0-9a-fA-F]{64}$/.test(body.blockHash)
    ? body.blockHash.toLowerCase()
    : null
  const rawHeight = body.blockHeight
  const blockHeight = typeof rawHeight === 'number' && Number.isSafeInteger(rawHeight) && rawHeight > 0
    ? rawHeight
    : null
  const competingTxs = Array.isArray(body.competingTxs) ? body.competingTxs : null

  await upsertArcBroadcastStatus({
    txid: outcome.txid,
    txStatus: outcome.txStatus,
    acceptedVia: outcome.degraded
      ? (outcome.legacyProvider ?? 'legacy_relay')
      : 'bsv_broadcaster',
    provider: outcome.degraded ? 'arc' : 'broadcaster',
    // A relay acceptance has no Broadcaster instance tracking it, so pinning an
    // endpoint would send the reconciler to a host that will only ever 404.
    acceptedEndpoint: outcome.degraded ? null : outcome.host,
    // Only a Broadcaster submission has an SSE stream to attach to.
    callbackToken: outcome.degraded ? null : (outcome.callbackToken ?? null),
    merklePath,
    blockHash,
    blockHeight,
    competingTxs,
  })
}

/** Test and diagnostic helper: forget every cached policy, health and backoff. */
export function resetBroadcasterClientState(): void {
  hostState.clear()
  policyCache.clear()
  healthCache.clear()
}
