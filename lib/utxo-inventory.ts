import type { PoolClient } from 'pg'

import { getLockOwnerId } from './utxo-locks'
import {
  refreshTopicCounts,
  withOverlayTransaction,
  type OverlayAdmittedUtxoRow,
} from './overlay-repository'

export type UtxoRole = 'pool' | 'reserve'

export interface InventoryUtxo extends OverlayAdmittedUtxoRow {
  wallet_index: number
  utxo_role: UtxoRole
  locked: boolean
  locked_by: string | null
  locked_at: string | null
}

// Propagation grace: a freshly admitted change/split output stays invisible to
// acquireInventoryUtxo for this many milliseconds, giving the parent transaction
// time to reach every ARC relay before a child tx can spend its change. Default
// 2500ms comfortably exceeds typical ARC response latency (~5s in observed
// production) minus the in-process work that follows admission. Set to 0 to
// disable (debug only — re-enables the historical 460 race).
function getPropagationGraceMs(): number {
  const raw = Number(process.env.BSV_PROPAGATION_GRACE_MS)
  if (!Number.isFinite(raw) || raw < 0) return 2500
  return Math.floor(raw)
}

// Per-transaction statement timeout for UTXO acquisition. The acquire query
// targets a partial index and should complete in single-digit milliseconds.
// If it ever takes longer (table bloat, stale stats, planner regression, lock
// contention) we want it to fail fast and release the pool client so the
// caller can fall through to the next wallet, rather than holding a connection
// hostage for the full server-side statement_timeout (typically 60s on Supabase).
function getAcquireStatementTimeoutMs(): number {
  const raw = Number(process.env.BSV_UTXO_ACQUIRE_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw < 100) return 5000
  return Math.floor(raw)
}

export interface AcquireInventoryUtxoInput {
  walletIndex: number
  role: UtxoRole
  minSatoshis: number
  confirmedOnly?: boolean
  lockedBy?: string
  preferLargest?: boolean
}

export interface ConsumeAndAdmitChangeInput {
  topic: string
  walletIndex: number
  spentTxid: string
  spentVout: number
  spendingTxid: string
  rawTx: string
  change?: {
    vout: number
    satoshis: number
    outputScript: string
    confirmed?: boolean
    utxoRole?: UtxoRole
  } | null
}

export interface SplitAdmittedOutput {
  vout: number
  satoshis: number
  outputScript: string
  confirmed?: boolean
  utxoRole?: UtxoRole
}

export interface AdmitSplitOutputsInput {
  topic: string
  walletIndex: number
  spentTxid: string
  spentVout: number
  spendingTxid: string
  rawTx: string
  outputs: SplitAdmittedOutput[]
}

export interface WalletInventorySummary {
  walletIndex: number
  totalPool: number
  confirmedPool: number
  lockedPool: number
  totalReserve: number
  confirmedReserve: number
  lockedReserve: number
}

function mapInventoryRow(row: InventoryUtxo): InventoryUtxo {
  return {
    ...row,
    satoshis: Number(row.satoshis),
    wallet_index: Number(row.wallet_index),
    utxo_role: row.utxo_role === 'reserve' ? 'reserve' : 'pool',
    locked: row.locked === true,
  }
}

