import { classifyArcTxStatus, arcBroadcastPhaseForDb, type ArcPhase, type ArcStatusProvider } from './arc-tx-status'
import { query } from './db'

/**
 * Which broadcast provider a row belongs to. The reconciler queries a single
 * provider's endpoint, so a legacy ARC row must never be looked up at a
 * Broadcaster host (and vice versa): the two track the same txid in different
 * stores, and a 404 from the wrong one says nothing.
 */
export type BroadcastProvider = 'broadcaster' | 'arc'

export function buildArcStatusRow(
  txStatus: string | null | undefined,
  acceptedVia: string | null,
): {
  txStatus: string
  phase: ArcPhase
  acceptedVia: string | null
} {
  const normalized = txStatus == null ? '' : txStatus.trim()
  return {
    txStatus: normalized,
    phase: classifyArcTxStatus(normalized),
    acceptedVia,
  }
}

export interface UpsertArcBroadcastStatusInput {
  txid: string
  txStatus: string | null | undefined
  acceptedVia: string | null
  /** Which provider holds this transaction. Defaults to `arc` for old callers. */
  provider?: BroadcastProvider
  /** Host that accepted the submission, e.g. `https://arcade-eu-1.bsvblockchain.tech`. */
  acceptedEndpoint?: string | null
  /** Token scoping this transaction's Broadcaster SSE stream. */
  callbackToken?: string | null
  /** Last SSE event id consumed for this transaction. */
  lastEventId?: string | null
  /** Hex BRC-74 BUMP, when the provider has produced a merkle proof. */
  merklePath?: string | null
  blockHash?: string | null
  blockHeight?: number | null
  /** Merkle root from the proof. Set together with `rootMatchesHeader`. */
  merkleRoot?: string | null
  /** True when the proof's root equals the verified header's merkle root. */
  rootMatchesHeader?: boolean
  /**
   * True only when the header itself was chain-verified. Never pass `true` on
   * the strength of a proof alone: `root_matches_header` records that weaker
   * fact, and conflating the two is how an unconfirmed output becomes spendable
   * against BSV_MIN_SPEND_CONFIRMATIONS.
   */
  spvVerified?: boolean
  /** Competing txids reported alongside DOUBLE_SPEND_ATTEMPTED. */
  competingTxs?: unknown
  /** Numeric broadcaster/ARC code (465, 476, 461, ...). */
  lastErrorCode?: number | null
}

/** Postgres `undefined_column`. Raised when migration 0035 has not run yet. */
function isUndefinedColumn(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === '42703'
  )
}

/** Postgres `undefined_table`. Raised before migration 0032 has run. */
function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === '42P01'
  )
}

/** Postgres `check_violation`. Raised when a phase is not yet in the CHECK. */
function isCheckViolation(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === '23514'
  )
}

/**
 * A message that is worth reading.
 *
 * Node's connection failures arrive as an `AggregateError` with `message: ''`
 * and the useful part in `code` (`ECONNREFUSED`) or in a nested `errors[]`. A
 * log line ending in "failed: " tells an operator nothing and is how a real
 * outage goes unnoticed.
 */
export function describeError(error: unknown): string {
  if (error == null) return 'unknown error'
  if (typeof error === 'string') return error || 'unknown error'
  if (!(error instanceof Error)) return String(error) || 'unknown error'

  const rawCode = (error as unknown as { code?: unknown }).code
  const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : null
  const message = error.message?.trim() ?? ''
  const rawNested = (error as unknown as { errors?: unknown }).errors
  const firstNested =
    Array.isArray(rawNested) && rawNested.length > 0 ? describeError(rawNested[0]) : null

  if (message) {
    // A nested error usually repeats the code ("ECONNREFUSED: connect
    // ECONNREFUSED …"). Prefixing it again produces noise, not information.
    const codeAlreadyStated = code != null && message.includes(code)
    return code && !codeAlreadyStated ? `${code}: ${message}` : message
  }
  if (code) {
    return firstNested && firstNested !== code ? `${code} (${firstNested})` : code
  }
  if (firstNested) return firstNested
  return error.name || 'unknown error'
}

function warn(message: string): void {
  console.warn(message)
}

