/**
 * BSV Broadcaster event stream (SSE) subscriber.
 *
 * ## Protocol
 *
 * `GET {host}/events?callbackToken={token}` streams `text/event-stream` frames:
 *
 * ```
 * id: 42
 * event: status
 * data: {"txid":"…","txStatus":"MINED","blockHash":"…","merklePath":"…"}
 *
 * ```
 *
 * A `: keepalive` comment arrives every 15 seconds. `Last-Event-ID` resumes from
 * the last frame consumed, which is why the id is persisted per transaction:
 * a worker restart must not lose the MINED that arrived while it was down.
 *
 * ## Why this is not the only path
 *
 * The stream is an optimisation, not a guarantee. Hosts restart, tokens expire,
 * the connection drops, and a public host may simply not expose `/events` on the
 * same ingress as `/tx`. `lib/broadcast/reconcile-poll.ts` is the authoritative
 * backstop: it polls by txid and is instance-pinned, so a missed event delays a
 * confirmation but never loses one.
 *
 * ## Ordering hazard
 *
 * SSE delivers statuses in order, but the writes it triggers are not atomic with
 * each other. A reorg can deliver `MINED` for a new block while the database
 * still holds the old proof. The transition guards in `upsertArcBroadcastStatus`
 * and `shouldPersistArcPhase` handle ordering; what this module must get right
 * is *not* destroying the old proof (it goes to `orphaned_proofs`) and not
 * marking a changed proof as already verified.
 */

import { classifyArcTxStatus, arcFollowUp, phaseIsConfirmed, shouldPersistArcPhase, type ArcPhase } from '../arc-tx-status'
import { query } from '../db'
import { confirmReading } from '../overlay-explorer-repository'
import { withOverlayTransaction } from '../overlay-repository'
import {
  describeError,
  recordLastEventId,
  upsertArcBroadcastStatus,
} from '../arc-broadcast-status'
import { getBroadcasterHosts, getBroadcasterCallbackToken, isBroadcasterEnabled } from './broadcaster-client'
import { verifyMerkleProof } from '../spv/verify-merkle'

interface StatusEvent {
  txid: string
  txStatus: string
  blockHash: string | null
  blockHeight: number | null
  merklePath: string | null
  competingTxs: unknown
  raw: Record<string, unknown>
}

const ENABLED = !envBool('BSV_BROADCASTER_SSE_DISABLED', false)
const RECONNECT_BASE_MS = Math.max(500, Number(process.env.BSV_BROADCASTER_SSE_RECONNECT_BASE_MS || 2_000))
const RECONNECT_MAX_MS = Math.max(5_000, Number(process.env.BSV_BROADCASTER_SSE_RECONNECT_MAX_MS || 60_000))
/** A stream that survives this long is considered healthy, so backoff resets. */
const HEALTHY_STREAM_MS = Math.max(5_000, Number(process.env.BSV_BROADCASTER_SSE_HEALTHY_MS || 60_000))
/** No bytes at all for this long means the connection is dead even if TCP lives. */
const IDLE_TIMEOUT_MS = Math.max(30_000, Number(process.env.BSV_BROADCASTER_SSE_IDLE_TIMEOUT_MS || 45_000))
/**
 * How long to wait for response headers.
 *
 * Verified against the live public hosts: `GET /events` with an unknown token
 * accepts the TCP connection and then sends nothing at all — no status line, no
 * headers — for as long as the client waits. Without this bound the subscriber
 * would sit on that socket indefinitely, and `IDLE_TIMEOUT_MS` could not help
 * because it only starts once headers exist. Bounding the header wait is what
 * turns that into a retryable "this host does not serve the stream" instead of
 * a silent permanent stall.
 */
const HEADER_TIMEOUT_MS = Math.max(3_000, Number(process.env.BSV_BROADCASTER_SSE_HEADER_TIMEOUT_MS || 12_000))
const MAX_FRAME_BYTES = Math.max(1_048_576, Number(process.env.BSV_BROADCASTER_SSE_MAX_FRAME_BYTES || 8_388_608))