async function acquireInventoryUtxo(client: PoolClient, input: AcquireInventoryUtxoInput): Promise<InventoryUtxo | null> {
  const lockedBy = input.lockedBy || getLockOwnerId()
  const preferLargest = input.preferLargest === true
  // raw_tx and beef are intentionally NOT included in RETURNING.  Neither the
  // spend path (lib/blockchain.ts) nor the maintainer (lib/utxo-maintainer.ts)
  // reads them — they only need (txid, vout, output_script, satoshis) to build
  // a fresh signed transaction.  Streaming raw_tx (often 200-2000 bytes) on
  // every acquisition was a major contributor to Supabase egress at load.
  // Both columns remain populated on disk for live rows in case future code
  // paths need them; they can be lazy-loaded by a follow-up SELECT keyed on
  // (topic, txid, vout) when actually required.
  const res = await client.query<InventoryUtxo>(
    `WITH candidate AS (
       SELECT topic, txid, vout
         FROM overlay_admitted_utxos
        WHERE wallet_index = $1
          AND utxo_role = $2
          AND removed = false
          AND locked = false
          AND satoshis >= $3
          AND ($4::boolean = false OR confirmed = true)
          AND acquirable_at <= now()
        ORDER BY satoshis ${preferLargest ? 'DESC' : 'ASC'}, admitted_at ASC, txid ASC, vout ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE overlay_admitted_utxos u
        SET locked = true,
            locked_by = $5,
            locked_at = now()
       FROM candidate c
      WHERE u.topic = c.topic
        AND u.txid = c.txid
        AND u.vout = c.vout
    RETURNING u.topic, u.txid, u.vout, u.satoshis, u.output_script,
              u.admitted_at, u.confirmed, u.removed, u.removed_at, u.spending_txid,
              u.wallet_index, u.utxo_role, u.locked, u.locked_by, u.locked_at`,
    [
      input.walletIndex,
      input.role,
      Math.max(0, Math.floor(input.minSatoshis)),
      input.confirmedOnly === true,
      lockedBy,
    ],
  )

  return res.rows[0] ? mapInventoryRow(res.rows[0]) : null
}

export async function acquirePoolUtxo(input: Omit<AcquireInventoryUtxoInput, 'role'>): Promise<InventoryUtxo | null> {
  return withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${getAcquireStatementTimeoutMs()}`)
    return acquireInventoryUtxo(client, { ...input, role: 'pool' })
  })
}

export async function acquireReserveUtxo(input: Omit<AcquireInventoryUtxoInput, 'role'>): Promise<InventoryUtxo | null> {
  return withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${getAcquireStatementTimeoutMs()}`)
    const reserved = await acquireInventoryUtxo(client, { ...input, role: 'reserve', preferLargest: true })
    if (reserved) return reserved
    return acquireInventoryUtxo(client, { ...input, role: 'pool', preferLargest: true })
  })
}

export interface ReleaseUtxoOptions {
  lockedBy?: string
  // When set, push acquirable_at forward by this many milliseconds so the
  // UTXO is not immediately re-grabbed. Use after a broadcast failure where
  // the failure mode (e.g. ARC 460 parent-not-found) is likely to recur if
  // the same input is retried straight away.
  cooldownMs?: number
}

export async function releaseUtxo(
  topic: string,
  txid: string,
  vout: number,
  optionsOrLockedBy?: ReleaseUtxoOptions | string,
): Promise<void> {
  const opts: ReleaseUtxoOptions = typeof optionsOrLockedBy === 'string'
    ? { lockedBy: optionsOrLockedBy }
    : (optionsOrLockedBy || {})
  const owner = opts.lockedBy || getLockOwnerId()
  const cooldownMs = Number.isFinite(opts.cooldownMs as number) && (opts.cooldownMs as number) > 0
    ? Math.floor(opts.cooldownMs as number)
    : 0
  await withOverlayTransaction(async (client) => {
    if (cooldownMs > 0) {
      await client.query(
        `UPDATE overlay_admitted_utxos
            SET locked = false,
                locked_by = NULL,
                locked_at = NULL,
                acquirable_at = GREATEST(acquirable_at, now() + ($5::bigint * interval '1 millisecond'))
          WHERE topic = $1
            AND txid = $2
            AND vout = $3
            AND locked = true
            AND ($4::text = '' OR locked_by = $4)`,
        [topic, txid, vout, owner, cooldownMs],
      )
    } else {
      await client.query(
        `UPDATE overlay_admitted_utxos
            SET locked = false,
                locked_by = NULL,
                locked_at = NULL
          WHERE topic = $1
            AND txid = $2
            AND vout = $3
            AND locked = true
            AND ($4::text = '' OR locked_by = $4)`,
        [topic, txid, vout, owner],
      )
    }
  })
}

