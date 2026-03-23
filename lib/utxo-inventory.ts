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
    RETURNING u.topic, u.txid, u.vout, u.satoshis, u.output_script, u.raw_tx, u.beef,
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
  return withOverlayTransaction(client => acquireInventoryUtxo(client, { ...input, role: 'pool' }))
}

export async function acquireReserveUtxo(input: Omit<AcquireInventoryUtxoInput, 'role'>): Promise<InventoryUtxo | null> {
  return withOverlayTransaction(async (client) => {
    const reserved = await acquireInventoryUtxo(client, { ...input, role: 'reserve', preferLargest: true })
    if (reserved) return reserved
    return acquireInventoryUtxo(client, { ...input, role: 'pool', preferLargest: true })
  })
}

export async function releaseUtxo(topic: string, txid: string, vout: number, lockedBy?: string): Promise<void> {
  const owner = lockedBy || getLockOwnerId()
  await withOverlayTransaction(async (client) => {
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
      await client.query(
        `INSERT INTO overlay_admitted_utxos (
           topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed,
           wallet_index, utxo_role, locked, locked_by, locked_at, removed, removed_at, spending_txid
         )
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, false, NULL, NULL, false, NULL, NULL)
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
           locked_at = NULL`,
        [
          input.topic,
          input.spendingTxid,
          input.change.vout,
          input.change.satoshis,
          input.change.outputScript,
          input.rawTx,
          input.change.confirmed === true,
          input.walletIndex,
          admittedRole,
        ],
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

    for (const output of input.outputs.filter(candidate => candidate.satoshis >= 0)) {
      const admittedRole = output.utxoRole === 'reserve' ? 'reserve' : 'pool'
      await client.query(
        `INSERT INTO overlay_admitted_utxos (
           topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed,
           wallet_index, utxo_role, locked, locked_by, locked_at, removed, removed_at, spending_txid
         )
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, false, NULL, NULL, false, NULL, NULL)
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
           locked_at = NULL`,
        [
          input.topic,
          input.spendingTxid,
          output.vout,
          output.satoshis,
          output.outputScript,
          input.rawTx,
          output.confirmed === true,
          input.walletIndex,
          admittedRole,
        ],
      )
    }
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
