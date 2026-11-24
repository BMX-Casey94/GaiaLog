import { MerklePath, P2PKH, PrivateKey as SDKPrivateKey, Transaction } from '@bsv/sdk'
import { z } from 'zod'

import { bsvConfig } from './bsv-config'
import { buildTreasuryTopic } from './spend-source'
import { getOverlayServerConfig } from './overlay-config'
import {
  assertOverlaySchemaReady,
  countLookupOutputs,
  getExistingOutputsForTopicTxid,
  insertAdmittedOutput,
  listLookupOutputs,
  markCoinRemoved,
  refreshTopicCounts,
  type OverlayAdmittedUtxoRow,
  type OverlayLookupQuery,
  updateExistingOutputMetadata,
  upsertOverlaySubmission,
  withOverlayTransaction,
} from './overlay-repository'

type OverlayTopicSteak = {
  outputsToAdmit: Array<{
    txid: string
    vout: number
    outputScript: string
    satoshis: number
    rawTx: string
    beef: unknown | null
    confirmed: boolean
    admittedAt: string
  }>
  coinsRemoved: Array<{
    txid: string
    vout: number
    satoshis: number
    spendingTxid: string | null
    removedAt: string | null
  }>
  coinsToRetain: Array<{
    txid: string
    vout: number
    outputScript: string
    satoshis: number
    rawTx: string
    beef: unknown | null
    confirmed: boolean
    admittedAt: string
  }>
}

export interface OverlaySubmitResponse {
  ok: true
  steak: Record<string, OverlayTopicSteak>
  ack: { host: string; status: 'ack' }
  ackSummary: Record<string, 'ack'>
  allHostsAcknowledged: true
  accepted: true
}

export interface OverlayLookupResponse {
  ok: true
  provider: string
  outputs: Array<{
    txid: string
    vout: number
    outputScript: string
    satoshis: number
    rawTx: string
    beef: unknown | null
    confirmed: boolean
    admittedAt: string
  }>
  total: number
  count: number
  pagination: {
    limit: number
    offset: number
    returned: number
    total: number
    hasMore: boolean
  }
  meta: {
    topic: string
    order: 'asc' | 'desc'
    minSatoshis: number
    excludeReserved: boolean
    confirmedOnly: boolean
    countOnly: boolean
  }
}

type WalletBinding = {
  walletIndex: number
  topic: string
  address: string
  publicKeyHex: string
  p2pkhScriptHex: string
  p2pkScriptHex: string
}

const prevoutSchema = z.object({
  lockingScript: z.string().min(1),
  satoshis: z.number().int().nonnegative(),
}).passthrough()