export async function consumeAndAdmitChange(input: ConsumeAndAdmitChangeInput): Promise<void> {
  await withOverlayTransaction(async (client) => {
    const removed = await client.query(
      `UPDATE overlay_admitted_utxos
          SET removed = true,
              removed_at = now(),
              spending_txid = $4,
              locked = false,
              locked_by = NULL,
              locked_at = NULL
        WHERE topic = $1
          AND txid = $2
          AND vout = $3
          AND removed = false`,
      [input.topic, input.spentTxid, input.spentVout, input.spendingTxid],
    )

    if ((removed.rowCount || 0) === 0) {
      throw new Error(`Inventory UTXO ${input.spentTxid}:${input.spentVout} was not available to consume`)
    }

    let delta = -1

    if (input.change && input.change.satoshis >= 0) {
      const admittedRole = input.change.utxoRole === 'reserve' ? 'reserve' : 'pool'
      const graceMs = getPropagationGraceMs()
      // Confirmed change (rare here — most change starts unconfirmed) bypasses
      // the grace window: its parent is already in a block and propagated.
      const acquirableAtSql = (input.change.confirmed === true || graceMs === 0)
        ? 'now()'
        : `now() + ($10::bigint * interval '1 millisecond')`
      const params: any[] = [
        input.topic,
        input.spendingTxid,
        input.change.vout,
        input.change.satoshis,
        input.change.outputScript,
        input.rawTx,
        input.change.confirmed === true,
        input.walletIndex,
        admittedRole,
      ]
      if (input.change.confirmed !== true && graceMs > 0) params.push(graceMs)
      await client.query(
        `INSERT INTO overlay_admitted_utxos (
           topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed,
           wallet_index, utxo_role, locked, locked_by, locked_at, removed, removed_at, spending_txid,
           acquirable_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, false, NULL, NULL, false, NULL, NULL, ${acquirableAtSql})
         ON CONFLICT (topic, txid, vout) DO UPDATE SET
           satoshis = EXCLUDED.satoshis,
           output_script = EXCLUDED.output_script,
           raw_tx = EXCLUDED.raw_tx,
           confirmed = CASE WHEN EXCLUDED.confirmed THEN true ELSE overlay_admitted_utxos.confirmed END,
           wallet_index = EXCLUDED.wallet_index,
           utxo_role = EXCLUDED.utxo_role,
           removed = false,
           removed_at = NULL,
           spending_txid = NULL,
           locked = false,
           locked_by = NULL,
           locked_at = NULL,
           acquirable_at = EXCLUDED.acquirable_at`,
        params,
      )
      delta += 1
    }

    await refreshTopicCounts(client, input.topic, delta)
  })
}

export async function admitSplitOutputs(input: AdmitSplitOutputsInput): Promise<void> {
  await withOverlayTransaction(async (client) => {
    const removed = await client.query(
      `UPDATE overlay_admitted_utxos
          SET removed = true,
              removed_at = now(),
              spending_txid = $4,
              locked = false,
              locked_by = NULL,
              locked_at = NULL
        WHERE topic = $1
          AND txid = $2
          AND vout = $3
          AND removed = false`,
      [input.topic, input.spentTxid, input.spentVout, input.spendingTxid],
    )

    if ((removed.rowCount || 0) === 0) {
      throw new Error(`Inventory UTXO ${input.spentTxid}:${input.spentVout} was not available for split admission`)
    }

    const graceMs = getPropagationGraceMs()
    for (const output of input.outputs.filter(candidate => candidate.satoshis >= 0)) {
      const admittedRole = output.utxoRole === 'reserve' ? 'reserve' : 'pool'
      const acquirableAtSql = (output.confirmed === true || graceMs === 0)
        ? 'now()'
        : `now() + ($10::bigint * interval '1 millisecond')`
      const params: any[] = [
        input.topic,
        input.spendingTxid,
        output.vout,
        output.satoshis,
        output.outputScript,
        input.rawTx,
        output.confirmed === true,
        input.walletIndex,
        admittedRole,
      ]
      if (output.confirmed !== true && graceMs > 0) params.push(graceMs)
      await client.query(
        `INSERT INTO overlay_admitted_utxos (
           topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed,
           wallet_index, utxo_role, locked, locked_by, locked_at, removed, removed_at, spending_txid,
           acquirable_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, false, NULL, NULL, false, NULL, NULL, ${acquirableAtSql})
         ON CONFLICT (topic, txid, vout) DO UPDATE SET
           satoshis = EXCLUDED.satoshis,
           output_script = EXCLUDED.output_script,
           raw_tx = EXCLUDED.raw_tx,
           confirmed = CASE WHEN EXCLUDED.confirmed THEN true ELSE overlay_admitted_utxos.confirmed END,
           wallet_index = EXCLUDED.wallet_index,
           utxo_role = EXCLUDED.utxo_role,
           removed = false,
           removed_at = NULL,
           spending_txid = NULL,
           locked = false,
           locked_by = NULL,
           locked_at = NULL,
           acquirable_at = EXCLUDED.acquirable_at`,
        params,
      )
    }
  })
}

