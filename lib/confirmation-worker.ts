/**
 * Confirmation Worker
 *
 * Periodically scans recently-broadcast (but as-yet unconfirmed) entries in
 * `overlay_explorer_readings`, `overlay_admitted_utxos`, and `tx_log`, then
 * checks a block explorer for block inclusion.  Confirmation lookups go to
 * Bitails (`GET /tx/{txid}/status`) by default — the same endpoint
 * scripts/backfill-explorer-confirmations.ts uses — because WhatsOnChain's
 * 3-RPS limit cannot keep up with the broadcast volume. When Bitails reports a
 * confirmation we update:
 *
 *   - overlay_explorer_readings: confirmed=true, block_height, block_time
 *   - overlay_admitted_utxos:    confirmed=true (where txid matches)
 *   - tx_log:                    status='confirmed', onchain_at
 *                                (tx_log has no block_height column — do not SET it)
 *
 * Without this worker, *nothing* in the pipeline ever transitions a row to
 * `confirmed=true`.  That:
 *   1. defeats BSV_MIN_SPEND_CONFIRMATIONS (every spend looks unconfirmed),
 *   2. blocks the explorer "confirmed-only" view from showing recent rows,
 *   3. allows the AFTER-DELETE retention trigger to undercount confirmed
 *      historical readings.
 *
 * The worker is intentionally conservative:
 *   - Hard-capped global RPS so neither Bitails nor (optional) WhatsOnChain is
 *     hammered. `BSV_CONFIRMATION_REQ_INTERVAL_MS` throttles the primary
 *     provider; the WoC fallback keeps its own slower lane.
 *   - Bounded batch size per cycle (default 30 txids).
 *   - Dynamic backoff on 429 / 5xx — pauses the worker for a cool-down
 *     period instead of retrying into the same wall.
 *   - All DB writes use idempotent UPDATE … WHERE NOT confirmed predicates.
 *
 * Configurable via env:
 *   BSV_CONFIRMATION_WORKER_DISABLED=true     - opt out entirely
 *   BSV_CONFIRMATION_PROVIDER=bitails         - 'bitails' (default) | 'woc'
 *   BSV_BITAILS_API_BASE=https://api.bitails.io
 *   BSV_CONFIRMATION_WOC_FALLBACK=false       - consult WoC when Bitails has
 *                                               no answer AND this is 'true'
 *   GAIALOG_DISABLE_WOC_READS                 - when 'true', WoC is never read
 *                                               even if the fallback is on
 *   BSV_CONFIRMATION_INTERVAL_MS=30000        - between cycles (default 30s)
 *   BSV_CONFIRMATION_BATCH_SIZE=30            - txids per cycle
 *   BSV_CONFIRMATION_MIN_AGE_SECONDS=60       - skip txids younger than this
 *   BSV_CONFIRMATION_MAX_AGE_HOURS=72         - primary chase window
 *   BSV_CONFIRMATION_CATCHUP_DAYS=14          - residual catch-up for stale rows
 *                                               (long tail: scripts/backfill-explorer-confirmations.ts)
 *   BSV_CONFIRMATION_REQ_INTERVAL_MS=400      - per-request throttle
 *   BSV_CONFIRMATION_BACKOFF_MS=120000        - cool-down on rate limit
 */

import { query } from './db'
import { confirmReading } from './overlay-explorer-repository'

const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY
const WOC_NETWORK: 'main' | 'test' = ((): 'main' | 'test' => {
  const raw = String(process.env.BSV_NETWORK || 'main').toLowerCase()
  return raw === 'test' || raw === 'testnet' ? 'test' : 'main'
})()

/** Primary confirmation source. Bitails by default — WoC's 3-RPS limit does not scale. */
const CONFIRMATION_PROVIDER: 'bitails' | 'woc' = ((): 'bitails' | 'woc' => {
  const raw = String(process.env.BSV_CONFIRMATION_PROVIDER || 'bitails').toLowerCase()
  return raw === 'woc' || raw === 'whatsonchain' ? 'woc' : 'bitails'
})()
const BITAILS_BASE = (process.env.BSV_BITAILS_API_BASE || 'https://api.bitails.io').replace(/\/$/, '')
/**
 * WoC is a fallback only, never a co-primary: it is consulted only when
 * Bitails could not answer, the operator opted in, and reads are not disabled.
 */
const WOC_FALLBACK_ENABLED =
  process.env.BSV_CONFIRMATION_WOC_FALLBACK === 'true' &&
  !envBool('GAIALOG_DISABLE_WOC_READS', false)