/**
 * The 0032 shape: four columns, no provider or SPV fields.
 *
 * Used verbatim when the extended columns do not exist, so an upgraded worker
 * running against an un-migrated database still records phase transitions
 * instead of dropping every status write on the floor.
 */
async function insertLegacyShape(
  input: UpsertArcBroadcastStatusInput,
  dbPhase: ArcPhase,
  txStatus: string,
): Promise<void> {
  await query(
    `INSERT INTO arc_broadcast_status (txid, tx_status, phase, accepted_via, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (txid) DO UPDATE SET
       tx_status = EXCLUDED.tx_status,
       phase = EXCLUDED.phase,
       accepted_via = EXCLUDED.accepted_via,
       updated_at = now()
     WHERE arc_broadcast_status.phase NOT IN ('mined', 'immutable')
        OR EXCLUDED.phase IN ('mined', 'immutable', 'reorg')`,
    [input.txid, txStatus, dbPhase, input.acceptedVia],
  )
}

/**
 * Record a broadcast status transition.
 *
 * Backwards compatible: every field beyond `txid`/`txStatus`/`acceptedVia` is
 * optional, and a database that predates migration 0035 gets the 0032
 * four-column write rather than an error.
 *
 * ## Why the conflict clause is not a plain overwrite
 *
 *   - A later event must not regress a mined row to pending. The `WHERE` on the
 *     conflict mirrors `shouldPersistArcPhase`: `immutable` only accepts
 *     `mined`/`immutable`; `mined` accepts `mined`/`immutable`/`reorg`;
 *     `rejected` accepts only on-chain evidence.
 *   - A reorg re-anchors the transaction to a new block. Overwriting
 *     `merkle_path` would destroy the superseded proof, and that proof is the
 *     only record of which block the transaction was in. It is appended to
 *     `orphaned_proofs` instead.
 *   - A proof that has not changed must not reset `spv_verified`, or every
 *     duplicate MINED event would re-queue the same verification.
 */