const submitEnvelopeSchema = z.object({
  clientRequestId: z.string().min(1).optional(),
  txid: z.string().min(64).max(64).regex(/^[0-9a-fA-F]+$/).optional(),
  rawTx: z.string().min(2).optional(),
  topics: z.array(z.string().min(1)).min(1),
  prevouts: z.array(prevoutSchema).optional(),
  mapiResponses: z.unknown().optional(),
  beef: z.unknown().optional(),
  proof: z.unknown().optional(),
  merklePath: z.unknown().optional(),
  blockHeight: z.unknown().optional(),
  rawTxEnvelope: z.object({
    txid: z.string().optional(),
    rawTx: z.string().optional(),
    prevouts: z.unknown().optional(),
    mapiResponses: z.unknown().optional(),
    beef: z.unknown().optional(),
    proof: z.unknown().optional(),
    merklePath: z.unknown().optional(),
    blockHeight: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough()

const lookupSchema = z.object({
  provider: z.string().min(1),
  query: z.object({
    topic: z.string().min(1),
    limit: z.number().int().positive().max(10000).optional(),
    offset: z.number().int().nonnegative().optional(),
    order: z.enum(['asc', 'desc']).optional(),
    minSatoshis: z.number().int().nonnegative().optional(),
    excludeReserved: z.boolean().optional(),
    confirmedOnly: z.boolean().optional(),
  }),
  countOnly: z.boolean().optional(),
}).passthrough()

function lockingScriptToHex(script: any): string {
  if (!script) return ''
  if (typeof script === 'string') return script.toLowerCase()
  if (typeof script.toHex === 'function') return String(script.toHex()).toLowerCase()
  if (typeof script.toBinary === 'function') {
    return Buffer.from(script.toBinary()).toString('hex').toLowerCase()
  }
  return String(script).toLowerCase()
}

function toPublicOutput(row: OverlayAdmittedUtxoRow) {
  return {
    txid: row.txid,
    vout: row.vout,
    outputScript: row.output_script,
    satoshis: Number(row.satoshis),
    // rawTx may legitimately be null on spent rows (see migration 0020 — the
    // overlay listLookup path filters them out, but defensively normalise
    // here so downstream consumers always see a string field).
    rawTx: row.raw_tx ?? '',
    beef: row.beef ?? null,
    confirmed: row.confirmed,
    admittedAt: row.admitted_at,
  }
}

function toRemovedCoin(row: OverlayAdmittedUtxoRow) {
  return {
    txid: row.txid,
    vout: row.vout,
    satoshis: Number(row.satoshis),
    spendingTxid: row.spending_txid,
    removedAt: row.removed_at,
  }
}

function getWalletBindings(): WalletBinding[] {
  const keys = [
    process.env.BSV_WALLET_1_PRIVATE_KEY,
    process.env.BSV_WALLET_2_PRIVATE_KEY,
    process.env.BSV_WALLET_3_PRIVATE_KEY,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  const effectiveKeys = keys.length > 0 ? keys : (bsvConfig.wallets.privateKeys || []).filter(Boolean)
  if (effectiveKeys.length === 0) {
    throw new Error('No wallet private keys configured for overlay topic bindings')
  }

  const { topicPrefix, topicVersion } = getOverlayHttpConfigForTopics()

  return effectiveKeys.map((wif, walletIndex) => {
    const privateKey = SDKPrivateKey.fromWif(wif)
    const publicKey = privateKey.toPublicKey()
    const publicKeyHex = publicKey.toString()
    const address = publicKey.toAddress().toString()

    return {
      walletIndex,
      topic: buildTreasuryTopic(walletIndex, {
        topicPrefix,
        topicVersion,
      }),
      address,
      publicKeyHex,
      p2pkhScriptHex: new P2PKH().lock(publicKey.toHash()).toHex().toLowerCase(),
      p2pkScriptHex: `${publicKeyHex.length === 66 ? '21' : '41'}${publicKeyHex.toLowerCase()}ac`,
    }
  })
}

function getOverlayHttpConfigForTopics(): { topicPrefix?: string; topicVersion?: string } {
  return {
    topicPrefix: String(process.env.BSV_OVERLAY_TOPIC_PREFIX || 'TREASURY').trim() || 'TREASURY',
    topicVersion: String(process.env.BSV_OVERLAY_TOPIC_VERSION || 'v1').trim() || 'v1',
  }
}

function getBindingForTopic(topic: string): WalletBinding {
  const binding = getWalletBindings().find(candidate => candidate.topic === topic)
  if (!binding) {
    throw new Error(`Unsupported overlay topic "${topic}"`)
  }
  return binding
}

function getBindingScriptMap(): Map<string, WalletBinding> {
  const map = new Map<string, WalletBinding>()
  for (const binding of getWalletBindings()) {
    map.set(binding.p2pkhScriptHex, binding)
    map.set(binding.p2pkScriptHex, binding)
  }
  return map
}

/**
 * Upper bound on a merkle path hex string (~1 MB). A real BUMP for a very large
 * block is tens of KB; anything past this is a malformed or hostile payload and
 * must never reach the parser.
 */
const MAX_MERKLE_PATH_HEX_CHARS = 2_000_000

/**
 * Pull a candidate merkle path hex string out of the various shapes a caller
 * may send. Only an actual hex BUMP is ever returned — a BEEF payload is not
 * accepted here, because parsing one as a MerklePath would either throw (fine)
 * or, worse, produce a path whose root we would be asserting on no evidence.
 */
function extractMerklePathHex(value: unknown, depth = 0): string | null {
  if (value == null || depth > 3) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length < 2 || trimmed.length > MAX_MERKLE_PATH_HEX_CHARS) return null
    return /^[0-9a-fA-F]+$/.test(trimmed) ? trimmed : null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of ['merklePath', 'bump', 'merkle_path'] as const) {
    const nested = record[key]
    if (typeof nested === 'string') {
      const hex = extractMerklePathHex(nested, depth + 1)
      if (hex) return hex
    }
  }
  return null
}

function extractMerklePathFromResponses(responses: unknown): string | null {
  const candidates = Array.isArray(responses) ? responses : responses ? [responses] : []
  for (const entry of candidates) {
    const record = entry as { merklePath?: unknown; bump?: unknown; proof?: unknown } | null
    for (const key of ['merklePath', 'bump', 'proof'] as const) {
      const hex = extractMerklePathHex(record?.[key])
      if (hex) return hex
    }
  }
  return null
}

function extractBlockHeightFromResponses(responses: unknown): number | null {
  const candidates = Array.isArray(responses) ? responses : responses ? [responses] : []
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { blockHeight?: unknown; block_height?: unknown }
    const raw = record.blockHeight ?? record.block_height
    const height = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isInteger(height) && height > 0) return height
  }
  return null
}

function coerceBlockHeight(value: unknown): number | null {
  if (value == null) return null
  const height = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(height) && height > 0 ? height : null
}

/**
 * Decide whether a submission is already mined — cryptographically, or not at
 * all.
 *
 * Previously this returned true for ANY non-null `beef` or `proof`, and for any
 * MAPI entry claiming a `blockHash` or height. Both are unauthenticated: a
 * broadcaster (or anyone POSTing to the overlay endpoint) could mark an
 * unconfirmed — or entirely imaginary — output as confirmed, which then feeds
 * BSV_MIN_SPEND_CONFIRMATIONS and the explorer's confirmed-only view.
 *
 * The only accepted evidence is a BEEF-style merkle path (BUMP) that actually
 * commits to this txid at the stated block height. `computeRoot(txid)` throws
 * when the txid is not a leaf of the path, so a path belonging to a different
 * transaction cannot pass. When the caller states a height, the BUMP's own
 * `blockHeight` must agree.
 *
 * Note the limit of this check: it proves the proof commits to the txid at that
 * height. It does not prove that block is on the winning chain (that needs a
 * ChainTracker against block headers). Admission treats it as confirmed
 * because a broadcaster only produces a BUMP for a block it built or accepted;
 * the confirmation worker re-verifies against the chain later.
 */
function inferConfirmed(input: {
  txid: string | null
  merklePathHex: string | null
  blockHeight: number | null
  mapiResponses: unknown
  proofEnvelope?: unknown
}): boolean {
  const { txid, mapiResponses } = input
  if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) return false

  // A path supplied alongside the envelope, one carried by a MAPI response, or
  // one nested under `proof` (ARC's callback shape).
  const merklePathHex = input.merklePathHex
    || extractMerklePathFromResponses(mapiResponses)
    || extractMerklePathHex(input.proofEnvelope)
  if (!merklePathHex) return false

  const blockHeight = input.blockHeight ?? extractBlockHeightFromResponses(mapiResponses)

  try {
    const merklePath = MerklePath.fromHex(merklePathHex)
    if (!Number.isInteger(merklePath.blockHeight) || merklePath.blockHeight <= 0) return false
    // A caller-claimed height that disagrees with the proof is a contradiction,
    // not a confirmation.
    if (blockHeight != null && blockHeight !== merklePath.blockHeight) return false

    // Reject the single-leaf short circuit. MerklePath.computeRoot returns the
    // txid itself when the path is `[[{offset:0, hash:txid}]]` — the shape
    // MerklePath.fromCoinbaseTxidAndHeight produces for a one-transaction
    // block. That makes the "root" trivially equal to any txid the attacker
    // names, so it proves nothing and must never confirm an output. (A genuine
    // one-transaction block has the same problem for any proof-only scheme;
    // it is left to the confirmation worker, which checks the chain.)
    if (merklePath.path.length < 1 || (merklePath.path[0]?.length ?? 0) < 2) return false

    const root = merklePath.computeRoot(txid.toLowerCase())
    if (typeof root !== 'string' || !/^[0-9a-fA-F]{64}$/.test(root)) return false
    // Defence in depth: a root equal to the txid means the path collapsed to
    // the leaf, which is not evidence of inclusion in anything.
    return root.toLowerCase() !== txid.toLowerCase()
  } catch {
    // Unparseable path, illegal offsets, or the txid is not in the tree.
    return false
  }
}