/** When Bitails is the primary, WoC keeps this minimum gap between requests. */
const WOC_FALLBACK_INTERVAL_MS = 1_000

const ENABLED = !envBool('BSV_CONFIRMATION_WORKER_DISABLED', false)
const INTERVAL_MS = envInt('BSV_CONFIRMATION_INTERVAL_MS', 30_000, 5_000)
const BATCH_SIZE = envInt('BSV_CONFIRMATION_BATCH_SIZE', 30, 1)
const MIN_AGE_SECONDS = envInt('BSV_CONFIRMATION_MIN_AGE_SECONDS', 60, 0)
const MAX_AGE_HOURS = envInt('BSV_CONFIRMATION_MAX_AGE_HOURS', 72, 1)
// Residual catch-up for rows that aged out of the primary window while still
// unconfirmed (worker downtime / WoC 429s). Default ~13 months so months-old
// explorer "Unconfirmed" badges eventually clear without a manual backfill.
// Keep live catch-up short. Multi-month backlogs belong to the Bitails
// backfill script — a 400-day residual scan competed with that work and
// helped peg Supabase compute at ~100%.
const CATCHUP_DAYS = envInt('BSV_CONFIRMATION_CATCHUP_DAYS', 14, 1)
const REQ_INTERVAL_MS = envInt('BSV_CONFIRMATION_REQ_INTERVAL_MS', 400, 200)
const BACKOFF_MS = envInt('BSV_CONFIRMATION_BACKOFF_MS', 120_000, 5_000)
const ARC_STATUS_POLL_DISABLED = envBool('BSV_ARC_STATUS_POLL_DISABLED', false)

const ARC_OWNED_EXCLUSION = `
        AND NOT EXISTS (
          SELECT 1 FROM arc_broadcast_status s
          WHERE s.txid = overlay_explorer_readings.txid
            AND s.accepted_via IN ('taal_arc', 'gorillapool_arc')
        )`

let timer: NodeJS.Timeout | null = null
let running = false
let cooldownUntil = 0
/** Last request of the primary provider (Bitails or WoC-as-primary). */
let lastRequestAt = 0
let lastWocAt = 0
/** Remember 42P01 for the process lifetime so we stop appending the ARC exclusion. */
let arcStatusTableMissing = false

function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, parsed)
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null) return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

interface CandidateTxid {
  txid: string
}

/**
 * Pull a small batch of unconfirmed txids that are old enough to plausibly
 * have been mined but young enough to still be worth chasing.  We sample
 * from overlay_explorer_readings as the canonical source — every broadcast
 * we care about ends up there, and the partial index
 * oer_unconfirmed_admitted_idx on (admitted_at) WHERE confirmed = false
 * makes this cheap.
 *
 * The window is keyed on `admitted_at` (when WE broadcast and inserted the
 * row), not `reading_ts` (the sensor's own reading timestamp). The two are
 * not interchangeable:
 *
 *   - `reading_ts` can lag `admitted_at` by hours when historical readings
 *     are ingested in a burst. A row broadcast at 17:03 carrying
 *     reading_ts=07:18 was already 9.7h "old" at insert time, so it fell
 *     outside the 2h primary window and short of the 72h catch-up floor —
 *     invisible to BOTH, and therefore never chased or confirmed.
 *   - Some rows carry a sentinel reading_ts entirely (observed: 2007-11-07).
 *
 * Keying on `admitted_at` makes every row reachable exactly once, in the
 * window that matches its real age. Rows that never mine simply age out,
 * so the window cannot be permanently clogged by dead txids.
 */
function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '42P01'
  )
}

async function fetchCandidatesWithExclusion(excludeArcOwned: boolean): Promise<CandidateTxid[]> {
  const minAge = `${MIN_AGE_SECONDS} seconds`
  const maxAge = `${MAX_AGE_HOURS} hours`
  const exclusion = excludeArcOwned ? ARC_OWNED_EXCLUSION : ''

  // Primary window: recent unconfirmed broadcasts the worker actively chases.
  const primary = await query<CandidateTxid>(
    `SELECT txid
       FROM overlay_explorer_readings
      WHERE confirmed = false
        AND admitted_at < now() - $1::interval
        AND admitted_at > now() - $2::interval
        ${exclusion}
      ORDER BY admitted_at ASC
      LIMIT $3`,
    [minAge, maxAge, BATCH_SIZE],
  )

  const primaryRows = primary.rows || []
  if (primaryRows.length >= BATCH_SIZE) return primaryRows

  // Catch-up: older rows that aged out of the chase window while still
  // unconfirmed (worker downtime / WoC rate-limits). Small residual batch only;
  // for multi-month backlogs use scripts/backfill-explorer-confirmations.ts.
  const residual = BATCH_SIZE - primaryRows.length
  const catchup = `${CATCHUP_DAYS} days`
  const stale = await query<CandidateTxid>(
    `SELECT txid
       FROM overlay_explorer_readings
      WHERE confirmed = false
        AND admitted_at <= now() - $1::interval
        AND admitted_at > now() - $2::interval
        ${exclusion}
      ORDER BY admitted_at DESC
      LIMIT $3`,
    [maxAge, catchup, residual],
  )

  const seen = new Set(primaryRows.map((r) => r.txid))
  for (const row of stale.rows || []) {
    if (!seen.has(row.txid)) primaryRows.push(row)
  }
  return primaryRows
}

