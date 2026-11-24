/**
 * Instance-pinned broadcast reconciler.
 *
 * The SSE stream is fast but fragile. This poller is the path that is always
 * available, and it is deliberately narrow in what it queries.
 *
 * ## Instance pinning
 *
 * A Broadcaster host's `GET /tx/{txid}` returns 404 for a txid it has never
 * issued a verdict for. It does *not* proxy to its peers. So a transaction
 * submitted to `arcade-eu-1` must be reconciled against `arcade-eu-1`; asking
 * `arcade-us-1` returns 404 forever, which under a naive retry policy looks
 * exactly like "the broadcaster has forgotten this transaction" and would
 * eventually be treated as a loss.
 *
 * The accepting host is recorded at submit time in
 * `arc_broadcast_status.accepted_endpoint`, and that is the only host this
 * module asks about a row. Rows without a recorded endpoint fall back to the
 * first configured host, and that fallback is logged once — it is a data gap,
 * not a normal state.
 *
 * ## The two jobs
 *
 *   1. Advance open rows (`pending`/`seen`/`orphan`/`reorg`) from the
 *      broadcaster's own view of the transaction.
 *   2. Sweep rows already marked mined that have a `merkle_path` but are not
 *      `spv_verified`. This is the backlog the SSE path leaves behind when a
 *      proof arrived before Chaintracks was reachable, or before the migration
 *      that added the verification columns had run.
 *
 * ## 404 is not deletion
 *
 * A 404 means this instance has no verdict. A transaction can still be mined
 * via another route. Dropping the row would strand its change at
 * `acquirable_at = 'infinity'` forever, so the row is backed off instead —
 * capped exponential up to an hour — and never removed.
 */

import {
  arcBroadcastPhaseForDb,
  arcFollowUp,
  classifyArcTxStatus,
  shouldPersistArcPhase,
  type ArcPhase,
} from '../arc-tx-status'
import { query } from '../db'
import { confirmReading } from '../overlay-explorer-repository'
import { withOverlayTransaction } from '../overlay-repository'
import { getBroadcasterHosts, isBroadcasterEnabled } from './broadcaster-client'
import { verifyMerkleProof } from '../spv/verify-merkle'
import { upsertArcBroadcastStatus, recordSpvVerification, describeError } from '../arc-broadcast-status'

interface OpenRow {
  txid: string
  phase: ArcPhase
  accepted_endpoint: string | null
}

interface MinedRow {
  txid: string
  merkle_path: string
  block_hash: string | null
  block_height: number | null
}

const ENABLED = !envBool('BSV_BROADCAST_RECONCILE_DISABLED', false)
const INTERVAL_MS = envInt('BSV_BROADCAST_RECONCILE_INTERVAL_MS', 20_000, 5_000)
const BATCH_SIZE = envInt('BSV_BROADCAST_RECONCILE_BATCH', 25, 1)
const SPV_BATCH_SIZE = envInt('BSV_BROADCAST_SPV_BATCH', 25, 1)
const GET_TIMEOUT_MS = envInt('BSV_BROADCAST_RECONCILE_TIMEOUT_MS', 8_000, 1_000)
const GET_GAP_MS = envInt('BSV_BROADCAST_RECONCILE_GAP_MS', 150, 0)
const MAX_404_MISSES = envInt('BSV_BROADCAST_MAX_404_MISSES', 12, 1)
const MAX_404_BACKOFF_MS = 60 * 60_000
const MAX_TRACKED_TXIDS = 5_000
const RATE_LIMIT_COOLDOWN_MS = 60_000

let timer: NodeJS.Timeout | null = null
let running = false
let cooldownUntil = 0
let missingEndpointLogged = false
let preMigrationLogged = false

/** Consecutive 404 counts per txid; bounded by `MAX_TRACKED_TXIDS`. */
const notFoundMisses = new Map<string, number>()

function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, parsed)
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const normalised = raw.trim().toLowerCase()
  if (normalised === 'true' || normalised === '1') return true
  if (normalised === 'false' || normalised === '0') return false
  return fallback
}