function normaliseSubmitBody(input: unknown): {
  clientRequestId: string
  txid: string | null
  rawTx: string
  topics: string[]
  prevouts: unknown | null
  mapiResponses: unknown | null
  beef: unknown | null
  merklePathHex: string | null
  blockHeight: number | null
  proof: unknown
} {
  const parsed = submitEnvelopeSchema.parse(input)
  const rawTxEnvelope = parsed.rawTxEnvelope || {}
  const rawTx = String(parsed.rawTx || rawTxEnvelope.rawTx || '').trim()
  if (!rawTx) {
    throw new Error('rawTx is required')
  }

  const txid = String(parsed.txid || rawTxEnvelope.txid || '').trim() || null
  const proof = parsed.proof ?? rawTxEnvelope.proof ?? null
  const beef = parsed.beef ?? rawTxEnvelope.beef ?? proof ?? null
  const mapiResponses = parsed.mapiResponses ?? rawTxEnvelope.mapiResponses ?? null

  return {
    clientRequestId: String(parsed.clientRequestId || txid || '').trim() || txid || '',
    txid,
    rawTx,
    topics: Array.from(new Set(parsed.topics.map(topic => topic.trim()).filter(Boolean))),
    prevouts: parsed.prevouts ?? rawTxEnvelope.prevouts ?? null,
    mapiResponses,
    beef,
    merklePathHex: extractMerklePathHex(parsed.merklePath ?? rawTxEnvelope.merklePath),
    blockHeight: coerceBlockHeight(parsed.blockHeight ?? rawTxEnvelope.blockHeight),
    proof,
  }
}