let abortController: AbortController | null = null
let running = false
let stopped = false
let reconnectAttempt = 0
let lastEventId: string | null = null
let disabledLogged = false
/** The host that last served the stream, tried first on reconnect. */
let preferredHost: string | null = null

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
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === '42703'
  )
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === '42P01'
  )
}

/** True for the two "schema has not caught up" errors this module tolerates. */
function isPreMigrationError(error: unknown): boolean {
  return isUndefinedColumn(error) || isUndefinedTable(error)
}

function logOnceMissingSchema(operation: string, error: unknown): void {
  if (disabledLogged) return
  disabledLogged = true
  console.warn(
    `[broadcaster-sse] ${operation} skipped: arc_broadcast_status is missing a column this build ` +
      `expects (${describeError(error)}). Run ` +
      `db/migrations/0035_broadcaster_spv_and_dust_role.sql; the reconciler keeps working meanwhile.`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exponential backoff with jitter, so a fleet of workers cannot sync up. */
function nextBackoffMs(): number {
  const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt)
  const jitter = exponential * 0.25 * (Math.random() * 2 - 1)
  return Math.max(500, Math.round(exponential + jitter))
}

function coerceBlockHeight(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

/** Pull a status event out of a `data:` payload, accepting the shapes in use. */
function parseStatusEvent(payload: string): StatusEvent | null {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    return null
  }
  if (body == null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>

  // Some releases wrap the status under `data` or `tx`.
  const inner = (() => {
    for (const key of ['data', 'tx', 'transaction'] as const) {
      const candidate = record[key]
      if (candidate && typeof candidate === 'object') return candidate as Record<string, unknown>
    }
    return record
  })()

  const rawTxid = inner.txid ?? record.txid
  if (typeof rawTxid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(rawTxid)) return null
  const rawStatus = inner.txStatus ?? inner.status ?? record.txStatus
  if (typeof rawStatus !== 'string' || rawStatus.trim() === '') return null

  const rawHash = inner.blockHash ?? record.blockHash
  const blockHash = typeof rawHash === 'string' && /^[0-9a-fA-F]{64}$/.test(rawHash)
    ? rawHash.toLowerCase()
    : null
  const blockHeight = coerceBlockHeight(inner.blockHeight ?? inner.blockheight ?? record.blockHeight)
  const rawPath = inner.merklePath ?? inner.merkle_path ?? record.merklePath
  const merklePath = typeof rawPath === 'string' && rawPath.trim() !== '' ? rawPath.trim() : null
  const competingTxs = inner.competingTxs ?? record.competingTxs ?? null

  return {
    txid: rawTxid.toLowerCase(),
    txStatus: rawStatus.trim(),
    blockHash,
    blockHeight,
    merklePath,
    competingTxs,
    raw: inner,
  }
}

/** The phase already recorded for a txid, so transitions can be guarded. */
async function currentPhase(txid: string): Promise<ArcPhase | null> {
  try {
    const result = await query<{ phase: ArcPhase }>(
      `SELECT phase FROM arc_broadcast_status WHERE txid = $1 LIMIT 1`,
      [txid],
    )
    return result.rows[0]?.phase ?? null
  } catch (error) {
    if (isPreMigrationError(error)) return null
    return null
  }
}

/**
 * Make the change outputs of `txid` spendable and mark the reading confirmed.
 *
 * One statement inside one transaction: `confirmed` and an acquirable
 * `acquirable_at` must land together. Two separate updates would let a crash
 * between them leave confirmed=true with acquirable_at='infinity', which is an
 * inventory row counted as confirmed but never acquirable.
 */
async function applyConfirmation(txid: string, blockHeight: number | null): Promise<void> {
  try {
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
  } catch (error) {
    if (!isPreMigrationError(error)) {
      console.warn(
        `[broadcaster-sse] inventory confirm for ${txid.substring(0, 12)}… failed: ${
          describeError(error)
        }`,
      )
    }
  }

  if (blockHeight != null && blockHeight > 0) {
    try {
      await confirmReading(txid, blockHeight, null)
    } catch {
      // Explorer store is secondary; the inventory row is what spends.
    }
  }

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
    // tx_log may be unavailable; the follow-ups above already applied.
  }
}

/** Make change spendable without claiming a block. */
async function applySeen(txid: string): Promise<void> {
  try {
    await query(
      `UPDATE overlay_admitted_utxos
          SET acquirable_at = now()
        WHERE txid = $1
          AND removed = false
          AND acquirable_at > now()`,
      [txid],
    )
  } catch (error) {
    if (!isPreMigrationError(error)) {
      console.warn(
        `[broadcaster-sse] change unlock for ${txid.substring(0, 12)}… failed: ${
          describeError(error)
        }`,
      )
    }
  }
}

/**
 * Release the inputs a rejected transaction consumed.
 *
 * Locking the tx's own outputs and the rows that spent them before deciding is
 * what makes this safe: a spend that lands between the check and the update
 * would otherwise be clobbered, releasing coins that are already gone.
 */
async function applyRelease(txid: string): Promise<void> {
  try {
    const skipped = await withOverlayTransaction(async (client) => {
      await client.query(`SET LOCAL statement_timeout = 15000`)
      const outputs = await client.query<{ removed: boolean }>(
        `SELECT removed
           FROM overlay_admitted_utxos
          WHERE txid = $1
          FOR UPDATE`,
        [txid],
      )
      if ((outputs.rows ?? []).some((row) => row.removed === true)) {
        return true
      }

      await client.query(
        `SELECT 1
           FROM overlay_admitted_utxos
          WHERE spending_txid = $1
            AND removed = true
          FOR UPDATE`,
        [txid],
      )

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
        `[broadcaster-sse] release skipped for ${txid.substring(0, 12)}…: change already spent by a later tx`,
      )
      return
    }
  } catch (error) {
    if (!isPreMigrationError(error)) {
      console.warn(
        `[broadcaster-sse] release for ${txid.substring(0, 12)}… failed: ${
          describeError(error)
        }`,
      )
    }
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

/** Mark a transaction mined in a stale block as unconfirmed again. */
async function applyReorg(txid: string): Promise<void> {
  try {
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
  } catch (error) {
    if (!isPreMigrationError(error)) {
      console.warn(
        `[broadcaster-sse] reorg for ${txid.substring(0, 12)}… failed: ${
          describeError(error)
        }`,
      )
    }
  }
}

/**
 * Verify the proof that came with a MINED event, off the critical path.
 *
 * Deliberately not awaited by the event handler: the stream must keep draining
 * while a header fetch is in flight, and a slow or failing Chaintracks must not
 * stall status handling. The reconciler sweeps anything this leaves behind.
 */
function scheduleSpvVerification(event: StatusEvent): void {
  if (!event.merklePath) return
  void (async () => {
    try {
      const result = await verifyMerkleProof({
        txid: event.txid,
        merklePathHex: event.merklePath!,
        claimedBlockHeight: event.blockHeight,
        claimedBlockHash: event.blockHash,
      })
      await upsertArcBroadcastStatus({
        txid: event.txid,
        txStatus: event.txStatus,
        acceptedVia: null,
        provider: 'broadcaster',
        merklePath: event.merklePath,
        merkleRoot: result.merkleRoot ?? null,
        blockHash: result.blockHash ?? event.blockHash,
        blockHeight: result.blockHeight ?? event.blockHeight,
        rootMatchesHeader: result.rootMatchesHeader,
        spvVerified: result.spvVerified,
      })
      if (!result.spvVerified && result.reason) {
        console.warn(
          `[broadcaster-sse] ${event.txid.substring(0, 12)}… not SPV-verified: ${result.reason}`,
        )
      }
    } catch (error) {
      console.warn(
        `[broadcaster-sse] SPV verification for ${event.txid.substring(0, 12)}… failed: ${
          describeError(error)
        }`,
      )
    }
  })()
}

/** Apply one status event: persist the phase, then its inventory follow-up. */
async function handleStatusEvent(event: StatusEvent): Promise<void> {
  // The Broadcast is terminal for DOUBLE_SPEND_ATTEMPTED, unlike ARC's status
  // endpoint, so the provider argument is `broadcaster`.
  const next = classifyArcTxStatus(event.txStatus, 'broadcaster')
  const previous = await currentPhase(event.txid)

  if (previous != null && !shouldPersistArcPhase(previous, next)) {
    // A lagging event must not undo a confirmation. Record the event id so the
    // stream does not replay it, but do not touch the phase.
    return
  }

  const followUp = arcFollowUp(next)
  try {
    switch (followUp) {
      case 'unlock-change':
        await applySeen(event.txid)
        break
      case 'confirm':
        await applyConfirmation(event.txid, event.blockHeight)
        break
      case 'reorg':
        await applyReorg(event.txid)
        break
      case 'release':
        await applyRelease(event.txid)
        break
      case 'hold':
        break
    }
  } catch (error) {
    console.warn(
      `[broadcaster-sse] follow-up (${followUp}) for ${event.txid.substring(0, 12)}… failed (leaving phase unchanged for reconciler retry): ${
        describeError(error)
      }`,
    )
    return
  }

  await upsertArcBroadcastStatus({
    txid: event.txid,
    txStatus: event.txStatus,
    // Kept from the row: a status event carries no acceptance provenance, and
    // COALESCE in the upsert preserves whatever was recorded at submit time.
    acceptedVia: null,
    provider: 'broadcaster',
    merklePath: event.merklePath,
    blockHash: event.blockHash,
    blockHeight: event.blockHeight,
    competingTxs: event.competingTxs,
    // Only a proof accompanied by a verified header may set these; that happens
    // in `scheduleSpvVerification`, which runs after this write.
    spvVerified: false,
    rootMatchesHeader: false,
  })

  if (phaseIsConfirmed(next) && event.merklePath) {
    scheduleSpvVerification(event)
  }
}

/**
 * Parse and dispatch SSE frames from a byte stream.
 *
 * Frames are separated by a blank line; `\r\n` and `\n` both occur. A frame
 * larger than `MAX_FRAME_BYTES` is discarded rather than buffered, so a hostile
 * or broken peer cannot grow this process's heap.
 */
async function consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let idleTimer: NodeJS.Timeout | null = null

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      // A live stream emits keepalives; silence past the idle window means the
      // connection is dead even though TCP has not noticed yet.
      abortController?.abort()
    }, IDLE_TIMEOUT_MS)
  }
  resetIdle()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()
      buffer += decoder.decode(value, { stream: true })

      if (buffer.length > MAX_FRAME_BYTES) {
        console.warn(
          `[broadcaster-sse] discarding ${buffer.length}-byte frame buffer: no frame delimiter within ${MAX_FRAME_BYTES} bytes`,
        )
        buffer = ''
        continue
      }

      // Split on blank lines. The trailing partial frame stays in the buffer.
      let separator = findFrameBoundary(buffer)
      while (separator !== -1) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator.length)
        await dispatchFrame(frame)
        separator = findFrameBoundary(buffer)
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    try {
      await reader.cancel()
    } catch {
      // The stream is already gone.
    }
  }
}

function findFrameBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return -1
  if (lf === -1) return { index: crlf, length: 4 }
  if (crlf === -1) return { index: lf, length: 2 }
  return lf <= crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 }
}

/** Interpret one SSE frame. Comments (`: keepalive`) carry no work. */
async function dispatchFrame(frame: string): Promise<void> {
  if (frame.trim() === '') return

  let eventId: string | null = null
  let eventName = 'message'
  const dataLines: string[] = []

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine
    if (line === '' || line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // A single space after the colon is stripped per the SSE grammar.
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'id') eventId = value
    else if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
    // `retry:` is a reconnect hint we deliberately ignore: the backoff here is
    // bounded and jittered, and adopting a peer's value would let a host drive
    // this process's retry rate.
  }

  if (eventId) lastEventId = eventId

  if (dataLines.length === 0) {
    if (eventId) await persistEventCursor(eventId, null)
    return
  }

  if (eventName !== 'status' && eventName !== 'message' && eventName !== '') {
    // Unknown event kinds are skipped, but the cursor still advances so a
    // reconnect does not replay them.
    if (eventId) await persistEventCursor(eventId, null)
    return
  }

  const event = parseStatusEvent(dataLines.join('\n'))
  if (!event) {
    if (eventId) await persistEventCursor(eventId, null)
    return
  }

  try {
    await handleStatusEvent(event)
  } catch (error) {
    console.warn(
      `[broadcaster-sse] handling ${event.txStatus} for ${event.txid.substring(0, 12)}… failed: ${
        describeError(error)
      }`,
    )
  }

  if (eventId) await persistEventCursor(eventId, event.txid)
}