export interface InventoryDiagnostic {
  walletIndex: number
  totalLiveUtxos: number
  confirmedLiveUtxos: number
  reserveLiveUtxos: number
  confirmedReserveUtxos: number
  largestSats: number
  largestConfirmedSats: number
  largestConfirmedReserveSats: number
  totalLiveSats: number
  confirmedLiveSats: number
}

/**
 * Cheap forensic snapshot of a single wallet's UTXO inventory in
 * `overlay_admitted_utxos`. Used by the UTXO maintainer to emit precise
 * CRITICAL alerts when no splittable input exists, and by the wallet
 * funding monitor to compute days-of-runway.
 *
 * All counters exclude removed=true rows.  "Live" means the row is
 * still considered spendable bookkeeping.
 */
export async function getInventoryDiagnostic(walletIndex: number): Promise<InventoryDiagnostic> {
  return withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${getAcquireStatementTimeoutMs()}`)
    const res = await client.query<{
      total_live: string
      confirmed_live: string
      reserve_live: string
      confirmed_reserve: string
      largest_sats: string
      largest_confirmed_sats: string
      largest_confirmed_reserve_sats: string
      total_live_sats: string
      confirmed_live_sats: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE removed = false)::text AS total_live,
         COUNT(*) FILTER (WHERE removed = false AND confirmed = true)::text AS confirmed_live,
         COUNT(*) FILTER (WHERE removed = false AND utxo_role = 'reserve')::text AS reserve_live,
         COUNT(*) FILTER (WHERE removed = false AND utxo_role = 'reserve' AND confirmed = true)::text AS confirmed_reserve,
         COALESCE(MAX(satoshis) FILTER (WHERE removed = false), 0)::text AS largest_sats,
         COALESCE(MAX(satoshis) FILTER (WHERE removed = false AND confirmed = true), 0)::text AS largest_confirmed_sats,
         COALESCE(MAX(satoshis) FILTER (WHERE removed = false AND confirmed = true AND utxo_role = 'reserve'), 0)::text AS largest_confirmed_reserve_sats,
         COALESCE(SUM(satoshis) FILTER (WHERE removed = false), 0)::text AS total_live_sats,
         COALESCE(SUM(satoshis) FILTER (WHERE removed = false AND confirmed = true), 0)::text AS confirmed_live_sats
       FROM overlay_admitted_utxos
       WHERE wallet_index = $1`,
      [walletIndex],
    )
    const row = res.rows[0]
    return {
      walletIndex,
      totalLiveUtxos: Number(row?.total_live || '0'),
      confirmedLiveUtxos: Number(row?.confirmed_live || '0'),
      reserveLiveUtxos: Number(row?.reserve_live || '0'),
      confirmedReserveUtxos: Number(row?.confirmed_reserve || '0'),
      largestSats: Number(row?.largest_sats || '0'),
      largestConfirmedSats: Number(row?.largest_confirmed_sats || '0'),
      largestConfirmedReserveSats: Number(row?.largest_confirmed_reserve_sats || '0'),
      totalLiveSats: Number(row?.total_live_sats || '0'),
      confirmedLiveSats: Number(row?.confirmed_live_sats || '0'),
    }
  })
}