export async function upsertArcBroadcastStatus(
  input: UpsertArcBroadcastStatusInput,
): Promise<void> {
  const row = buildArcStatusRow(input.txStatus, input.acceptedVia)
  const txStatus = row.txStatus
  const phase = row.phase
  const provider: BroadcastProvider = input.provider ?? 'arc'

  // `immutable` is written as-is so the widened CHECK (0035) keeps the stronger
  // fact. If the constraint has not been widened yet the insert fails with
  // 23514 and the retry below maps it to `mined`, which every reader treats the
  // same way.
  const phasesToTry: ArcPhase[] = phase === 'immutable' ? ['immutable', 'mined'] : [phase]

  const merklePath = typeof input.merklePath === 'string' && input.merklePath.trim() !== ''
    ? input.merklePath.trim()
    : null
  const blockHash = typeof input.blockHash === 'string' && input.blockHash.trim() !== ''
    ? input.blockHash.trim().toLowerCase()
    : null
  const blockHeight = typeof input.blockHeight === 'number'
    && Number.isSafeInteger(input.blockHeight)
    && input.blockHeight > 0
    ? input.blockHeight
    : null
  const competingTxs = input.competingTxs == null ? null : JSON.stringify(input.competingTxs)
  const lastErrorCode = typeof input.lastErrorCode === 'number'
    && Number.isSafeInteger(input.lastErrorCode)
    ? input.lastErrorCode
    : null

  let lastError: unknown = null

  for (const dbPhase of phasesToTry) {
    try {
      await query(
        `INSERT INTO arc_broadcast_status (
           txid, tx_status, phase, accepted_via, updated_at,
           provider, accepted_endpoint, callback_token, last_event_id,
           merkle_path, block_hash, block_height, merkle_root,
           spv_verified, root_matches_header, competing_txs, last_error_code
         )
         VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
         ON CONFLICT (txid) DO UPDATE SET
           tx_status = EXCLUDED.tx_status,
           phase = EXCLUDED.phase,
           accepted_via = COALESCE(EXCLUDED.accepted_via, arc_broadcast_status.accepted_via),
           provider = COALESCE(EXCLUDED.provider, arc_broadcast_status.provider),
           accepted_endpoint = COALESCE(EXCLUDED.accepted_endpoint, arc_broadcast_status.accepted_endpoint),
           callback_token = COALESCE(EXCLUDED.callback_token, arc_broadcast_status.callback_token),
           last_event_id = COALESCE(EXCLUDED.last_event_id, arc_broadcast_status.last_event_id),
           merkle_root = COALESCE(EXCLUDED.merkle_root, arc_broadcast_status.merkle_root),
           -- A new proof for the same transaction is a re-anchor: keep the old
           -- one as evidence rather than losing it to an overwrite.
           orphaned_proofs = CASE
             WHEN EXCLUDED.merkle_path IS NOT NULL
              AND arc_broadcast_status.merkle_path IS NOT NULL
              AND EXCLUDED.merkle_path IS DISTINCT FROM arc_broadcast_status.merkle_path
             THEN COALESCE(arc_broadcast_status.orphaned_proofs, '[]'::jsonb) || jsonb_build_object(
               'merklePath', arc_broadcast_status.merkle_path,
               'blockHash', arc_broadcast_status.block_hash,
               'blockHeight', arc_broadcast_status.block_height,
               'orphanedAt', now()
             )
             ELSE arc_broadcast_status.orphaned_proofs
           END,
           merkle_path = COALESCE(EXCLUDED.merkle_path, arc_broadcast_status.merkle_path),
           block_hash = COALESCE(EXCLUDED.block_hash, arc_broadcast_status.block_hash),
           block_height = COALESCE(EXCLUDED.block_height, arc_broadcast_status.block_height),
           -- Verification state belongs to one specific proof. A changed proof
           -- has not been verified, so its flag comes from the caller; an
           -- unchanged proof keeps whatever was already established.
           spv_verified = CASE
             WHEN EXCLUDED.merkle_path IS NULL THEN arc_broadcast_status.spv_verified
             WHEN arc_broadcast_status.merkle_path IS DISTINCT FROM EXCLUDED.merkle_path
               THEN EXCLUDED.spv_verified
             ELSE (arc_broadcast_status.spv_verified OR EXCLUDED.spv_verified)
           END,
           root_matches_header = CASE
             WHEN EXCLUDED.merkle_path IS NULL THEN arc_broadcast_status.root_matches_header
             WHEN arc_broadcast_status.merkle_path IS DISTINCT FROM EXCLUDED.merkle_path
               THEN EXCLUDED.root_matches_header
             ELSE (arc_broadcast_status.root_matches_header OR EXCLUDED.root_matches_header)
           END,
           competing_txs = COALESCE(EXCLUDED.competing_txs, arc_broadcast_status.competing_txs),
           last_error_code = COALESCE(EXCLUDED.last_error_code, arc_broadcast_status.last_error_code),
           updated_at = now()
         WHERE CASE arc_broadcast_status.phase
                 WHEN 'immutable' THEN EXCLUDED.phase IN ('mined', 'immutable')
                 WHEN 'mined' THEN EXCLUDED.phase IN ('mined', 'immutable', 'reorg')
                 WHEN 'rejected' THEN EXCLUDED.phase IN ('mined', 'immutable')
                 ELSE TRUE
               END`,
        [
          input.txid,
          txStatus,
          dbPhase,
          row.acceptedVia,
          provider,
          input.acceptedEndpoint ?? null,
          input.callbackToken ?? null,
          input.lastEventId ?? null,
          merklePath,
          blockHash,
          blockHeight,
          input.merkleRoot ?? null,
          input.spvVerified === true,
          input.rootMatchesHeader === true,
          competingTxs,
          lastErrorCode,
        ],
      )
      return
    } catch (error) {
      lastError = error
      if (isUndefinedTable(error)) {
        // arc_broadcast_status does not exist yet. Nothing to record, and
        // nothing a caller can do about it at this point.
        warn(
          `⚠️  arc_broadcast_status table missing; skipped status write for ${input.txid.substring(0, 12)}…`,
        )
        return
      }
      if (isUndefinedColumn(error)) {
        // Migration 0035 has not run. Fall back to the 0032 shape rather than
        // dropping the phase transition entirely.
        try {
          await insertLegacyShape(input, arcBroadcastPhaseForDb(dbPhase), txStatus)
        } catch (legacyError) {
          warn(
            `⚠️  arc_broadcast_status upsert failed for ${input.txid.substring(0, 12)}…: ${describeError(
              legacyError,
            )}`,
          )
        }
        return
      }
      if (isCheckViolation(error)) {
        // The phase CHECK does not accept this value yet; try the next
        // candidate (immutable → mined).
        continue
      }
      break
    }
  }

  warn(
    `⚠️  arc_broadcast_status upsert failed for ${input.txid.substring(0, 12)}…: ${describeError(
      lastError,
    )}`,
  )
}

