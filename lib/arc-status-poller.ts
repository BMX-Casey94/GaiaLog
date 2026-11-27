/**
 * ARC broadcast status poller
 *
 * Advances `arc_broadcast_status.phase` for open and reorg rows accepted via
 * TAAL or GorillaPool ARC by GETting `/v1/tx/{txid}`. Reorg stays in the
 * batch so a later MINED can confirm it again. Applies inventory / explorer
 * follow-ups from `arcFollowUp` without deleting explorer rows. The phase
 * row is updated only after the follow-up succeeds, so a failed update
 * stays in the batch and is retried.
 *
 * Opt out: BSV_ARC_STATUS_POLL_DISABLED=true
 * Interval: BSV_ARC_STATUS_POLL_INTERVAL_MS (default 15000, min 5000)
 * Batch: BSV_ARC_STATUS_POLL_BATCH (default 20, min 1)
 * 404 budget: BSV_ARC_POLL_MAX_404_MISSES (default 10, min 1) — after this many
 *   consecutive 404s the row is polled with capped exponential backoff (max
 *   1 hour) instead of every cycle. It is never dropped: a dropped row would
 *   strand its change outputs at acquirable_at = 'infinity'.
 */

import {
  arcBroadcastPhaseForDb,
  arcFollowUp,
  classifyArcTxStatus,
  shouldPersistArcPhase,
  type ArcPhase,
} from './arc-tx-status'
import { query } from './db'
import { confirmReading } from './overlay-explorer-repository'
import { refreshTopicCounts, withOverlayTransaction } from './overlay-repository'

const ENABLED = !envBool('BSV_ARC_STATUS_POLL_DISABLED', false)
const INTERVAL_MS = envInt('BSV_ARC_STATUS_POLL_INTERVAL_MS', 15_000, 5_000)
const BATCH_SIZE = envInt('BSV_ARC_STATUS_POLL_BATCH', 20, 1)
/**
 * Number of consecutive HTTP 404s after which a txid stops being polled every
 * cycle. 404 is usually ARC having pruned the transaction from its store —
 * sometimes because it was never broadcast through this endpoint — but it is
 * not authoritative, so the row is backed off rather than dropped: dropping it
 * would leave its change outputs at acquirable_at = 'infinity' forever.
 */
const MAX_404_MISSES = envInt('BSV_ARC_POLL_MAX_404_MISSES', 10, 1)
/** Bound on the per-txid 404 counter map; oldest entries are evicted first. */
const MAX_404_TRACKED_TXIDS = 5_000
const GET_GAP_MS = 200
const GET_TIMEOUT_MS = 8_000
const RATE_LIMIT_COOLDOWN_MS = 60_000

const TAAL_ENDPOINT = (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/$/, '')
const TAAL_KEY = process.env.BSV_ARC_API_KEY || ''
const GORILLAPOOL_ENDPOINT = (
  process.env.BSV_GORILLAPOOL_ARC_ENDPOINT || 'https://arc.gorillapool.io'
).replace(/\/$/, '')
const GORILLAPOOL_KEY = process.env.BSV_GORILLAPOOL_API_KEY || ''

let timer: NodeJS.Timeout | null = null
let running = false
let cooldownUntil = 0
let missingTableLogged = false
/**
 * Consecutive HTTP 404 counts per txid, bounded so a long-running worker
 * cannot leak memory. Insertion order is eviction order (Map semantics).
 */
const notFoundMisses = new Map<string, number>()
/** Upper bound on the growth of a single txid's 404 backoff. */
const MAX_404_BACKOFF_MS = 60 * 60_000

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

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '42P01'
  )
}

/**
 * Record one consecutive 404 for a txid.
 *
 * The map is bounded (MAX_404_TRACKED_TXIDS) and evicts the oldest entry, so a
 * worker with a long uptime cannot accumulate unbounded state. It holds counts
 * only: the *schedule* lives in the database (see scheduleNextPoll), so a
 * restart cannot cause a stampede on rows that were mid-backoff.
 *
 * A 404 is a definite "ARC does not have it", but ARC's store is not
 * authoritative for a transaction that may still be mined elsewhere, so the row
 * is never dropped: its change outputs would otherwise stay at
 * acquirable_at = 'infinity' forever.
 */
function recordNotFound(txid: string): { misses: number; backoffMs: number } {
  const previous = notFoundMisses.get(txid) || 0
  const misses = Math.min(previous + 1, MAX_404_MISSES + 8)
  // Below the budget the row simply rotates and is retried next cycle. At the
  // budget it starts at 8 intervals (2 min at the default 15 s cadence) and
  // doubles, so the row settles at one poll per hour rather than one per
  // cycle — without ever being dropped.
  const backoffMs = misses < MAX_404_MISSES
    ? 0
    : Math.min(MAX_404_BACKOFF_MS, INTERVAL_MS * 8 * 2 ** (misses - MAX_404_MISSES))

  notFoundMisses.delete(txid)
  notFoundMisses.set(txid, misses)
  while (notFoundMisses.size > MAX_404_TRACKED_TXIDS) {
    const oldest = notFoundMisses.keys().next()
    if (oldest.done) break
    notFoundMisses.delete(oldest.value)
  }
  return { misses, backoffMs }
}

