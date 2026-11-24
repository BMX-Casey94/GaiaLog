/**
 * Raw-transaction broadcast used by the split / consolidate / sweep tooling and
 * the UTXO maintainer.
 *
 * Two entry points, deliberately different:
 *
 *   - `broadcastSplitTransactionRaw(rawHex, efBytes?)` — callers that have a
 *     built transaction. When EF bytes are supplied, and the Broadcaster is
 *     enabled, this submits through `broadcaster-client.ts` first. That path
 *     gets synchronous policy and script validation, an instance that tracks
 *     the transaction's lifecycle, and a merkle proof when it is mined.
 *   - the legacy ARC chain (TAAL → GorillaPool → WoC) remains, as the sole path
 *     when a caller can supply nothing but raw hex, and as the fallback when the
 *     Broadcaster could not be reached at all.
 *
 * ## The timeout that used to be missing
 *
 * Every legacy request now carries an `AbortController` bounded by
 * `BSV_BROADCAST_TIMEOUT_MS`. Without it a stalled TCP connection with no
 * response held the caller open indefinitely: in the maintainer that blocks the
 * whole UTXO cycle, and in the split scripts it blocks the process. A timeout
 * becomes a normal per-provider error so the next provider is tried.
 *
 * ## Why the legacy chain lives here and not inside the Broadcaster client
 *
 * `submitTransaction` can fall back to relays itself, but a submission that
 * both fell back internally *and* fell back here would walk TAAL → GorillaPool
 * → WoC twice: six requests and two full timeout budgets for one transaction.
 * This module therefore calls `submitTransaction` with relay fallback disabled
 * and owns the single legacy attempt.
 */

import { upsertArcBroadcastStatus } from './arc-broadcast-status'
import {
  getBroadcasterCallbackToken,
  isBroadcasterEnabled,
  recordBroadcasterAcceptance,
  submitTransaction,
} from './broadcast/broadcaster-client'

const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY || ''
const GORILLAPOOL_ARC_ENDPOINT = (
  process.env.BSV_GORILLAPOOL_ARC_ENDPOINT || 'https://arc.gorillapool.io'
).replace(/\/+$/, '')
const TAAL_ARC_ENDPOINT = (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/+$/, '')
const ARC_KEY = process.env.BSV_ARC_API_KEY || ''

/** Bound on a single legacy broadcast request. */
const BROADCAST_TIMEOUT_MS = Math.max(
  3_000,
  Number(process.env.BSV_BROADCAST_TIMEOUT_MS || 15_000),
)

const ARC_OK_STATUSES = new Set([
  'SEEN_ON_NETWORK',
  'MINED',
  'ACCEPTED',
  'STORED',
  'RECEIVED',
  'ANNOUNCED_TO_NETWORK',
  'SEEN_IN_ORPHAN_MEMPOOL',
])

const ARC_REJECT_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'EVICTED',
])

function parseArcResponse(
  responseText: string,
  providerLabel: string,
): { txid: string; txStatus: string } | null {
  try {
    const parsed = JSON.parse(responseText || '{}')
    const txid = typeof parsed.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(parsed.txid)
      ? parsed.txid.toLowerCase()
      : null
    const status = typeof parsed.txStatus === 'string' ? parsed.txStatus : ''

    if (txid && ARC_REJECT_STATUSES.has(status)) {
      const extra = parsed.extraInfo ? ` (${String(parsed.extraInfo).substring(0, 80)})` : ''
      console.warn(`⚠️  ARC (${providerLabel}): TX rejected — txStatus=${status}${extra}`)
      return null
    }
    if (txid && (ARC_OK_STATUSES.has(status) || !status)) return { txid, txStatus: status }
    if (txid) {
      console.warn(`⚠️  ARC (${providerLabel}): Unknown txStatus="${status}" — accepting cautiously`)
      return { txid, txStatus: status }
    }
  } catch {
    // Some gateways answer with a bare txid.
  }
  const plain = (responseText || '').replace(/"/g, '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(plain)) return { txid: plain.toLowerCase(), txStatus: '' }
  return null
}

/** POST one ARC-compatible endpoint. Returns a txid, or an error string. */
async function postArcCompatible(input: {
  endpoint: string
  apiKey: string
  provider: string
  rawHex: string
}): Promise<{ txid: string; txStatus: string } | { error: string; transient: boolean }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BROADCAST_TIMEOUT_MS)
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

    if (response.ok) {
      const parsed = parseArcResponse(text, input.provider)
      if (parsed) return parsed
      return { error: `${input.provider}: rejected — ${text.substring(0, 200)}`, transient: false }
    }

    // 503/429 mean the provider is temporarily unable to answer; 5xx likewise.
    const transient = response.status === 503 || response.status === 429 || response.status >= 500
    return { error: `${input.provider} ${response.status}: ${text.substring(0, 200)}`, transient }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = /abort/i.test(message)
    return {
      error: `${input.provider} ${
        aborted ? `timed out after ${BROADCAST_TIMEOUT_MS}ms` : `error: ${message}`
      }`,
      transient: true,
    }
  } finally {
    clearTimeout(timeout)
  }
}

