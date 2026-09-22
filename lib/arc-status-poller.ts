/**
 * ARC broadcast status poller
 *
 * Advances `arc_broadcast_status.phase` for open rows accepted via TAAL or
 * GorillaPool ARC by GETting `/v1/tx/{txid}`. Applies inventory / explorer
 * follow-ups from `arcFollowUp` without deleting explorer rows.
 *
 * Opt out: BSV_ARC_STATUS_POLL_DISABLED=true
 * Interval: BSV_ARC_STATUS_POLL_INTERVAL_MS (default 15000, min 5000)
 * Batch: BSV_ARC_STATUS_POLL_BATCH (default 20, min 1)
 */

import { upsertArcBroadcastStatus } from './arc-broadcast-status'
import {
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
  await unlockChangeOutputs(txid)
  await query(
    `UPDATE overlay_admitted_utxos
        SET confirmed = true
      WHERE txid = $1
        AND removed = false
        AND confirmed = false`,
    [txid],
  )
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
  const spentLater = await query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM overlay_admitted_utxos
      WHERE txid = $1
        AND removed = true
      LIMIT 1`,
    [txid],
  )
  if ((spentLater.rows || []).length > 0) {
    console.warn(
      `[arc-status-poller] release skipped for ${txid.substring(0, 12)}…: change already spent by a later tx`,
    )
    return
  }

  await withOverlayTransaction(async (client) => {
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
    if (res.status !== 200) return { kind: 'transport' }

    const body = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') return { kind: 'transport' }

    const txStatus =
      typeof (body as { txStatus?: unknown }).txStatus === 'string'
        ? (body as { txStatus: string }).txStatus
        : null
    if (txStatus == null) return { kind: 'transport' }

    const rawHeight = (body as { blockHeight?: unknown }).blockHeight
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
      `SELECT txid, phase, accepted_via
         FROM arc_broadcast_status
        WHERE phase IN ('orphan', 'pending', 'seen')
          AND accepted_via IN ('taal_arc', 'gorillapool_arc')
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

      const next = classifyArcTxStatus(result.txStatus)
      try {
        if (!shouldPersistArcPhase(row.phase, next)) {
          await bumpUpdatedAt(row.txid)
          continue
        }

        await upsertArcBroadcastStatus({
          txid: row.txid,
          txStatus: result.txStatus,
          acceptedVia: row.accepted_via,
        })
        await applyFollowUp(arcFollowUp(next), row.txid, result.blockHeight)
      } catch (err) {
        console.warn(
          `[arc-status-poller] apply(${row.txid.substring(0, 12)}… → ${next}) failed: ${
            err instanceof Error ? err.message : err
          }`,
        )
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