/** Clear a txid's miss count after ARC answered for it again. */
function clearNotFound(txid: string): void {
  notFoundMisses.delete(txid)
}

/**
 * Push a backed-off row to the back of the open-batch queue (which is ordered
 * by `updated_at ASC`) instead of writing it once per cycle. One statement per
 * threshold crossing rather than one every 15 seconds per stranded txid.
 */
async function scheduleNextPoll(txid: string, delayMs: number): Promise<void> {
  await query(
    `UPDATE arc_broadcast_status
        SET updated_at = now() + ($2::bigint * interval '1 millisecond')
      WHERE txid = $1`,
    [txid, Math.max(1, Math.floor(delayMs))],
  )
}

interface OpenBroadcastRow {
  txid: string
  phase: ArcPhase
  accepted_via: string
}

function endpointFor(acceptedVia: string): { endpoint: string; apiKey: string } {
  if (acceptedVia === 'gorillapool_arc') {
    return { endpoint: GORILLAPOOL_ENDPOINT, apiKey: GORILLAPOOL_KEY }
  }
  return { endpoint: TAAL_ENDPOINT, apiKey: TAAL_KEY }
}

async function bumpUpdatedAt(txid: string): Promise<void> {
  await query(`UPDATE arc_broadcast_status SET updated_at = now() WHERE txid = $1`, [txid])
}

/**
 * Persist the new phase, clamped to what `arc_broadcast_status.phase`'s CHECK
 * constraint accepts (db/migrations/0032 — no `immutable`). `arcBroadcastPhaseForDb`
 * maps `immutable` → `mined`, which every reader already treats as confirmed
 * and which keeps the row out of this poller's open-batch index.
 *
 * Guard mirrors lib/arc-broadcast-status.ts: a `mined` row is only replaced by
 * another confirmation or a reorg, so a late duplicate poll cannot regress it.
 */
async function persistArcPhase(
  txid: string,
  txStatus: string,
  acceptedVia: string,
  phase: ArcPhase,
): Promise<void> {
  const dbPhase = arcBroadcastPhaseForDb(phase)
  await query(
    `INSERT INTO arc_broadcast_status (txid, tx_status, phase, accepted_via, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (txid) DO UPDATE SET
       tx_status = EXCLUDED.tx_status,
       phase = EXCLUDED.phase,
       accepted_via = EXCLUDED.accepted_via,
       updated_at = now()
     WHERE arc_broadcast_status.phase <> 'mined'
        OR EXCLUDED.phase IN ('mined', 'reorg')`,
    [txid, txStatus, dbPhase, acceptedVia],
  )
}

async function unlockChangeOutputs(txid: string): Promise<void> {
  await query(
    `UPDATE overlay_admitted_utxos
        SET acquirable_at = now()
      WHERE txid = $1
        AND removed = false
        AND acquirable_at > now()`,
    [txid],
  )
}

async function applySeen(txid: string): Promise<void> {
  await unlockChangeOutputs(txid)
}

async function applyMined(txid: string, blockHeight: number): Promise<void> {
  // One atomic UPDATE inside a single transaction: `confirmed` and a
  // spendable `acquirable_at` must land together or not at all. Previously a
  // separate unlockChangeOutputs ran first, so a crash between the two left
  // the change unspendable; and a concurrent reorg pass could interleave and
  // leave confirmed=true with acquirable_at='infinity'.
  await withOverlayTransaction(async (client) => {
    await client.query(
      `UPDATE overlay_admitted_utxos
          SET confirmed = true,
              acquirable_at = LEAST(acquirable_at, now())
        WHERE txid = $1
          AND removed = false
          AND (confirmed = false OR acquirable_at > now())`,
      [txid],
    )
  })

  await confirmReading(txid, blockHeight, null)
  try {
    await query(
      `UPDATE tx_log
          SET status = 'confirmed',
              onchain_at = COALESCE(onchain_at, now())
        WHERE txid = $1
          AND status <> 'confirmed'`,
      [txid],
    )
  } catch {
    // tx_log may be unavailable; explorer/UTXO updates already applied
  }
}

