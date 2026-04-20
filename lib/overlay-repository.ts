import type { PoolClient } from 'pg'

import { attachClientErrorHandler, dbPool, query } from './db'

export interface OverlayAdmittedUtxoRow {
  topic: string
  txid: string
  vout: number
  satoshis: number
  output_script: string
  // raw_tx and beef may be NULL for already-spent (removed=true) rows or for
  // rows fetched via projections that omit them (see lib/utxo-inventory.ts
  // acquireInventoryUtxo, which trims both for egress reasons).
  raw_tx: string | null
  beef: unknown | null
  admitted_at: string
  confirmed: boolean
  removed: boolean
  removed_at: string | null
  spending_txid: string | null
  wallet_index: number
  utxo_role: 'pool' | 'reserve'
  locked: boolean
  locked_by: string | null
  locked_at: string | null
}

export interface OverlayLookupQuery {
  topic: string
  limit: number
  offset: number
  order: 'asc' | 'desc'
  minSatoshis: number
  excludeReserved: boolean
  confirmedOnly: boolean
}

export interface OverlaySubmissionRecord {
  txid: string
  topic: string
  clientRequestId: string
  rawTx: string
  beef: unknown | null
  prevouts: unknown | null
  mapiResponses: unknown | null
  steak: unknown
  ackSummary: Record<string, string>
  allHostsAcknowledged: boolean
  accepted: boolean
}

export async function assertOverlaySchemaReady(): Promise<void> {
  await query('SELECT 1 FROM overlay_admitted_utxos LIMIT 1')
}

export async function withOverlayTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await dbPool.connect()
  attachClientErrorHandler(client)
  let connectionError: Error | null = null
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    // If the connection itself died (Supavisor reaped, TLS reset, etc.) the
    // ROLLBACK below will fail too — and rethrowing that secondary error
    // would mask the original. Detect connection-level failures and skip the
    // rollback; the server-side transaction is already gone with the socket.
    const message = error instanceof Error ? error.message : String(error)
    const connectionDied =
      /Connection terminated|server closed the connection|ECONNRESET|EPIPE|ETIMEDOUT|DbHandler exited/i.test(
        message,
      )
    if (connectionDied) {
      connectionError = error instanceof Error ? error : new Error(message)
    } else {
      try {
        await client.query('ROLLBACK')
      } catch {
        // best-effort; original error wins
      }
    }
    throw error
  } finally {
    client.release(connectionError ?? undefined)
  }
}

export async function getExistingOutputsForTopicTxid(
  client: PoolClient,
  topic: string,
  txid: string,
  vouts: number[],
): Promise<Map<number, OverlayAdmittedUtxoRow>> {
  if (vouts.length === 0) return new Map()

  const res = await client.query<OverlayAdmittedUtxoRow>(
    `SELECT topic, txid, vout, satoshis, output_script, raw_tx, beef, admitted_at, confirmed, removed, removed_at, spending_txid,
            wallet_index, utxo_role, locked, locked_by, locked_at
       FROM overlay_admitted_utxos
      WHERE topic = $1
        AND txid = $2
        AND vout = ANY($3::int[])`,
    [topic, txid, vouts],
  )

  return new Map(res.rows.map(row => [row.vout, row]))
}

