import type { PoolClient } from 'pg'

import { dbPool, query } from './db'

export interface OverlayAdmittedUtxoRow {
  topic: string
  txid: string
  vout: number
  satoshis: number
  output_script: string
  raw_tx: string
  beef: unknown | null
  admitted_at: string
  confirmed: boolean
  removed: boolean
  removed_at: string | null
  spending_txid: string | null
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
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
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
    `SELECT topic, txid, vout, satoshis, output_script, raw_tx, beef, admitted_at, confirmed, removed, removed_at, spending_txid
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
  row: Pick<OverlayAdmittedUtxoRow, 'topic' | 'txid' | 'vout' | 'satoshis' | 'output_script' | 'raw_tx' | 'beef' | 'confirmed'>,
): Promise<OverlayAdmittedUtxoRow> {
  const res = await client.query<OverlayAdmittedUtxoRow>(
    `INSERT INTO overlay_admitted_utxos (
       topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING topic, txid, vout, satoshis, output_script, raw_tx, beef, admitted_at, confirmed, removed, removed_at, spending_txid`,
    [
      row.topic,
      row.txid,
      row.vout,
      row.satoshis,
      row.output_script,
      row.raw_tx,
      row.beef == null ? null : JSON.stringify(row.beef),
      row.confirmed,
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
            spending_txid = $4
      WHERE topic = $1
        AND txid = $2
        AND vout = $3
        AND removed = false
      RETURNING topic, txid, vout, satoshis, output_script, raw_tx, beef, admitted_at, confirmed, removed, removed_at, spending_txid`,
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

export async function getCachedTopicCount(topic: string, confirmedOnly: boolean): Promise<number | null> {
  const res = await query<{ available_count: string; confirmed_available_count: string }>(
    `SELECT available_count::text, confirmed_available_count::text
       FROM overlay_topic_counts
      WHERE topic = $1`,
    [topic],
  )

  const row = res.rows[0]
  if (!row) return null
  return Number(confirmedOnly ? row.confirmed_available_count : row.available_count)
}

function buildLookupWhere(queryInput: OverlayLookupQuery): { whereSql: string; params: any[] } {
  const params: any[] = [queryInput.topic]
  let index = params.length

  const clauses = ['u.topic = $1', 'u.removed = false']

  index += 1
  params.push(queryInput.confirmedOnly)
  clauses.push(`($${index}::boolean = false OR u.confirmed = true)`)

  index += 1
  params.push(queryInput.minSatoshis)
  clauses.push(`u.satoshis >= $${index}`)

  if (queryInput.excludeReserved) {
    clauses.push(`NOT EXISTS (
      SELECT 1
        FROM utxo_locks l
       WHERE l.utxo_key = (u.txid || ':' || u.vout::text)
         AND l.expires_at >= now()
    )`)
  }

  return {
    whereSql: clauses.join(' AND '),
    params,
  }
}

export async function countLookupOutputs(queryInput: OverlayLookupQuery): Promise<number> {
  const { whereSql, params } = buildLookupWhere(queryInput)
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM overlay_admitted_utxos u
      WHERE ${whereSql}`,
    params,
  )
  return Number(res.rows[0]?.count || '0')
}

export async function listLookupOutputs(queryInput: OverlayLookupQuery): Promise<OverlayAdmittedUtxoRow[]> {
  const { whereSql, params } = buildLookupWhere(queryInput)
  const order = queryInput.order === 'desc' ? 'DESC' : 'ASC'
  const sql = `
    SELECT topic, txid, vout, satoshis, output_script, raw_tx, beef, admitted_at, confirmed, removed, removed_at, spending_txid
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
