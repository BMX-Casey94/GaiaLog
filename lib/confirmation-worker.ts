/**
 * Confirmation Worker
 *
 * Periodically scans recently-broadcast (but as-yet unconfirmed) entries in
 * `overlay_explorer_readings`, `overlay_admitted_utxos`, and `tx_log`, then
 * checks WhatsOnChain for block inclusion.  When WoC reports a confirmation
 * we update:
 *
 *   - overlay_explorer_readings: confirmed=true, block_height, block_time
 *   - overlay_admitted_utxos:    confirmed=true (where txid matches)
 *   - tx_log:                    status='confirmed', block_height, onchain_at
 *
 * Without this worker, *nothing* in the pipeline ever transitions a row to
 * `confirmed=true`.  That:
 *   1. defeats BSV_MIN_SPEND_CONFIRMATIONS (every spend looks unconfirmed),
 *   2. blocks the explorer "confirmed-only" view from showing recent rows,
 *   3. allows the AFTER-DELETE retention trigger to undercount confirmed
 *      historical readings.
 *
 * The worker is intentionally conservative:
 *   - Hard-capped global RPS to avoid tripping WhatsOnChain's 3-RPS limit
 *     (key-protected accounts get higher limits but we still self-throttle).
 *   - Bounded batch size per cycle (default 30 txids).
 *   - Dynamic backoff on 429 / 5xx — pauses the worker for a cool-down
 *     period instead of hammering.
 *   - All DB writes use idempotent UPDATE … WHERE NOT confirmed predicates.
 *
 * Configurable via env:
 *   BSV_CONFIRMATION_WORKER_DISABLED=true     - opt out entirely
 *   BSV_CONFIRMATION_INTERVAL_MS=30000        - between cycles (default 30s)
 *   BSV_CONFIRMATION_BATCH_SIZE=30            - txids per cycle
 *   BSV_CONFIRMATION_MIN_AGE_SECONDS=60       - skip txids younger than this
 *   BSV_CONFIRMATION_MAX_AGE_HOURS=72         - stop chasing after this
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

const ENABLED = !envBool('BSV_CONFIRMATION_WORKER_DISABLED', false)
const INTERVAL_MS = envInt('BSV_CONFIRMATION_INTERVAL_MS', 30_000, 5_000)
const BATCH_SIZE = envInt('BSV_CONFIRMATION_BATCH_SIZE', 30, 1)
const MIN_AGE_SECONDS = envInt('BSV_CONFIRMATION_MIN_AGE_SECONDS', 60, 0)
const MAX_AGE_HOURS = envInt('BSV_CONFIRMATION_MAX_AGE_HOURS', 72, 1)
const REQ_INTERVAL_MS = envInt('BSV_CONFIRMATION_REQ_INTERVAL_MS', 400, 200)
const BACKOFF_MS = envInt('BSV_CONFIRMATION_BACKOFF_MS', 120_000, 5_000)

let timer: NodeJS.Timeout | null = null
let running = false
let cooldownUntil = 0
let lastWocAt = 0

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
 * we care about ends up there, and the index on (confirmed, reading_ts) makes
 * this cheap.
 */
async function fetchCandidates(): Promise<CandidateTxid[]> {
  const minAge = `${MIN_AGE_SECONDS} seconds`
  const maxAge = `${MAX_AGE_HOURS} hours`
  const result = await query<CandidateTxid>(
    `SELECT txid
       FROM overlay_explorer_readings
      WHERE confirmed = false
        AND reading_ts < now() - $1::interval
        AND reading_ts > now() - $2::interval
      ORDER BY reading_ts ASC
      LIMIT $3`,
    [minAge, maxAge, BATCH_SIZE],
  )
  return result.rows
}

interface WocTxStatus {
  blockHeight: number | null
  blockTime: Date | null
}

async function lookupTxStatus(txid: string): Promise<WocTxStatus | null | 'rate-limited'> {
  // Self-throttle to ≤ 1 request / REQ_INTERVAL_MS to stay well clear of WoC's
  // public 3 RPS limit even with multiple workers competing.
  const now = Date.now()
  const waitMs = REQ_INTERVAL_MS - (now - lastWocAt)
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
  lastWocAt = Date.now()

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

    if (res.status === 429 || res.status === 503) return 'rate-limited'
    if (res.status === 404) return null
    if (!res.ok) return null

    const body = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') return null

    const blockHeightRaw =
      typeof body.blockheight === 'number' ? body.blockheight :
      typeof body.blockHeight === 'number' ? body.blockHeight :
      null

    if (!blockHeightRaw || blockHeightRaw <= 0) {
      // Returned but not yet in a block — caller will retry next cycle.
      return null
    }

    const blockTimeRaw =
      typeof body.blocktime === 'number' ? body.blocktime :
      typeof body.time === 'number' ? body.time :
      null

    return {
      blockHeight: blockHeightRaw,
      blockTime: blockTimeRaw ? new Date(blockTimeRaw * 1000) : null,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

async function applyConfirmation(txid: string, status: WocTxStatus): Promise<void> {
  const blockHeight = status.blockHeight ?? 0
  if (blockHeight <= 0) return

  await confirmReading(txid, blockHeight, status.blockTime)

  // Mark every UTXO row that came from this tx as confirmed.  Cheap point
  // lookup — covered by overlay_admitted_utxos_outpoint_idx (txid-prefix).
  await query(
    `UPDATE overlay_admitted_utxos
        SET confirmed = true
      WHERE txid = $1
        AND confirmed = false`,
    [txid],
  )

  // tx_log status, if a row exists.  Best-effort — schema variants observed
  // in the wild use either `status`/`onchain_at`/`block_height` or just
  // `confirmed_at`.  Try the richest shape first, fall back gracefully.
  try {
    await query(
      `UPDATE tx_log
          SET status = 'confirmed',
              block_height = GREATEST(COALESCE(block_height, 0), $2),
              onchain_at   = COALESCE(onchain_at, $3)
        WHERE txid = $1
          AND status <> 'confirmed'`,
      [txid, blockHeight, status.blockTime ?? new Date()],
    )
  } catch (err) {
    // Older tx_log schemas — silently ignore so the worker keeps progressing.
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

  try {
    const candidates = await fetchCandidates()
    if (candidates.length === 0) return

    for (const { txid } of candidates) {
      processed++
      const result = await lookupTxStatus(txid)

      if (result === 'rate-limited') {
        rateLimited = true
        cooldownUntil = Date.now() + BACKOFF_MS
        console.warn(
          `[confirmation-worker] WhatsOnChain rate-limited; cooling down ${Math.round(BACKOFF_MS / 1000)}s`,
        )
        break
      }

      if (result && result.blockHeight && result.blockHeight > 0) {
        try {
          await applyConfirmation(txid, result)
          confirmed++
        } catch (err) {
          console.warn(
            `[confirmation-worker] applyConfirmation(${txid.substring(0, 12)}…) failed: ${err instanceof Error ? err.message : err}`,
          )
        }
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
      `[confirmation-worker] processed=${processed} confirmed=${confirmed} ${rateLimited ? 'rateLimited=true ' : ''}durationMs=${ms}`,
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
    `[confirmation-worker] started: intervalMs=${INTERVAL_MS} batch=${BATCH_SIZE} ` +
    `minAgeSec=${MIN_AGE_SECONDS} maxAgeHr=${MAX_AGE_HOURS} reqIntervalMs=${REQ_INTERVAL_MS}`,
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