export async function insertAdmittedOutput(
  client: PoolClient,
  row: Pick<OverlayAdmittedUtxoRow, 'topic' | 'txid' | 'vout' | 'satoshis' | 'output_script' | 'raw_tx' | 'beef' | 'confirmed' | 'wallet_index'> & {
    utxo_role?: OverlayAdmittedUtxoRow['utxo_role']
  },
): Promise<OverlayAdmittedUtxoRow> {
  const res = await client.query<OverlayAdmittedUtxoRow>(
    `INSERT INTO overlay_admitted_utxos (
       topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed, wallet_index, utxo_role
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
     ON CONFLICT (topic, txid, vout) DO UPDATE SET
       satoshis = EXCLUDED.satoshis,
       output_script = EXCLUDED.output_script,
       raw_tx = EXCLUDED.raw_tx,
       beef = COALESCE(EXCLUDED.beef, overlay_admitted_utxos.beef),
       confirmed = CASE WHEN EXCLUDED.confirmed THEN true ELSE overlay_admitted_utxos.confirmed END,
       wallet_index = EXCLUDED.wallet_index,
       utxo_role = EXCLUDED.utxo_role,
       locked = false,
       locked_by = NULL,
       locked_at = NULL,
       removed = false,
       removed_at = NULL,
       spending_txid = NULL
     RETURNING topic, txid, vout, satoshis, output_script, raw_tx, beef, admitted_at, confirmed, removed, removed_at, spending_txid,
               wallet_index, utxo_role, locked, locked_by, locked_at`,
    [
      row.topic,
      row.txid,
      row.vout,
      row.satoshis,
      row.output_script,
      row.raw_tx,
      row.beef == null ? null : JSON.stringify(row.beef),
      row.confirmed,
      row.wallet_index,
      row.utxo_role || 'pool',
    ],
  )

  return res.rows[0]
}

export async function updateExistingOutputMetadata(
  client: PoolClient,
  topic: string,
  txid: string,
  vout: number,
  rawTx: string,
  beef: unknown | null,
  confirmed: boolean,
): Promise<void> {
  await client.query(
    `UPDATE overlay_admitted_utxos
        SET raw_tx = $4,
            beef = COALESCE($5::jsonb, beef),
            confirmed = CASE WHEN $6 THEN true ELSE confirmed END
      WHERE topic = $1
        AND txid = $2
        AND vout = $3`,
    [topic, txid, vout, rawTx, beef == null ? null : JSON.stringify(beef), confirmed],
  )
}