async function fetchCandidates(): Promise<CandidateTxid[]> {
  const excludeArcOwned = !ARC_STATUS_POLL_DISABLED && !arcStatusTableMissing
  try {
    return await fetchCandidatesWithExclusion(excludeArcOwned)
  } catch (err) {
    if (excludeArcOwned && isUndefinedTable(err)) {
      arcStatusTableMissing = true
      console.warn(
        '[confirmation-worker] arc_broadcast_status missing; continuing without ARC exclusion',
      )
      return await fetchCandidatesWithExclusion(false)
    }
    throw err
  }
}

interface TxConfirmation {
  blockHeight: number | null
  blockTime: Date | null
}

/**
 * Outcome of one lookup. `mined` is the only success the caller acts on;
 * `rate-limited` / `server-error` both trip the worker cooldown, and the
 * remaining kinds are "no confirmation yet" with different telemetry value.
 */
type LookupOutcome =
  | { kind: 'mined'; status: TxConfirmation }
  | { kind: 'unconfirmed' }
  | { kind: 'not-found' }
  | { kind: 'rate-limited' }
  | { kind: 'server-error'; detail: string }
  | { kind: 'error'; detail: string }

/** Throttles the primary provider to one request per REQ_INTERVAL_MS. */
async function throttlePrimary(): Promise<void> {
  const gate = REQ_INTERVAL_MS - (Date.now() - lastRequestAt)
  if (gate > 0) await new Promise(resolve => setTimeout(resolve, gate))
  lastRequestAt = Date.now()
}

/** Slower lane for the optional WoC fallback; its limit is far lower than Bitails'. */
async function throttleWocFallback(): Promise<void> {
  const gate = WOC_FALLBACK_INTERVAL_MS - (Date.now() - lastWocAt)
  if (gate > 0) await new Promise(resolve => setTimeout(resolve, gate))
  lastWocAt = Date.now()
}

/**
 * Bitails single-transaction status: `GET /tx/{txid}/status`.
 * Same endpoint and response shape as scripts/backfill-explorer-confirmations.ts.
 */
async function lookupBitailsStatus(txid: string): Promise<LookupOutcome> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(`${BITAILS_BASE}/tx/${encodeURIComponent(txid)}/status`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })

    // Bitails rate-limits with 429 and sheds load with 5xx. Both deserve a
    // cooldown; burning through the batch on either just deepens the hole.
    if (res.status === 429) return { kind: 'rate-limited' }
    if (res.status >= 500) {
      const detail = (await res.text().catch(() => '')).slice(0, 120)
      return { kind: 'server-error', detail: `Bitails ${res.status}: ${detail}` }
    }
    if (res.status === 404) return { kind: 'not-found' }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 120)
      return { kind: 'error', detail: `Bitails ${res.status}: ${detail}` }
    }

    const body = (await res.json().catch(() => null)) as {
      status?: string
      blockheight?: number
      blockHeight?: number
      confirmations?: number
      blocktime?: number
      time?: number
    } | null
    if (!body || typeof body !== 'object') {
      return { kind: 'error', detail: 'Bitails returned a non-object body' }
    }

    const status = String(body.status ?? '').toLowerCase()
    if (status === 'not found' || status === 'not_found') return { kind: 'not-found' }

    const blockHeightRaw =
      typeof body.blockheight === 'number' ? body.blockheight :
      typeof body.blockHeight === 'number' ? body.blockHeight :
      0
    const confirmations = typeof body.confirmations === 'number' ? body.confirmations : 0
    const mined = status === 'confirmed' || blockHeightRaw > 0 || confirmations >= 1
    if (!mined) return { kind: 'unconfirmed' }

    const timeRaw =
      typeof body.blocktime === 'number' ? body.blocktime :
      typeof body.time === 'number' ? body.time :
      null

    return {
      kind: 'mined',
      status: {
        blockHeight: blockHeightRaw > 0 ? blockHeightRaw : null,
        blockTime: timeRaw ? new Date(timeRaw * 1000) : null,
      },
    }
  } catch {
    // Abort / DNS / TLS — indistinguishable from "no answer" for our purposes.
    return { kind: 'error', detail: 'Bitails request failed' }
  } finally {
    clearTimeout(timeoutId)
  }
}