/**
 * Persist the stream cursor.
 *
 * Written per transaction when one is known, so a restart can resume the stream
 * for every in-flight submission. Without a txid the id is only kept in memory:
 * writing it to an arbitrary row would corrupt that row's own progress.
 */
async function persistEventCursor(eventId: string, txid: string | null): Promise<void> {
  if (!txid) return
  await recordLastEventId(txid, eventId)
}

/**
 * Resume point for a reconnect.
 *
 * `Last-Event-ID` is per-token, not per-transaction, so the highest id recorded
 * across open rows is the right place to resume from: everything below it has
 * been consumed by at least one handler, and the reconciler covers anything the
 * stream skipped.
 */
export async function getStreamResumeEventId(): Promise<string | null> {
  if (lastEventId) return lastEventId
  try {
    const result = await query<{ last_event_id: string }>(
      `SELECT last_event_id
         FROM arc_broadcast_status
        WHERE provider = 'broadcaster'
          AND last_event_id IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    const id = result.rows[0]?.last_event_id
    return typeof id === 'string' && id !== '' ? id : null
  } catch (error) {
    if (isPreMigrationError(error)) return null
    return null
  }
}

async function connectOnce(): Promise<'closed' | 'disabled' | 'unauthorised'> {
  if (!isBroadcasterEnabled()) return 'disabled'
  const token = getBroadcasterCallbackToken()
  if (!token) {
    if (!disabledLogged) {
      disabledLogged = true
      console.warn(
        '[broadcaster-sse] no callback token available (set BSV_BROADCASTER_CALLBACK_TOKEN or a wallet key); ' +
          'the reconciler remains the only status path',
      )
    }
    return 'disabled'
  }

  const hosts = getBroadcasterHosts()
  const resumeId = await getStreamResumeEventId()

  // Prefer the host that last served the stream. Walking the ladder from the
  // top on every reconnect means a host that accepts TCP but never sends
  // headers costs `HEADER_TIMEOUT_MS` on each attempt, before the host that
  // works is even tried.
  const orderedHosts = preferredHost
    ? [preferredHost, ...hosts.filter((host) => host !== preferredHost)]
    : hosts

  for (const host of orderedHosts) {
    abortController = new AbortController()
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    if (resumeId) headers['Last-Event-ID'] = resumeId

    let response: Response
    // Bounds the wait for headers only. Cleared the moment headers arrive so the
    // long-lived body is not governed by it.
    const headerTimer = setTimeout(() => {
      abortController?.abort()
    }, HEADER_TIMEOUT_MS)

    try {
      response = await fetch(`${host}/events?callbackToken=${encodeURIComponent(token)}`, {
        headers,
        signal: abortController.signal,
      })
    } catch (error) {
      clearTimeout(headerTimer)
      if (stopped) return 'closed'
      const message = describeError(error)
      // An abort here is the header timeout expiring: the host accepted the
      // connection and never answered. That is a real state on the public
      // hosts, not a network fault worth shouting about.
      if (/abort/i.test(message)) {
        console.warn(
          `[broadcaster-sse] ${host}/events sent no response headers within ` +
            `${Math.round(HEADER_TIMEOUT_MS / 1000)}s; treating this host as not serving the stream`,
        )
      } else {
        console.warn(`[broadcaster-sse] ${host} unreachable: ${message}`)
      }
      continue
    }
    clearTimeout(headerTimer)

    if (response.status === 401 || response.status === 403) {
      console.warn(
        `[broadcaster-sse] ${host} refused the callback token (HTTP ${response.status}); ` +
          `check BSV_BROADCASTER_CALLBACK_TOKEN matches the token used at submit time`,
      )
      continue
    }
    if (!response.ok) {
      console.warn(`[broadcaster-sse] ${host}/events returned HTTP ${response.status}`)
      continue
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      // A host that answers JSON on this path does not serve the stream. Not an
      // error worth retrying in a tight loop.
      console.warn(
        `[broadcaster-sse] ${host}/events answered "${contentType || 'no content-type'}"; ` +
          `this host does not expose an SSE stream`,
      )
      continue
    }

    if (!response.body) {
      console.warn(`[broadcaster-sse] ${host}/events returned no body`)
      continue
    }

    const startedAt = Date.now()
    preferredHost = host
    console.log(`[broadcaster-sse] connected to ${host}/events${resumeId ? ` from id ${resumeId}` : ''}`)

    try {
      await consumeStream(response.body)
    } catch (error) {
      if (!stopped) {
        const message = describeError(error)
        // An abort from the idle timer is expected; a real error is not.
        if (!/aborted|abort/i.test(message)) {
          console.warn(`[broadcaster-sse] stream from ${host} ended: ${message}`)
        }
      }
    }

    if (stopped) return 'closed'
    if (Date.now() - startedAt >= HEALTHY_STREAM_MS) {
      // The stream worked for a while, so whatever ended it is not the host
      // being unsuitable: reconnect to the same host next time.
      reconnectAttempt = 0
    }
    return 'closed'
  }

  return 'closed'
}

async function runLoop(): Promise<void> {
  if (running) return
  running = true
  try {
    while (!stopped) {
      const result = await connectOnce()
      if (stopped) break

      // A stream that closes immediately is either a host problem or a token
      // problem; both want a delay before the next attempt. 'disabled' means
      // there is nothing to connect to at all, so it waits at the ceiling
      // rather than walking the host ladder in a tight loop.
      reconnectAttempt += 1
      const waitMs = result === 'disabled' ? RECONNECT_MAX_MS : nextBackoffMs()
      await sleep(waitMs)
    }
  } finally {
    running = false
  }
}

export function startSseSubscriber(): void {
  if (!ENABLED) {
    console.log('[broadcaster-sse] disabled via BSV_BROADCASTER_SSE_DISABLED')
    return
  }
  if (running) return
  stopped = false
  void runLoop()
  console.log('[broadcaster-sse] subscriber started')
}

export function stopSseSubscriber(): void {
  stopped = true
  try {
    abortController?.abort()
  } catch {
    // already gone
  }
  abortController = null
}

/** Test helper: process one frame as if the stream had delivered it. */
export async function handleSseFrameForTest(frame: string): Promise<void> {
  await dispatchFrame(frame)
}