export async function getArcBroadcastPhase(txid: string): Promise<ArcPhase | null> {
  try {
    const result = await query<{ phase: ArcPhase }>(
      `SELECT phase FROM arc_broadcast_status WHERE txid = $1 LIMIT 1`,
      [txid],
    )
    const row = result.rows[0]
    if (!row) return null
    return row.phase
  } catch (error) {
    warn(
      `⚠️  arc_broadcast_status phase read failed for ${txid.substring(0, 12)}…: ${
        describeError(error)
      }`,
    )
    return null
  }
}

/** The status string a caller can show without a second query. */
export async function getArcBroadcastStatus(
  txid: string,
): Promise<{ phase: ArcPhase; txStatus: string; provider: string | null } | null> {
  try {
    const result = await query<{ phase: ArcPhase; tx_status: string; provider?: string | null }>(
      `SELECT phase, tx_status, provider FROM arc_broadcast_status WHERE txid = $1 LIMIT 1`,
      [txid],
    )
    const row = result.rows[0]
    if (!row) return null
    return { phase: row.phase, txStatus: row.tx_status, provider: row.provider ?? null }
  } catch (error) {
    if (isUndefinedColumn(error)) {
      // Pre-0035: retry without `provider`.
      try {
        const result = await query<{ phase: ArcPhase; tx_status: string }>(
          `SELECT phase, tx_status FROM arc_broadcast_status WHERE txid = $1 LIMIT 1`,
          [txid],
        )
        const row = result.rows[0]
        if (!row) return null
        return { phase: row.phase, txStatus: row.tx_status, provider: null }
      } catch {
        return null
      }
    }
    if (isUndefinedTable(error)) return null
    warn(
      `⚠️  arc_broadcast_status read failed for ${txid.substring(0, 12)}…: ${
        describeError(error)
      }`,
    )
    return null
  }
}

/**
 * Persist the SSE stream cursor for a provider token.
 *
 * Stored per transaction rather than per token: a restart has to resume the
 * stream for every in-flight transaction, and the txid is what the stream's
 * events are keyed on anyway.
 */
export async function recordLastEventId(txid: string, eventId: string): Promise<void> {
  try {
    await query(
      `UPDATE arc_broadcast_status SET last_event_id = $2, updated_at = now() WHERE txid = $1`,
      [txid, eventId],
    )
  } catch (error) {
    if (isUndefinedColumn(error) || isUndefinedTable(error)) return
    warn(
      `⚠️  last_event_id write failed for ${txid.substring(0, 12)}…: ${
        describeError(error)
      }`,
    )
  }
}

/** Persist SPV verification evidence for a mined transaction. */
export async function recordSpvVerification(input: {
  txid: string
  merklePath: string
  merkleRoot: string | null
  blockHash: string | null
  blockHeight: number | null
  rootMatchesHeader: boolean
  spvVerified: boolean
}): Promise<void> {
  try {
    await query(
      `UPDATE arc_broadcast_status
          SET merkle_path = $2,
              merkle_root = COALESCE($3, merkle_root),
              block_hash = COALESCE($4, block_hash),
              block_height = COALESCE($5, block_height),
              root_matches_header = $6,
              spv_verified = $7,
              updated_at = now()
        WHERE txid = $1`,
      [
        input.txid,
        input.merklePath,
        input.merkleRoot,
        input.blockHash,
        input.blockHeight,
        input.rootMatchesHeader,
        input.spvVerified,
      ],
    )
  } catch (error) {
    if (isUndefinedColumn(error) || isUndefinedTable(error)) return
    warn(
      `⚠️  SPV verification write failed for ${input.txid.substring(0, 12)}…: ${
        describeError(error)
      }`,
    )
  }
}

export type { ArcStatusProvider }