/** POST WhatsOnChain. Returns a txid, or an error string. */
async function postWhatsOnChain(rawHex: string): Promise<{ txid: string } | { error: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BROADCAST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (WHATSONCHAIN_API_KEY) headers['woc-api-key'] = WHATSONCHAIN_API_KEY
    const response = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
      method: 'POST',
      headers,
      body: JSON.stringify({ txhex: rawHex }),
      signal: controller.signal,
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      return { error: `WoC broadcast ${response.status}: ${text.substring(0, 200)}` }
    }
    const txid = text.replace(/"/g, '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      return { error: `WoC returned unexpected body: ${text.substring(0, 200)}` }
    }
    return { txid }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = /abort/i.test(message)
    return {
      error: `WoC broadcast ${aborted ? `timed out after ${BROADCAST_TIMEOUT_MS}ms` : `error: ${message}`}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function recordLegacyAcceptance(
  txid: string,
  txStatus: string,
  acceptedVia: string,
  endpoint: string | null,
): Promise<void> {
  try {
    await upsertArcBroadcastStatus({
      txid,
      txStatus,
      acceptedVia,
      provider: 'arc',
      acceptedEndpoint: endpoint,
    })
  } catch {
    // Persisting the status is best-effort; the broadcast already happened.
  }
}

/**
 * The legacy chain, in the order that reflects observed behaviour.
 *
 * TAAL first: GorillaPool's outbound peer relay has been seen to accept a
 * transaction into its own mempool and never propagate it past
 * ANNOUNCED_TO_NETWORK, so a GorillaPool-only acceptance is weaker evidence.
 * GorillaPool stays as the no-API-key path, and WoC last because a relay does
 * not track lifecycle at all.
 */
async function broadcastLegacy(rawHex: string): Promise<string> {
  const errors: string[] = []

  const taal = await postArcCompatible({
    endpoint: TAAL_ARC_ENDPOINT,
    apiKey: ARC_KEY,
    provider: 'TAAL',
    rawHex,
  })
  if ('txid' in taal) {
    await recordLegacyAcceptance(taal.txid, taal.txStatus, 'taal_arc', TAAL_ARC_ENDPOINT)
    return taal.txid
  }
  errors.push(taal.error)

  const gorilla = await postArcCompatible({
    endpoint: GORILLAPOOL_ARC_ENDPOINT,
    apiKey: process.env.BSV_GORILLAPOOL_API_KEY || '',
    provider: 'GorillaPool',
    rawHex,
  })
  if ('txid' in gorilla) {
    await recordLegacyAcceptance(
      gorilla.txid,
      gorilla.txStatus,
      'gorillapool_arc',
      GORILLAPOOL_ARC_ENDPOINT,
    )
    return gorilla.txid
  }
  errors.push(gorilla.error)

  const woc = await postWhatsOnChain(rawHex)
  if ('txid' in woc) {
    // WoC only answers 200 after its node accepted the transaction, which is
    // the same assurance ARC's SEEN_ON_NETWORK carries. Recording an empty
    // status would classify as `pending` and leave the change unspendable.
    await recordLegacyAcceptance(woc.txid, 'SEEN_ON_NETWORK', 'whatsonchain', null)
    return woc.txid
  }
  errors.push(woc.error)

  const allErrors = errors.join('\n')
  if (allErrors.includes('too-long-mempool-chain')) {
    // A named condition the caller retries differently from a generic failure.
    throw new Error('MEMPOOL_CHAIN_LIMIT')
  }
  throw new Error(`All split broadcast methods failed:\n${allErrors}`)
}

/**
 * Broadcast a signed transaction.
 *
 * When `efBytes` is supplied and the Broadcaster is enabled, the Broadcaster is
 * tried first. It is the only path that returns a lifecycle to follow, so a
 * silent fallback to a relay would lose that. The fallback happens only for a
 * transport failure — never after a terminal rejection, because a transaction
 * the Broadcaster called invalid is invalid everywhere.
 */
export async function broadcastSplitTransactionRaw(
  rawHex: string,
  efBytes?: Uint8Array,
): Promise<string> {
  const hex = String(rawHex ?? '').trim()
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('broadcastSplitTransactionRaw requires an even-length hex transaction')
  }

  if (efBytes && efBytes.length > 0 && isBroadcasterEnabled()) {
    const outcome = await submitTransaction({
      efBytes,
      rawHex: hex,
      callbackToken: getBroadcasterCallbackToken(),
      // The legacy ladder is walked once, below, so it is not walked here too.
      allowLegacyFallback: false,
    })

    if (outcome.kind === 'accepted') {
      await recordBroadcasterAcceptance(outcome)
      return outcome.txid
    }

    // These are answers about the transaction, not failures to reach the
    // network. Surface them so the caller's existing retry and release logic
    // sees a decisive result instead of another broadcast attempt.
    if (outcome.kind === 'terminal') {
      if (outcome.doubleSpend) {
        throw new Error(`DOUBLE_SPEND_ATTEMPTED: ${outcome.message}`)
      }
      throw new Error(
        `Broadcaster rejected the transaction${
          outcome.code != null ? ` (${outcome.code})` : ''
        }: ${outcome.message}`,
      )
    }
    if (outcome.kind === 'non-final') {
      throw new Error(
        `Broadcaster rejected the transaction (476 non-final locktime): ${outcome.message}`,
      )
    }
    if (outcome.kind === 'fee-too-low') {
      throw new Error(`Broadcaster rejected the transaction (465 fee too low): ${outcome.message}`)
    }
    if (outcome.kind === 'pending-retry') {
      // Nothing was learned about the transaction, but the Broadcaster asked
      // for a delay. A relay would accept these bytes into a weaker lifecycle
      // and hide the backpressure, so the caller is asked to retry instead.
      throw new Error(
        `BROADCASTER_BACKPRESSURE: ${outcome.reason} (retry in ${Math.round(
          outcome.retryAfterMs / 1000,
        )}s)`,
      )
    }

    console.warn(
      `⚠️  Broadcaster unreachable for a ${hex.length / 2}-byte transaction; falling back to ` +
        `the legacy ARC chain. ${outcome.reason.substring(0, 240)}`,
    )
  }

  return broadcastLegacy(hex)
}