async function applyReorg(txid: string): Promise<void> {
  await query(
    `UPDATE overlay_explorer_readings
        SET confirmed = false
      WHERE txid = $1
        AND confirmed = true`,
    [txid],
  )
  await query(
    `UPDATE overlay_admitted_utxos
        SET confirmed = false,
            acquirable_at = 'infinity'
      WHERE txid = $1
        AND removed = false`,
    [txid],
  )
}

async function applyRelease(txid: string): Promise<void> {
  let skipped = false
  await withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = 15000`)
    // Lock this tx's outputs and the inputs it consumed before deciding.
    // Two single-predicate queries keep Postgres on the txid and spending_txid
    // indexes instead of falling back to a sequential scan on an OR.
    const outputs = await client.query<{ removed: boolean }>(
      `SELECT removed
         FROM overlay_admitted_utxos
        WHERE txid = $1
        FOR UPDATE`,
      [txid],
    )
    if ((outputs.rows || []).some((row) => row.removed === true)) {
      skipped = true
      return
    }

    await client.query(
      `SELECT 1
         FROM overlay_admitted_utxos
        WHERE spending_txid = $1
          AND removed = true
        FOR UPDATE`,
      [txid],
    )

    const removed = await client.query<{ topic: string }>(
      `UPDATE overlay_admitted_utxos
          SET removed = true,
              removed_at = now(),
              spending_txid = 'arc-rejected'
        WHERE txid = $1
          AND removed = false
      RETURNING topic`,
      [txid],
    )
    const restored = await client.query<{ topic: string }>(
      `UPDATE overlay_admitted_utxos
          SET removed = false,
              removed_at = NULL,
              spending_txid = NULL,
              locked = false,
              locked_by = NULL,
              locked_at = NULL,
              acquirable_at = now()
        WHERE spending_txid = $1
          AND removed = true
      RETURNING topic`,
      [txid],
    )

    const deltas = new Map<string, number>()
    for (const row of removed.rows || []) {
      deltas.set(row.topic, (deltas.get(row.topic) || 0) - 1)
    }
    for (const row of restored.rows || []) {
      deltas.set(row.topic, (deltas.get(row.topic) || 0) + 1)
    }
    for (const [topic, delta] of deltas) {
      if (delta !== 0) await refreshTopicCounts(client, topic, delta)
    }
  })

  if (skipped) {
    console.warn(
      `[arc-status-poller] release skipped for ${txid.substring(0, 12)}…: change already spent by a later tx`,
    )
    return
  }

  try {
    await query(
      `UPDATE tx_log
          SET status = 'failed',
              error = 'arc-rejected',
              onchain_at = NULL
        WHERE txid = $1
          AND status <> 'confirmed'`,
      [txid],
    )
  } catch {
    // best-effort
  }
}

async function applyFollowUp(
  followUp: ReturnType<typeof arcFollowUp>,
  txid: string,
  blockHeight: number,
): Promise<void> {
  switch (followUp) {
    case 'hold':
      return
    case 'unlock-change':
      await applySeen(txid)
      return
    case 'confirm':
      await applyMined(txid, blockHeight)
      return
    case 'reorg':
      await applyReorg(txid)
      return
    case 'release':
      await applyRelease(txid)
      return
  }
}

type GetResult =
  | { kind: 'rate-limited' }
  | { kind: 'not-found' }
  | { kind: 'transport' }
  | { kind: 'ok'; txStatus: string; blockHeight: number }

async function getArcTxStatus(acceptedVia: string, txid: string): Promise<GetResult> {
  const { endpoint, apiKey } = endpointFor(acceptedVia)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), GET_TIMEOUT_MS)

  try {
    const res = await fetch(`${endpoint}/v1/tx/${txid}`, {
      headers,
      signal: controller.signal,
    })

    if (res.status === 429) return { kind: 'rate-limited' }
    // 404 is a definite answer ("ARC does not know this txid"), which is a
    // different situation from a transport failure that says nothing at all.
    if (res.status === 404) return { kind: 'not-found' }
    if (res.status !== 200) return { kind: 'transport' }

    const body = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') return { kind: 'transport' }

    const txStatus =
      typeof (body as { txStatus?: unknown }).txStatus === 'string'
        ? (body as { txStatus: string }).txStatus
        : null
    if (txStatus == null) return { kind: 'transport' }

    const rawHeight =
      (body as { blockHeight?: unknown }).blockHeight ??
      (body as { blockheight?: unknown }).blockheight
    const blockHeight =
      typeof rawHeight === 'number' && Number.isFinite(rawHeight) && rawHeight > 0
        ? rawHeight
        : 0

    return { kind: 'ok', txStatus, blockHeight }
  } catch {
    return { kind: 'transport' }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchOpenBatch(): Promise<OpenBroadcastRow[] | null> {
  try {
    const result = await query<OpenBroadcastRow>(
      // `updated_at <= now()` is what makes per-row 404 backoff real: a row
      // pushed into the future (scheduleNextPoll) is skipped entirely rather
      // than re-picked immediately when the open set is smaller than BATCH_SIZE.
      `SELECT txid, phase, accepted_via
         FROM arc_broadcast_status
        WHERE phase IN ('orphan', 'pending', 'seen', 'reorg')
          AND accepted_via IN ('taal_arc', 'gorillapool_arc')
          AND updated_at <= now()
        ORDER BY updated_at ASC
        LIMIT $1`,
      [BATCH_SIZE],
    )
    return result.rows || []
  } catch (err) {
    if (isUndefinedTable(err)) {
      if (!missingTableLogged) {
        missingTableLogged = true
        console.warn(
          '[arc-status-poller] arc_broadcast_status table missing; skipping cycles until migrated',
        )
      }
      return null
    }
    throw err
  }
}

async function runCycle(): Promise<void> {
  if (running) return
  if (Date.now() < cooldownUntil) return
  running = true

  try {
    const batch = await fetchOpenBatch()
    if (batch == null || batch.length === 0) return

    for (let i = 0; i < batch.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, GET_GAP_MS))

      const row = batch[i]
      const result = await getArcTxStatus(row.accepted_via, row.txid)

      if (result.kind === 'rate-limited') {
        cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
        console.warn(
          `[arc-status-poller] HTTP 429; cooling down ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s`,
        )
        break
      }

      if (result.kind === 'not-found') {
        const { misses, backoffMs } = recordNotFound(row.txid)
        try {
          if (backoffMs === 0) {
            // Below the threshold: ordinary rotation, next cycle retries.
            await bumpUpdatedAt(row.txid)
          } else {
            // At/over the threshold: push the row out of the hot window. One
            // write per threshold crossing, not one per cycle.
            await scheduleNextPoll(row.txid, backoffMs)
            if (misses === MAX_404_MISSES) {
              console.warn(
                `[arc-status-poller] ${row.txid.substring(0, 12)}…: ${MAX_404_MISSES} consecutive 404s. ` +
                  `Backing off (max ${Math.round(MAX_404_BACKOFF_MS / 60_000)} min between polls); the row ` +
                  `stays open so a later confirmation is still picked up. Tune with ` +
                  `BSV_ARC_POLL_MAX_404_MISSES.`,
              )
            }
          }
        } catch (err) {
          console.warn(
            `[arc-status-poller] 404 bookkeeping for ${row.txid.substring(0, 12)}… failed: ${
              err instanceof Error ? err.message : err
            }`,
          )
        }
        continue
      }

      if (result.kind === 'transport') {
        try {
          await bumpUpdatedAt(row.txid)
        } catch (err) {
          console.warn(
            `[arc-status-poller] bumpUpdatedAt(${row.txid.substring(0, 12)}…) failed: ${
              err instanceof Error ? err.message : err
            }`,
          )
        }
        continue
      }

      clearNotFound(row.txid)
      // ARC's own status endpoint: DOUBLE_SPEND_ATTEMPTED here means ARC has
      // seen a competing spend, not that this transaction lost. Keep holding.
      const next = classifyArcTxStatus(result.txStatus, 'arc')
      try {
        if (!shouldPersistArcPhase(row.phase, next)) {
          await bumpUpdatedAt(row.txid)
          continue
        }

        await applyFollowUp(arcFollowUp(next), row.txid, result.blockHeight)
        await persistArcPhase(row.txid, result.txStatus, row.accepted_via, next)
      } catch (err) {
        console.warn(
          `[arc-status-poller] apply(${row.txid.substring(0, 12)}… → ${next}) failed: ${
            err instanceof Error ? err.message : err
          }`,
        )
        // Keep the old phase, but rotate the row so one failure cannot
        // sit at the head of every batch.
        try {
          await bumpUpdatedAt(row.txid)
        } catch {
          // next cycle will try this txid again
        }
      }
    }
  } catch (err) {
    console.warn(`[arc-status-poller] cycle error: ${err instanceof Error ? err.message : err}`)
  } finally {
    running = false
  }
}

export function startArcStatusPoller(): void {
  if (!ENABLED) {
    console.log('[arc-status-poller] disabled via BSV_ARC_STATUS_POLL_DISABLED')
    return
  }
  if (timer) return
  setTimeout(() => {
    void runCycle()
    timer = setInterval(() => {
      void runCycle()
    }, INTERVAL_MS)
  }, 12_000)
  console.log(
    `[arc-status-poller] started: intervalMs=${INTERVAL_MS} batch=${BATCH_SIZE}`,
  )
}

export function stopArcStatusPoller(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** For tests / manual invocation via `npx tsx`. */
export async function runOnce(): Promise<void> {
  await runCycle()
}