/**
 * Atomically locate and lock the largest splittable input for a wallet,
 * promoting it to `utxo_role='reserve'` if it was a pool row.
 *
 * Acquisition order (each step inside a single transaction):
 *   1. Confirmed reserve UTXO (the natural happy path).
 *   2. Confirmed pool UTXO ≥ minSatoshis — promoted to reserve in-place.
 *   3. (Only when allowUnconfirmed=true) unconfirmed reserve, then
 *      unconfirmed pool with the same in-place promotion.
 *
 * Promotion is critical: without it the maintainer can spend the largest
 * available pool UTXO once and then have no large input left to split
 * again — the change classification logic in admitSplitOutputs only
 * promotes change ≥ SPLIT_RESERVE_MIN_SATS, which can fail to refill the
 * reserve role under "death by a thousand cuts" splitting.
 *
 * Returns null if no UTXO ≥ minSatoshis exists (with the requested
 * confirmation policy). Callers should consult getInventoryDiagnostic
 * to log a precise CRITICAL alert in that case.
 */
export async function acquireSplittableInput(input: {
  walletIndex: number
  minSatoshis: number
  allowUnconfirmed?: boolean
  lockedBy?: string
}): Promise<InventoryUtxo | null> {
  return withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${getAcquireStatementTimeoutMs()}`)

    const ladder: Array<{ role: UtxoRole; confirmedOnly: boolean }> = [
      { role: 'reserve', confirmedOnly: true },
      { role: 'pool', confirmedOnly: true },
    ]
    if (input.allowUnconfirmed === true) {
      ladder.push({ role: 'reserve', confirmedOnly: false })
      ladder.push({ role: 'pool', confirmedOnly: false })
    }

    for (const step of ladder) {
      const acquired = await acquireInventoryUtxo(client, {
        walletIndex: input.walletIndex,
        role: step.role,
        minSatoshis: input.minSatoshis,
        confirmedOnly: step.confirmedOnly,
        lockedBy: input.lockedBy,
        preferLargest: true,
      })
      if (!acquired) continue

      // Promote pool → reserve in-place so the splitter has a deterministic
      // home for it next cycle (and so subsequent change classification can
      // always find at least one reserve row in the wallet).
      if (acquired.utxo_role !== 'reserve') {
        await client.query(
          `UPDATE overlay_admitted_utxos
              SET utxo_role = 'reserve'
            WHERE topic = $1
              AND txid = $2
              AND vout = $3
              AND utxo_role <> 'reserve'`,
          [acquired.topic, acquired.txid, acquired.vout],
        )
        acquired.utxo_role = 'reserve'
      }
      return acquired
    }

    return null
  })
}

export async function getWalletInventorySummary(walletIndex: number): Promise<WalletInventorySummary> {
  const result = await withOverlayTransaction(async (client) => {
    const res = await client.query<{
      total_pool: string
      confirmed_pool: string
      locked_pool: string
      total_reserve: string
      confirmed_reserve: string
      locked_reserve: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE removed = false AND utxo_role = 'pool')::text AS total_pool,
         COUNT(*) FILTER (WHERE removed = false AND utxo_role = 'pool' AND confirmed = true)::text AS confirmed_pool,
         COUNT(*) FILTER (WHERE removed = false AND utxo_role = 'pool' AND locked = true)::text AS locked_pool,
         COUNT(*) FILTER (WHERE removed = false AND utxo_role = 'reserve')::text AS total_reserve,
         COUNT(*) FILTER (WHERE removed = false AND utxo_role = 'reserve' AND confirmed = true)::text AS confirmed_reserve,
         COUNT(*) FILTER (WHERE removed = false AND utxo_role = 'reserve' AND locked = true)::text AS locked_reserve
       FROM overlay_admitted_utxos
      WHERE wallet_index = $1`,
      [walletIndex],
    )
    return res.rows[0]
  })

  return {
    walletIndex,
    totalPool: Number(result?.total_pool || '0'),
    confirmedPool: Number(result?.confirmed_pool || '0'),
    lockedPool: Number(result?.locked_pool || '0'),
    totalReserve: Number(result?.total_reserve || '0'),
    confirmedReserve: Number(result?.confirmed_reserve || '0'),
    lockedReserve: Number(result?.locked_reserve || '0'),
  }
}