function normaliseLookupBody(input: unknown): { provider: string; query: OverlayLookupQuery; countOnly: boolean } {
  const parsed = lookupSchema.parse(input)
  return {
    provider: parsed.provider,
    countOnly: parsed.countOnly === true,
    query: {
      topic: parsed.query.topic.trim(),
      limit: Math.max(1, Math.floor(parsed.query.limit ?? 200)),
      offset: Math.max(0, Math.floor(parsed.query.offset ?? 0)),
      order: parsed.query.order === 'desc' ? 'desc' : 'asc',
      minSatoshis: Math.max(0, Math.floor(parsed.query.minSatoshis ?? 0)),
      excludeReserved: parsed.query.excludeReserved === true,
      confirmedOnly: parsed.query.confirmedOnly === true,
    },
  }
}

export async function ensureOverlayServiceReady(): Promise<void> {
  await assertOverlaySchemaReady()
}

export async function submitOverlayTransaction(input: unknown): Promise<OverlaySubmitResponse> {
  const { hostId } = getOverlayServerConfig()
  const normalized = normaliseSubmitBody(input)
  const tx = Transaction.fromHex(normalized.rawTx)
  const computedTxid = String(tx.id('hex')).toLowerCase()

  if (normalized.txid && normalized.txid.toLowerCase() !== computedTxid) {
    throw new Error(`txid mismatch: expected ${normalized.txid.toLowerCase()} but parsed ${computedTxid}`)
  }

  // Verification runs against the txid derived from the raw transaction, not
  // the one the caller typed: the raw transaction is what actually gets
  // admitted, so the proof must commit to THAT hash.
  const confirmed = inferConfirmed({
    txid: computedTxid,
    merklePathHex: normalized.merklePathHex,
    blockHeight: normalized.blockHeight,
    mapiResponses: normalized.mapiResponses,
    proofEnvelope: normalized.proof,
  })

  const requestId = normalized.clientRequestId || computedTxid
  const bindingScriptMap = getBindingScriptMap()

  const topicSteak = await withOverlayTransaction(async (client) => {
    const steakByTopic: Record<string, OverlayTopicSteak> = {}

    for (const topic of normalized.topics) {
      getBindingForTopic(topic)

      const candidateOutputs = tx.outputs
        .map((output, vout) => ({
          txid: computedTxid,
          vout,
          satoshis: Number(output.satoshis || 0),
          outputScript: lockingScriptToHex(output.lockingScript),
        }))
        .filter(output => {
          const binding = bindingScriptMap.get(output.outputScript)
          return binding?.topic === topic
        })

      const existingRows = await getExistingOutputsForTopicTxid(
        client,
        topic,
        computedTxid,
        candidateOutputs.map(output => output.vout),
      )

      const outputsToAdmit: OverlayTopicSteak['outputsToAdmit'] = []
      const coinsToRetain: OverlayTopicSteak['coinsToRetain'] = []
      const coinsRemoved: OverlayTopicSteak['coinsRemoved'] = []

      for (const output of candidateOutputs) {
        const existing = existingRows.get(output.vout)
        if (existing) {
          await updateExistingOutputMetadata(
            client,
            topic,
            computedTxid,
            output.vout,
            normalized.rawTx,
            normalized.beef,
            confirmed,
          )
          coinsToRetain.push({
            txid: existing.txid,
            vout: existing.vout,
            outputScript: existing.output_script,
            satoshis: Number(existing.satoshis),
            rawTx: normalized.rawTx,
            beef: normalized.beef ?? existing.beef ?? null,
            confirmed: existing.confirmed || confirmed,
            admittedAt: existing.admitted_at,
          })
          continue
        }

        const inserted = await insertAdmittedOutput(client, {
          topic,
          txid: computedTxid,
          vout: output.vout,
          satoshis: output.satoshis,
          output_script: output.outputScript,
          raw_tx: normalized.rawTx,
          beef: normalized.beef,
          confirmed,
          wallet_index: getBindingForTopic(topic).walletIndex,
          utxo_role: 'pool',
        })
        outputsToAdmit.push(toPublicOutput(inserted))
      }

      for (const inputRow of tx.inputs) {
        const inputTxid = String(inputRow.sourceTXID || '').trim().toLowerCase()
        const inputVout = Number(inputRow.sourceOutputIndex)
        if (!inputTxid || !Number.isFinite(inputVout) || inputVout < 0) continue

        const removed = await markCoinRemoved(client, topic, inputTxid, inputVout, computedTxid)
        if (removed) {
          coinsRemoved.push(toRemovedCoin(removed))
        }
      }

      const steak = {
        outputsToAdmit,
        coinsRemoved,
        coinsToRetain,
      }

      await upsertOverlaySubmission(client, {
        txid: computedTxid,
        topic,
        clientRequestId: requestId,
        rawTx: normalized.rawTx,
        beef: normalized.beef,
        prevouts: normalized.prevouts,
        mapiResponses: normalized.mapiResponses,
        steak,
        ackSummary: { [hostId]: 'ack' },
        allHostsAcknowledged: true,
        accepted: true,
      })

      steakByTopic[topic] = steak
    }

    for (const [topic, steak] of Object.entries(steakByTopic)) {
      const admitted = steak.outputsToAdmit?.length || 0
      const removed = steak.coinsRemoved?.length || 0
      const delta = admitted - removed
      if (delta !== 0) {
        await refreshTopicCounts(client, topic, delta)
      }
    }

    return steakByTopic
  })

  return {
    ok: true,
    steak: topicSteak,
    ack: { host: hostId, status: 'ack' },
    ackSummary: { [hostId]: 'ack' },
    allHostsAcknowledged: true,
    accepted: true,
  }
}

export async function lookupOverlaySpendables(input: unknown): Promise<OverlayLookupResponse> {
  const normalized = normaliseLookupBody(input)
  const providerId = String(process.env.BSV_OVERLAY_PROVIDER_ID || 'donations-lookup').trim() || 'donations-lookup'

  if (normalized.provider !== providerId) {
    throw new Error(`Unsupported overlay provider "${normalized.provider}"`)
  }

  const total = await countLookupOutputs(normalized.query)

  const rows = normalized.countOnly
    ? []
    : await listLookupOutputs(normalized.query)

  return {
    ok: true,
    provider: normalized.provider,
    outputs: rows.map(toPublicOutput),
    total,
    count: total,
    pagination: {
      limit: normalized.query.limit,
      offset: normalized.query.offset,
      returned: rows.length,
      total,
      hasMore: (normalized.query.offset + rows.length) < total,
    },
    meta: {
      topic: normalized.query.topic,
      order: normalized.query.order,
      minSatoshis: normalized.query.minSatoshis,
      excludeReserved: normalized.query.excludeReserved,
      confirmedOnly: normalized.query.confirmedOnly,
      countOnly: normalized.countOnly,
    },
  }
}