export async function markCoinRemoved(
  client: PoolClient,
  topic: string,
  txid: string,
  vout: number,
  spendingTxid: string,
): Promise<OverlayAdmittedUtxoRow | null> {
  const res = await client.query<OverlayAdmittedUtxoRow>(
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
        AND removed = false
      RETURNING topic, txid, vout, satoshis, output_script, raw_tx, beef, admitted_at, confirmed, removed, removed_at, spending_txid,
                wallet_index, utxo_role, locked, locked_by, locked_at`,
    [topic, txid, vout, spendingTxid],
  )

  return res.rows[0] || null
}

export async function upsertOverlaySubmission(client: PoolClient, submission: OverlaySubmissionRecord): Promise<void> {
  await client.query(
    `INSERT INTO overlay_submissions (
       txid, topic, client_request_id, raw_tx, beef, prevouts, mapi_responses,
       steak, ack_summary, all_hosts_acknowledged, accepted
     )
     VALUES (
       $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
       $8::jsonb, $9::jsonb, $10, $11
     )
     ON CONFLICT (txid, topic) DO UPDATE
     SET
       client_request_id = EXCLUDED.client_request_id,
       raw_tx = EXCLUDED.raw_tx,
       beef = COALESCE(EXCLUDED.beef, overlay_submissions.beef),
       prevouts = COALESCE(EXCLUDED.prevouts, overlay_submissions.prevouts),
       mapi_responses = COALESCE(EXCLUDED.mapi_responses, overlay_submissions.mapi_responses),
       steak = EXCLUDED.steak,
       ack_summary = EXCLUDED.ack_summary,
       all_hosts_acknowledged = EXCLUDED.all_hosts_acknowledged,
       accepted = EXCLUDED.accepted,
       updated_at = now()`,
    [
      submission.txid,
      submission.topic,
      submission.clientRequestId,
      submission.rawTx,
      submission.beef == null ? null : JSON.stringify(submission.beef),
      submission.prevouts == null ? null : JSON.stringify(submission.prevouts),
      submission.mapiResponses == null ? null : JSON.stringify(submission.mapiResponses),
      JSON.stringify(submission.steak ?? {}),
      JSON.stringify(submission.ackSummary ?? {}),
      submission.allHostsAcknowledged,
      submission.accepted,
    ],
  )
}

export async function refreshTopicCounts(client: PoolClient, topic: string, delta: number = 1): Promise<void> {
  await client.query(
    `INSERT INTO overlay_topic_counts (topic, available_count, confirmed_available_count, updated_at)
     VALUES ($1, $2, 0, now())
     ON CONFLICT (topic) DO UPDATE
       SET available_count = GREATEST(0, overlay_topic_counts.available_count + $2),
           updated_at = now()`,
    [topic, delta],
  )
}

function buildLookupWhere(queryInput: OverlayLookupQuery): { whereSql: string; params: any[] } {
  const params: any[] = [queryInput.topic]
  let index = params.length

  const clauses = ['u.topic = $1', 'u.removed = false', `u.utxo_role = 'pool'`]

  index += 1
  params.push(queryInput.confirmedOnly)
  clauses.push(`($${index}::boolean = false OR u.confirmed = true)`)

  index += 1
  params.push(queryInput.minSatoshis)
  clauses.push(`u.satoshis >= $${index}`)

  if (queryInput.excludeReserved) {
    clauses.push('u.locked = false')
  }

  return {
    whereSql: clauses.join(' AND '),
    params,
  }
}

// Cap the count scan so a single hot-path lookup can't pin a pool client for
// seconds when the table has lots of physical rows. The queue gate
// (lib/worker-queue.ts) and the inventory replenisher only need to know
// "≥ pauseMin spendable?" — an exact total over hundreds of thousands of rows
// is wasteful and was the dominant source of `IO/DataFileRead` waits that
// blocked broadcasts. Callers that genuinely need an exact total (rare; only
// external paginated UIs) can pass `exactCount: true`.
const COUNT_LOOKUP_CAP = (() => {
  const raw = Number(process.env.OVERLAY_COUNT_LOOKUP_CAP)
  if (!Number.isFinite(raw) || raw < 1) return 1000
  return Math.floor(raw)
})()

export async function countLookupOutputs(
  queryInput: OverlayLookupQuery,
  options: { exact?: boolean } = {},
): Promise<number> {
  const { whereSql, params } = buildLookupWhere(queryInput)
  if (options.exact === true) {
    const res = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM overlay_admitted_utxos u
        WHERE ${whereSql}`,
      params,
    )
    return Number(res.rows[0]?.count || '0')
  }
  // Bounded count: short-circuits as soon as the cap is reached. Returns the
  // true count when below the cap, or the cap value when at/above it.
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM (
         SELECT 1
           FROM overlay_admitted_utxos u
          WHERE ${whereSql}
          LIMIT ${COUNT_LOOKUP_CAP}
       ) bounded`,
    params,
  )
  return Number(res.rows[0]?.count || '0')
}

export async function listLookupOutputs(queryInput: OverlayLookupQuery): Promise<OverlayAdmittedUtxoRow[]> {
  const { whereSql, params } = buildLookupWhere(queryInput)
  const order = queryInput.order === 'desc' ? 'DESC' : 'ASC'
  const sql = `
    SELECT topic, txid, vout, satoshis, output_script,
           '' AS raw_tx, NULL::jsonb AS beef,
           admitted_at, confirmed,
           false AS removed, NULL::timestamptz AS removed_at, NULL AS spending_txid,
           wallet_index, utxo_role, locked, locked_by, locked_at
      FROM overlay_admitted_utxos u
     WHERE ${whereSql}
     ORDER BY u.satoshis ${order}, u.txid ${order}, u.vout ${order}
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}
  `

  const res = await query<OverlayAdmittedUtxoRow>(sql, [
    ...params,
    queryInput.limit,
    queryInput.offset,
  ])

  return res.rows
}