function isUndefinedColumn(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === '42703'
  )
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === '42P01'
  )
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * A host that can actually be queried.
 *
 * An endpoint with a path (for example one that already carries `/v1`) would
 * produce `.../v1/tx/{txid}`, which the Broadcaster does not serve. Only the
 * origin plus the configured path prefix is kept.
 */
function normaliseEndpoint(endpoint: string | null): string | null {
  if (!endpoint) return null
  const trimmed = trimTrailingSlashes(endpoint.trim())
  if (!/^https?:\/\//i.test(trimmed)) return null
  return trimmed
}

/**
 * The host to ask about a row.
 *
 * Pinned to the accepting instance when known. The fallback matters: rows
 * written before `accepted_endpoint` existed (or by the legacy ARC path) still
 * need reconciling, and the first configured host is the best available guess.
 */
function endpointForRow(row: OpenRow): string | null {
  const pinned = normaliseEndpoint(row.accepted_endpoint)
  if (pinned) return pinned
  const hosts = getBroadcasterHosts()
  if (hosts.length === 0) return null
  if (!missingEndpointLogged) {
    missingEndpointLogged = true
    console.warn(
      `[broadcast-reconcile] ${row.txid.substring(0, 12)}… has no accepted_endpoint recorded; ` +
        `querying ${hosts[0]} by guess. New broadcasts record the accepting host.`,
    )
  }
  return hosts[0]
}

function recordNotFound(txid: string): { misses: number; backoffMs: number } {
  const previous = notFoundMisses.get(txid) ?? 0
  const misses = Math.min(previous + 1, MAX_404_MISSES + 8)
  // Below the budget the row simply rotates and is retried next cycle. At the
  // budget it starts at 8 intervals and doubles, settling at one poll per hour.
  const backoffMs = misses < MAX_404_MISSES
    ? 0
    : Math.min(MAX_404_BACKOFF_MS, INTERVAL_MS * 8 * 2 ** (misses - MAX_404_MISSES))

  notFoundMisses.delete(txid)
  notFoundMisses.set(txid, misses)
  while (notFoundMisses.size > MAX_TRACKED_TXIDS) {
    const oldest = notFoundMisses.keys().next()
    if (oldest.done) break
    notFoundMisses.delete(oldest.value)
  }
  return { misses, backoffMs }
}

function clearNotFound(txid: string): void {
  notFoundMisses.delete(txid)
}

/** Push a row out of the hot window without writing once per cycle. */
async function scheduleNextPoll(txid: string, delayMs: number): Promise<void> {
  await query(
    `UPDATE arc_broadcast_status
        SET updated_at = now() + ($2::bigint * interval '1 millisecond')
      WHERE txid = $1`,
    [txid, Math.max(1, Math.floor(delayMs))],
  )
}

async function bumpUpdatedAt(txid: string): Promise<void> {
  await query(`UPDATE arc_broadcast_status SET updated_at = now() WHERE txid = $1`, [txid])
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

async function applyMined(txid: string, blockHeight: number): Promise<void> {
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
    // tx_log may be unavailable; the inventory update above already applied.
  }
}

async function applyReorg(txid: string): Promise<void> {
  await query(
    `UPDATE overlay_explorer_readings SET confirmed = false WHERE txid = $1 AND confirmed = true`,
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
  const skipped = await withOverlayTransaction(async (client) => {
    const locked = await client.query<{ txid: string; removed: boolean }>(
      `SELECT txid, removed
         FROM overlay_admitted_utxos
        WHERE txid = $1
           OR spending_txid = $1
        FOR UPDATE`,
      [txid],
    )
    if ((locked.rows ?? []).some((row) => row.txid === txid && row.removed === true)) {
      return true
    }

    await client.query(
      `UPDATE overlay_admitted_utxos
          SET removed = true,
              removed_at = now(),
              spending_txid = 'broadcaster-rejected'
        WHERE txid = $1
          AND removed = false`,
      [txid],
    )
    await client.query(
      `UPDATE overlay_admitted_utxos
          SET removed = false,
              removed_at = NULL,
              spending_txid = NULL,
              locked = false,
              locked_by = NULL,
              locked_at = NULL,
              acquirable_at = now()
        WHERE spending_txid = $1
          AND removed = true`,
      [txid],
    )
    return false
  })

  if (skipped) {
    console.warn(
      `[broadcast-reconcile] release skipped for ${txid.substring(0, 12)}…: change already spent by a later tx`,
    )
    return
  }

  try {
    await query(
      `UPDATE tx_log
          SET status = 'failed',
              error = 'broadcaster-rejected',
              onchain_at = NULL
        WHERE txid = $1
          AND status <> 'confirmed'`,
      [txid],
    )
  } catch {
    // best-effort
  }
}

type GetResult =
  | { kind: 'ok'; txStatus: string; blockHeight: number; merklePath: string | null; blockHash: string | null }
  | { kind: 'not-found' }
  | { kind: 'rate-limited' }
  | { kind: 'transport' }

async function getBroadcasterTxStatus(
  endpoint: string,
  txid: string,
): Promise<GetResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GET_TIMEOUT_MS)
  try {
    const response = await fetch(`${endpoint}/tx/${txid}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 404) return { kind: 'not-found' }
    if (response.status === 429) return { kind: 'rate-limited' }
    if (!response.ok) return { kind: 'transport' }

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return { kind: 'transport' }
    const txStatus = typeof body.txStatus === 'string' ? body.txStatus : null
    if (txStatus == null) return { kind: 'transport' }

    const rawHeight = body.blockHeight ?? body.blockheight
    const blockHeight = typeof rawHeight === 'number' && Number.isSafeInteger(rawHeight) && rawHeight > 0
      ? rawHeight
      : 0
    const rawPath = body.merklePath ?? body.merkle_path
    const merklePath = typeof rawPath === 'string' && rawPath.trim() !== '' ? rawPath.trim() : null
    const rawHash = body.blockHash
    const blockHash = typeof rawHash === 'string' && /^[0-9a-fA-F]{64}$/.test(rawHash)
      ? rawHash.toLowerCase()
      : null

    return { kind: 'ok', txStatus, blockHeight, merklePath, blockHash }
  } catch {
    return { kind: 'transport' }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchOpenBatch(): Promise<OpenRow[] | null> {
  try {
    const result = await query<OpenRow>(
      // `updated_at <= now()` is what makes per-row backoff real: a row pushed
      // into the future is skipped rather than re-picked immediately when the
      // open set is smaller than the batch size.
      `SELECT txid, phase, accepted_endpoint
         FROM arc_broadcast_status
        WHERE provider = 'broadcaster'
          AND phase IN ('orphan', 'pending', 'seen', 'reorg')
          AND updated_at <= now()
        ORDER BY updated_at ASC
        LIMIT $1`,
      [BATCH_SIZE],
    )
    return result.rows ?? []
  } catch (error) {
    if (isUndefinedColumn(error)) {
      // Pre-0035: no `provider` or `accepted_endpoint` column. Reconcile what
      // can be reconciled rather than doing nothing, but do not pretend the
      // rows are instance-pinned.
      try {
        const legacy = await query<{ txid: string; phase: ArcPhase }>(
          `SELECT txid, phase
             FROM arc_broadcast_status
            WHERE phase IN ('orphan', 'pending', 'seen', 'reorg')
              AND accepted_via IN ('bsv_broadcaster', 'taal_arc', 'gorillapool_arc')
              AND updated_at <= now()
            ORDER BY updated_at ASC
            LIMIT $1`,
          [BATCH_SIZE],
        )
        if (!preMigrationLogged) {
          preMigrationLogged = true
          console.warn(
            '[broadcast-reconcile] provider/accepted_endpoint columns are missing; reconciling ' +
              'without instance pinning until db/migrations/0035 has run',
          )
        }
        return (legacy.rows ?? []).map((row) => ({
          txid: row.txid,
          phase: row.phase,
          accepted_endpoint: null,
        }))
      } catch (legacyError) {
        if (isUndefinedTable(legacyError)) return null
        throw legacyError
      }
    }
    if (isUndefinedTable(error)) {
      if (!preMigrationLogged) {
        preMigrationLogged = true
        console.warn(
          '[broadcast-reconcile] arc_broadcast_status table missing; skipping cycles until migrated',
        )
      }
      return null
    }
    throw error
  }
}

async function fetchSpvBacklog(): Promise<MinedRow[] | null> {
  try {
    const result = await query<MinedRow>(
      `SELECT txid, merkle_path, block_hash, block_height
         FROM arc_broadcast_status
        WHERE phase IN ('mined', 'immutable')
          AND spv_verified = false
          AND merkle_path IS NOT NULL
          AND updated_at <= now()
        ORDER BY updated_at ASC
        LIMIT $1`,
      [SPV_BATCH_SIZE],
    )
    return result.rows ?? []
  } catch (error) {
    if (isUndefinedColumn(error) || isUndefinedTable(error)) return null
    throw error
  }
}

/**
 * Verify one mined row's proof and record the outcome.
 *
 * `spvVerified: false` is a normal result, not a failure: a single-leaf proof
 * or an unlinked header both leave it false, and the row stays in the backlog
 * only until it is re-examined. Rows that cannot be verified are still bumped
 * so one stuck proof cannot occupy the head of every batch.
 */
async function verifyMinedRow(row: MinedRow): Promise<void> {
  try {
    const result = await verifyMerkleProof({
      txid: row.txid,
      merklePathHex: row.merkle_path,
      claimedBlockHeight: row.block_height,
      claimedBlockHash: row.block_hash,
    })

    if (!result.validBump) {
      console.warn(
        `[broadcast-reconcile] ${row.txid.substring(0, 12)}… has an invalid proof: ${
          result.reason ?? 'no reason given'
        }`,
      )
      // An invalid proof is not something another pass will fix; record what
      // was established (nothing) and push the row out of the sweep window.
      await recordSpvVerification({
        txid: row.txid,
        merklePath: row.merkle_path,
        merkleRoot: null,
        blockHash: row.block_hash,
        blockHeight: row.block_height,
        rootMatchesHeader: false,
        spvVerified: false,
      })
      await scheduleNextPoll(row.txid, MAX_404_BACKOFF_MS)
      return
    }

    await recordSpvVerification({
      txid: row.txid,
      merklePath: row.merkle_path,
      merkleRoot: result.merkleRoot ?? null,
      blockHash: result.blockHash ?? row.block_hash,
      blockHeight: result.blockHeight ?? row.block_height,
      rootMatchesHeader: result.rootMatchesHeader,
      spvVerified: result.spvVerified,
    })

    if (!result.spvVerified && result.reason) {
      console.warn(
        `[broadcast-reconcile] ${row.txid.substring(0, 12)}… root matches header but is not ` +
          `SPV-verified: ${result.reason}`,
      )
    }
  } catch (error) {
    console.warn(
      `[broadcast-reconcile] SPV check for ${row.txid.substring(0, 12)}… failed: ${
        describeError(error)
      }`,
    )
    // Rotate so a single failing row cannot block the rest of the backlog.
    try {
      await bumpUpdatedAt(row.txid)
    } catch {
      // next cycle will retry
    }
  }
}

async function runSpvSweep(): Promise<void> {
  const backlog = await fetchSpvBacklog()
  if (backlog == null || backlog.length === 0) return
  for (const row of backlog) {
    await verifyMinedRow(row)
  }
}

async function runOpenRowPass(): Promise<void> {
  const batch = await fetchOpenBatch()
  if (batch == null || batch.length === 0) return

  for (let index = 0; index < batch.length; index++) {
    if (index > 0 && GET_GAP_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, GET_GAP_MS))
    }

    const row = batch[index]
    const endpoint = endpointForRow(row)
    if (!endpoint) {
      await bumpUpdatedAt(row.txid)
      continue
    }

    const result = await getBroadcasterTxStatus(endpoint, row.txid)

    if (result.kind === 'rate-limited') {
      cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
      console.warn(
        `[broadcast-reconcile] ${endpoint} rate-limited (429); cooling down ${Math.round(
          RATE_LIMIT_COOLDOWN_MS / 1000,
        )}s`,
      )
      return
    }

    if (result.kind === 'not-found') {
      const { misses, backoffMs } = recordNotFound(row.txid)
      try {
        if (backoffMs === 0) {
          await bumpUpdatedAt(row.txid)
        } else {
          await scheduleNextPoll(row.txid, backoffMs)
          if (misses === MAX_404_MISSES) {
            console.warn(
              `[broadcast-reconcile] ${row.txid.substring(0, 12)}…: ${MAX_404_MISSES} consecutive ` +
                `404s from ${endpoint}. Backing off to at most ` +
                `${Math.round(MAX_404_BACKOFF_MS / 60_000)} min between polls; the row stays open ` +
                `so a later confirmation is still picked up.`,
            )
          }
        }
      } catch (error) {
        console.warn(
          `[broadcast-reconcile] 404 bookkeeping for ${row.txid.substring(0, 12)}… failed: ${
            describeError(error)
          }`,
        )
      }
      continue
    }

    if (result.kind === 'transport') {
      try {
        await bumpUpdatedAt(row.txid)
      } catch (error) {
        console.warn(
          `[broadcast-reconcile] bumpUpdatedAt(${row.txid.substring(0, 12)}…) failed: ${
            describeError(error)
          }`,
        )
      }
      continue
    }

    clearNotFound(row.txid)
    // The Broadcaster's own status endpoint. DOUBLE_SPEND_ATTEMPTED here is
    // terminal (unlike ARC's), which is what the `broadcaster` provider means.
    const next = classifyArcTxStatus(result.txStatus, 'broadcaster')
    try {
      if (!shouldPersistArcPhase(row.phase, next)) {
        await bumpUpdatedAt(row.txid)
        continue
      }

      const followUp = arcFollowUp(next)
      if (followUp === 'unlock-change') {
        await unlockChangeOutputs(row.txid)
      } else if (followUp === 'confirm') {
        await applyMined(row.txid, result.blockHeight)
      } else if (followUp === 'reorg') {
        await applyReorg(row.txid)
      } else if (followUp === 'release') {
        await applyRelease(row.txid)
      }

      await upsertArcBroadcastStatus({
        txid: row.txid,
        txStatus: result.txStatus,
        acceptedVia: null,
        provider: 'broadcaster',
        acceptedEndpoint: endpoint,
        merklePath: result.merklePath,
        blockHash: result.blockHash,
        blockHeight: result.blockHeight > 0 ? result.blockHeight : null,
      })

      if (result.merklePath && (next === 'mined' || next === 'immutable')) {
        // Verification runs inline here: unlike the SSE path, there is no
        // stream to keep draining, and this pass is already off the hot path.
        await verifyMinedRow({
          txid: row.txid,
          merkle_path: result.merklePath,
          block_hash: result.blockHash,
          block_height: result.blockHeight > 0 ? result.blockHeight : null,
        })
      }
    } catch (error) {
      console.warn(
        `[broadcast-reconcile] apply(${row.txid.substring(0, 12)}… → ${next}) failed: ${
          describeError(error)
        }`,
      )
      try {
        await bumpUpdatedAt(row.txid)
      } catch {
        // next cycle will retry
      }
    }
  }
}

async function runCycle(): Promise<void> {
  if (running) return
  if (Date.now() < cooldownUntil) return
  if (!isBroadcasterEnabled()) return
  running = true
  try {
    await runOpenRowPass()
    await runSpvSweep()
  } catch (error) {
    console.warn(
      `[broadcast-reconcile] cycle error: ${describeError(error)}`,
    )
  } finally {
    running = false
  }
}

export function startBroadcastReconciler(): void {
  if (!ENABLED) {
    console.log('[broadcast-reconcile] disabled via BSV_BROADCAST_RECONCILE_DISABLED')
    return
  }
  if (timer) return
  // Staggered start so the reconciler does not compete with the SSE subscriber
  // and the status pollers for the same connections at boot.
  setTimeout(() => {
    void runCycle()
    timer = setInterval(() => {
      void runCycle()
    }, INTERVAL_MS)
  }, 15_000)
  console.log(`[broadcast-reconcile] started: intervalMs=${INTERVAL_MS} batch=${BATCH_SIZE}`)
}

export function stopBroadcastReconciler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** For tests and manual invocation via `npx tsx`. */
export async function runOnce(): Promise<void> {
  await runCycle()
}

/**
 * Phase written to the database for a classification.
 *
 * Exported so tests can assert the mapping without importing the DB layer.
 */
export function phaseForDatabase(phase: ArcPhase): ArcPhase {
  return arcBroadcastPhaseForDb(phase)
}