/** WhatsOnChain fallback. Only reached when BSV_CONFIRMATION_WOC_FALLBACK === 'true'. */
async function lookupWocStatus(txid: string, isPrimary: boolean): Promise<LookupOutcome> {
  // When WoC is the primary provider, throttlePrimary() has already gated this
  // request; only the fallback lane needs its own (much slower) gate.
  if (!isPrimary) await throttleWocFallback()

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (WHATSONCHAIN_API_KEY) {
    if (WHATSONCHAIN_API_KEY.startsWith('mainnet_') || WHATSONCHAIN_API_KEY.startsWith('testnet_')) {
      headers['Authorization'] = WHATSONCHAIN_API_KEY
    } else {
      headers['woc-api-key'] = WHATSONCHAIN_API_KEY
    }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8_000)

  try {
    const res = await fetch(
      `https://api.whatsonchain.com/v1/bsv/${WOC_NETWORK}/tx/${txid}`,
      { headers, signal: controller.signal },
    )

    if (res.status === 429 || res.status === 503) return { kind: 'rate-limited' }
    if (res.status === 404) return { kind: 'not-found' }
    if (res.status >= 500) {
      return { kind: 'server-error', detail: `WoC ${res.status}` }
    }
    if (!res.ok) return { kind: 'error', detail: `WoC ${res.status}` }

    const body = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return { kind: 'error', detail: 'WoC returned a non-object body' }
    }

    const blockHeightRaw =
      typeof body.blockheight === 'number' ? body.blockheight :
      typeof body.blockHeight === 'number' ? body.blockHeight :
      null
    const confirmations =
      typeof body.confirmations === 'number' ? body.confirmations : 0

    // On BSV, confirmations >= 1 means mined (including the first confirmation).
    // Some WoC payloads expose confirmations/blockhash before blockheight is filled.
    const mined = (blockHeightRaw != null && blockHeightRaw > 0) || confirmations >= 1
    if (!mined) return { kind: 'unconfirmed' }

    const blockTimeRaw =
      typeof body.blocktime === 'number' ? body.blocktime :
      typeof body.time === 'number' ? body.time :
      null

    return {
      kind: 'mined',
      status: {
        blockHeight: blockHeightRaw != null && blockHeightRaw > 0 ? blockHeightRaw : null,
        blockTime: blockTimeRaw ? new Date(blockTimeRaw * 1000) : null,
      },
    }
  } catch {
    return { kind: 'error', detail: 'WoC request failed' }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Resolve one txid's inclusion.
 *
 * Bitails is primary. WoC is consulted only when it is explicitly enabled, not
 * disabled by GAIALOG_DISABLE_WOC_READS, AND Bitails produced no usable answer
 * — never to second-guess a definitive Bitails result.
 */
async function lookupTxStatus(txid: string): Promise<LookupOutcome> {
  await throttlePrimary()

  const primary = CONFIRMATION_PROVIDER === 'woc'
    ? await lookupWocStatus(txid, true)
    : await lookupBitailsStatus(txid)

  if (primary.kind === 'mined') return primary
  if (primary.kind === 'rate-limited') return primary

  if (CONFIRMATION_PROVIDER === 'bitails' && WOC_FALLBACK_ENABLED) {
    // Only for "Bitails has nothing to say": 404, unconfirmed, or a transport
    // failure. A 5xx means Bitails is unhealthy — WoC may still know the tx.
    const fallback = await lookupWocStatus(txid, false)
    if (fallback.kind === 'mined') return fallback
    if (fallback.kind === 'rate-limited') return fallback
  }

  return primary
}

async function applyConfirmation(txid: string, status: TxConfirmation): Promise<void> {
  // Height may be unknown briefly even when confirmations >= 1 — still flip confirmed.
  const blockHeight = status.blockHeight != null && status.blockHeight > 0 ? status.blockHeight : 0

  await confirmReading(txid, blockHeight, status.blockTime)

  // Mark every UTXO row that came from this tx as confirmed AND spendable in
  // ONE statement. A separate `acquirable_at = now()` update could land
  // between the two and lose either half; the COALESCE-free LEAST keeps an
  // earlier acquirable_at (already-spendable output) untouched while pulling a
  // future grace/infinity value back to now().
  // Cheap point lookup — covered by overlay_admitted_utxos_outpoint_idx.
  await query(
    `UPDATE overlay_admitted_utxos
        SET confirmed = true,
            acquirable_at = LEAST(acquirable_at, now())
      WHERE txid = $1
        AND (confirmed = false OR acquirable_at > now())`,
    [txid],
  )

  // tx_log has status + onchain_at only (no block_height — that lives on
  // overlay_explorer_readings). Updating a non-existent column flooded
  // Supabase with 42703 errors even though the catch swallowed them.
  try {
    await query(
      `UPDATE tx_log
          SET status = 'confirmed',
              onchain_at = COALESCE(onchain_at, $2)
        WHERE txid = $1
          AND status <> 'confirmed'`,
      [txid, status.blockTime ?? new Date()],
    )
  } catch (err) {
    void err
  }
}

async function runCycle(): Promise<void> {
  if (running) return
  if (Date.now() < cooldownUntil) return
  running = true

  const cycleStart = Date.now()
  let processed = 0
  let confirmed = 0
  let rateLimited = false
  let errors = 0

  try {
    const candidates = await fetchCandidates()
    if (candidates.length === 0) return

    for (const { txid } of candidates) {
      processed++
      const result = await lookupTxStatus(txid)

      if (result.kind === 'rate-limited') {
        rateLimited = true
        cooldownUntil = Date.now() + BACKOFF_MS
        console.warn(
          `[confirmation-worker] ${CONFIRMATION_PROVIDER} rate-limited; cooling down ${Math.round(BACKOFF_MS / 1000)}s`,
        )
        break
      }

      if (result.kind === 'server-error') {
        // Bitails 5xx: back off the whole worker rather than marching through
        // the batch into the same failing endpoint.
        cooldownUntil = Date.now() + BACKOFF_MS
        console.warn(
          `[confirmation-worker] ${result.detail}; cooling down ${Math.round(BACKOFF_MS / 1000)}s`,
        )
        break
      }

      if (result.kind === 'error') {
        errors++
        if (errors <= 5) {
          console.warn(`[confirmation-worker] lookup ${txid.substring(0, 12)}…: ${result.detail}`)
        }
        continue
      }

      // 'unconfirmed' and 'not-found' are both legitimate "not mined yet"
      // outcomes: the txid stays unconfirmed and is re-chased next cycle.
      if (result.kind !== 'mined') continue

      try {
        await applyConfirmation(txid, result.status)
        confirmed++
      } catch (err) {
        console.warn(
          `[confirmation-worker] applyConfirmation(${txid.substring(0, 12)}…) failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
  } catch (err) {
    console.warn(`[confirmation-worker] cycle error: ${err instanceof Error ? err.message : err}`)
  } finally {
    running = false
  }

  if (processed > 0) {
    const ms = Date.now() - cycleStart
    console.log(
      `[confirmation-worker] provider=${CONFIRMATION_PROVIDER} processed=${processed} confirmed=${confirmed} ` +
        `errors=${errors} ${rateLimited ? 'rateLimited=true ' : ''}durationMs=${ms}`,
    )
  }
}

export function startConfirmationWorker(): void {
  if (!ENABLED) {
    console.log('[confirmation-worker] disabled via BSV_CONFIRMATION_WORKER_DISABLED')
    return
  }
  if (timer) return
  // Stagger first run by 10 s to let the rest of the worker stack settle.
  setTimeout(() => {
    void runCycle()
    timer = setInterval(() => { void runCycle() }, INTERVAL_MS)
  }, 10_000)
  console.log(
    `[confirmation-worker] started: provider=${CONFIRMATION_PROVIDER} ` +
      `wocFallback=${WOC_FALLBACK_ENABLED} intervalMs=${INTERVAL_MS} batch=${BATCH_SIZE} ` +
      `minAgeSec=${MIN_AGE_SECONDS} maxAgeHr=${MAX_AGE_HOURS} catchupDays=${CATCHUP_DAYS} ` +
      `reqIntervalMs=${REQ_INTERVAL_MS}`,
  )
}

export function stopConfirmationWorker(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** For tests / manual invocation via `npx tsx`. */
export async function runOnce(): Promise<void> {
  await runCycle()
}
