#!/usr/bin/env npx tsx
/**
 * Backfill confirmations for stale `overlay_explorer_readings` rows.
 *
 * Why
 * ---
 * The live confirmation worker only chases a recent window (default 72h) plus
 * a short catch-up. Rows that sat at confirmed=false for months never get
 * revisited, so the explorer shows "Unconfirmed" forever even though the TX
 * mined long ago.
 *
 * This script walks oldest-first unconfirmed explorer rows, looks them up on
 * Bitails (not WhatsOnChain — avoids competing with the live worker's WoC
 * quota), and applies the same idempotent confirmReading / UTXO / tx_log
 * updates the worker uses.
 *
 * Performance
 * -----------
 * The original path issued one Bitails request and three Supabase round-trips
 * per row, with a 200 ms sleep between each. At ~5 requests/second a multi-
 * million-row backlog takes weeks. This version:
 *   - looks up many txids concurrently against the lightweight /status endpoint
 *   - writes confirmations in a single batched UPDATE per chunk
 *   - skips the expensive COUNT(*) unless asked
 *   - can loop until the window is empty
 *
 * Safety
 * ------
 *   - Default is DRY-RUN (counts + samples only). Pass --apply to mutate.
 *   - Safe to run while gaialog-workers is online (idempotent UPDATEs).
 *   - Self-throttled; backs off on 429/5xx.
 *   - Bounded by --limit and --batch-size.
 *
 * Usage
 * -----
 *   cd /opt/gaialog
 *   npx tsx scripts/backfill-explorer-confirmations.ts
 *   npx tsx scripts/backfill-explorer-confirmations.ts --apply --limit 5000
 *   npx tsx scripts/backfill-explorer-confirmations.ts --apply \
 *           --older-than-days 1 --limit 50000 --concurrency 20 --loop
 */

import dotenv from 'dotenv'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..')
dotenv.config({ path: path.join(repoRoot, '.env'), override: true })
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.join(repoRoot, '.env.local'), override: true })
}

import { attachClientErrorHandler, dbPool, query } from '../lib/db'
import { confirmReading } from '../lib/overlay-explorer-repository'

/**
 * Run a statement on a held client with an explicit timeout.
 * Needed for pooler transaction mode (session SET does not stick across
 * checkouts) and for the pre-index era where keyset pages can take >15s.
 */
async function queryWithTimeout<T extends Record<string, unknown> = any>(
  text: string,
  params: unknown[] | undefined,
  timeoutMs: number,
): Promise<{ rows: T[]; rowCount: number }> {
  const client = await dbPool.connect()
  attachClientErrorHandler(client)
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, timeoutMs)}`)
    const res = await client.query<T>(text, params)
    await client.query('COMMIT')
    return { rows: res.rows || [], rowCount: res.rowCount ?? 0 }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // ignore
    }
    throw err
  } finally {
    client.release()
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function argValue(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

const APPLY = process.argv.includes('--apply')
const LOOP = process.argv.includes('--loop')
const COUNT = process.argv.includes('--count')
const OLDER_THAN_DAYS = Math.max(0, Number(argValue('--older-than-days', '1')))
const NEWER_THAN_DAYS = Math.max(
  0,
  Number(argValue('--newer-than-days', '0')), // 0 = no lower bound (include all history)
)
const LIMIT = Math.max(1, Number(argValue('--limit', '20000')))
const BATCH_SIZE = Math.max(1, Number(argValue('--batch-size', '200')))
/** Concurrent Bitails /status lookups. Bitails free tier is roughly 10 RPS. */
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency', '16')))
/**
 * Minimum gap between *starting* Bitails requests. With concurrency=16 and
 * 60 ms this targets ~16/s; raise if you see sustained 429s.
 */
const REQ_INTERVAL_MS = Math.max(0, Number(argValue('--req-interval-ms', '60')))
/** Per-page DB fetch timeout (ms). Raise only if the partial index is missing. */
const FETCH_TIMEOUT_MS = Math.max(5_000, Number(argValue('--fetch-timeout-ms', '120000')))
const BITAILS_BASE = (process.env.BSV_BITAILS_API_BASE || 'https://api.bitails.io').replace(/\/$/, '')

interface Candidate {
  txid: string
  reading_ts: string
}

interface LookupResult {
  txid: string
  mined: boolean
  blockHeight: number
  blockTime: Date | null
  rateLimited?: boolean
  missing?: boolean
  error?: string
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((r) => setTimeout(r, ms))
}

async function countStale(): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
       FROM overlay_explorer_readings
      WHERE confirmed = false
        AND reading_ts < now() - ($1::bigint * interval '1 day')
        AND ($2::bigint = 0 OR reading_ts > now() - ($2::bigint * interval '1 day'))`,
    [OLDER_THAN_DAYS, NEWER_THAN_DAYS],
  )
  return Number(res.rows[0]?.c || '0')
}

function asReadingTsText(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value ?? '')
}

async function fetchBatch(afterTs: string | null, afterTxid: string | null, limit: number): Promise<Candidate[]> {
  // Keyset pagination on (reading_ts ASC, txid ASC) so we never re-scan the
  // same page when rows flip to confirmed mid-run.
  // Prefer oer_unconfirmed_ts_txid_idx (partial WHERE confirmed = false).
  // Keep reading_ts as timestamptz in SQL — casting to text in SELECT made
  // plans sort on ((reading_ts)::text) and defeated the btree.
  if (afterTs == null) {
    const res = await queryWithTimeout<{ txid: string; reading_ts: Date | string }>(
      `SELECT txid, reading_ts
         FROM overlay_explorer_readings
        WHERE confirmed = false
          AND reading_ts < now() - ($1::bigint * interval '1 day')
          AND ($2::bigint = 0 OR reading_ts > now() - ($2::bigint * interval '1 day'))
        ORDER BY reading_ts ASC, txid ASC
        LIMIT $3`,
      [OLDER_THAN_DAYS, NEWER_THAN_DAYS, limit],
      FETCH_TIMEOUT_MS,
    )
    return (res.rows || []).map((row) => ({
      txid: row.txid,
      reading_ts: asReadingTsText(row.reading_ts),
    }))
  }

  const res = await queryWithTimeout<{ txid: string; reading_ts: Date | string }>(
    `SELECT txid, reading_ts
       FROM overlay_explorer_readings
      WHERE confirmed = false
        AND reading_ts < now() - ($1::bigint * interval '1 day')
        AND ($2::bigint = 0 OR reading_ts > now() - ($2::bigint * interval '1 day'))
        AND (
          reading_ts > $3::timestamptz
          OR (reading_ts = $3::timestamptz AND txid > $4::text)
        )
      ORDER BY reading_ts ASC, txid ASC
      LIMIT $5`,
    [OLDER_THAN_DAYS, NEWER_THAN_DAYS, afterTs, afterTxid, limit],
    FETCH_TIMEOUT_MS,
  )
  return (res.rows || []).map((row) => ({
    txid: row.txid,
    reading_ts: asReadingTsText(row.reading_ts),
  }))
}

/**
 * Lightweight status lookup. Prefer /status over the full /tx body — same
 * confirmation fields, far less JSON to download for OP_RETURN-heavy rows.
 */
async function lookupBitailsStatus(txid: string): Promise<LookupResult> {
  try {
    const res = await fetch(`${BITAILS_BASE}/tx/${txid}/status`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    if (res.status === 429 || res.status === 503) {
      return { txid, mined: false, blockHeight: 0, blockTime: null, rateLimited: true }
    }
    if (res.status === 404) {
      return { txid, mined: false, blockHeight: 0, blockTime: null, missing: true }
    }
    if (!res.ok) {
      return {
        txid,
        mined: false,
        blockHeight: 0,
        blockTime: null,
        error: `Bitails ${res.status}: ${(await res.text()).slice(0, 120)}`,
      }
    }
    const body = (await res.json()) as {
      status?: string
      blockheight?: number
      blockHeight?: number
      confirmations?: number
      blocktime?: number
      time?: number
    }
    const status = String(body.status ?? '').toLowerCase()
    const blockHeightRaw =
      typeof body.blockheight === 'number' ? body.blockheight :
      typeof body.blockHeight === 'number' ? body.blockHeight :
      0
    const confirmations = typeof body.confirmations === 'number' ? body.confirmations : 0
    const mined =
      status === 'confirmed'
      || blockHeightRaw > 0
      || confirmations >= 1
    const timeRaw =
      typeof body.blocktime === 'number' ? body.blocktime :
      typeof body.time === 'number' ? body.time :
      null
    return {
      txid,
      mined,
      blockHeight: blockHeightRaw > 0 ? blockHeightRaw : 0,
      blockTime: timeRaw ? new Date(timeRaw * 1000) : null,
      missing: status === 'not found' || status === 'not_found',
    }
  } catch (err) {
    return {
      txid,
      mined: false,
      blockHeight: 0,
      blockTime: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Token-bucket worker pool: up to CONCURRENCY in flight, with at most one new
 * request started every REQ_INTERVAL_MS. Keeps Bitails busy without stampeding.
 */
async function lookupMany(txids: string[]): Promise<LookupResult[]> {
  if (txids.length === 0) return []

  const results: LookupResult[] = new Array(txids.length)
  let cursor = 0
  let lastStart = 0
  let rateLimited = false

  const workers = Array.from({ length: Math.min(CONCURRENCY, txids.length) }, async () => {
    while (true) {
      if (rateLimited) return
      const idx = cursor++
      if (idx >= txids.length) return

      const gap = REQ_INTERVAL_MS - (Date.now() - lastStart)
      if (gap > 0) await sleep(gap)
      lastStart = Date.now()

      const result = await lookupBitailsStatus(txids[idx]!)
      results[idx] = result
      if (result.rateLimited) rateLimited = true
    }
  })

  await Promise.all(workers)

  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      results[i] = {
        txid: txids[i]!,
        mined: false,
        blockHeight: 0,
        blockTime: null,
        rateLimited: true,
      }
    }
  }
  return results
}

/**
 * One UPDATE for the whole mined chunk, then best-effort UTXO / tx_log flips.
 * Far cheaper than confirmReading() × N over the Supabase pooler.
 */
async function applyConfirmationsBatch(
  mined: Array<{ txid: string; blockHeight: number; blockTime: Date | null }>,
): Promise<number> {
  if (mined.length === 0) return 0

  // Fall back to the repository helper for tiny leftovers so behaviour stays
  // identical on the edges; the batched path is for the bulk of the work.
  if (mined.length === 1) {
    const row = mined[0]!
    await confirmReading(row.txid, row.blockHeight, row.blockTime)
    await query(
      `UPDATE overlay_admitted_utxos
          SET confirmed = true
        WHERE txid = $1
          AND confirmed = false`,
      [row.txid],
    )
    try {
      await query(
        `UPDATE tx_log
            SET status = 'confirmed',
                onchain_at = COALESCE(onchain_at, $2)
          WHERE txid = $1
            AND status IS DISTINCT FROM 'confirmed'`,
        [row.txid, row.blockTime ?? new Date()],
      )
    } catch {
      // Best effort — explorer row is the source of truth for UI.
    }
    return 1
  }

  const values: unknown[] = []
  const placeholders: string[] = []
  for (let i = 0; i < mined.length; i++) {
    const row = mined[i]!
    const base = i * 3
    placeholders.push(`($${base + 1}::text, $${base + 2}::int, $${base + 3}::timestamptz)`)
    values.push(row.txid, row.blockHeight, row.blockTime)
  }

  const updated = await query(
    `UPDATE overlay_explorer_readings AS r
        SET confirmed = true,
            block_height = CASE
              WHEN v.block_height > 0
                THEN GREATEST(COALESCE(r.block_height, 0), v.block_height)
              ELSE COALESCE(r.block_height, 0)
            END,
            block_time = COALESCE(v.block_time, r.block_time)
       FROM (VALUES ${placeholders.join(',')}) AS v(txid, block_height, block_time)
      WHERE r.txid = v.txid
        AND (
          NOT r.confirmed
          OR (v.block_height > 0 AND COALESCE(r.block_height, 0) < v.block_height)
        )`,
    values,
  )

  const txids = mined.map((row) => row.txid)
  await query(
    `UPDATE overlay_admitted_utxos
        SET confirmed = true
      WHERE txid = ANY($1::text[])
        AND confirmed = false`,
    [txids],
  ).catch(() => {})

  try {
    await query(
      `UPDATE tx_log AS t
          SET status = 'confirmed',
              onchain_at = COALESCE(t.onchain_at, v.block_time, now())
         FROM (VALUES ${placeholders.join(',')}) AS v(txid, block_height, block_time)
        WHERE t.txid = v.txid
          AND t.status IS DISTINCT FROM 'confirmed'`,
      values,
    )
  } catch {
    // Best effort — explorer row is the source of truth for UI.
  }

  return updated.rowCount ?? mined.length
}

function formatRate(n: number, elapsedMs: number): string {
  if (elapsedMs <= 0) return '0/s'
  return `${(n / (elapsedMs / 1000)).toFixed(1)}/s`
}

function estimateRemaining(processed: number, elapsedMs: number, remainingHint: number | null): string {
  if (processed <= 0 || elapsedMs <= 0 || remainingHint == null || remainingHint <= 0) return 'n/a'
  const rate = processed / (elapsedMs / 1000)
  if (rate <= 0) return 'n/a'
  const seconds = remainingHint / rate
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

async function runOnce(staleHint: number | null): Promise<{
  processed: number
  confirmed: number
  stillMempoolOrMissing: number
  errors: number
  rateLimited: boolean
  emptied: boolean
}> {
  let processed = 0
  let confirmed = 0
  let stillMempoolOrMissing = 0
  let errors = 0
  let rateLimited = false
  let afterTs: string | null = null
  let afterTxid: string | null = null
  const startedAt = Date.now()

  while (processed < LIMIT) {
    const need = Math.min(BATCH_SIZE, LIMIT - processed)
    const batch = await fetchBatch(afterTs, afterTxid, need)
    if (batch.length === 0) {
      return {
        processed,
        confirmed,
        stillMempoolOrMissing,
        errors,
        rateLimited,
        emptied: true,
      }
    }

    const last = batch[batch.length - 1]!
    afterTs = last.reading_ts
    afterTxid = last.txid

    if (!APPLY) {
      for (const row of batch) {
        processed++
        if (processed <= 10) {
          console.log(`  (dry-run) would check ${row.txid}  reading_ts=${row.reading_ts}`)
        }
      }
      if (processed >= Math.min(BATCH_SIZE, LIMIT)) {
        console.log(
          `  (dry-run) sampled ${processed} row(s); pass --apply to mutate up to --limit ${LIMIT}.`,
        )
        break
      }
      continue
    }

    const lookups = await lookupMany(batch.map((row) => row.txid))
    if (lookups.some((row) => row.rateLimited)) {
      rateLimited = true
      console.warn('  ⏳ rate-limited — backing off 60s, then this pass stops so you can re-run')
      await sleep(60_000)
      // Process whatever we already got before the 429, then exit the pass.
    }

    const mined: Array<{ txid: string; blockHeight: number; blockTime: Date | null }> = []
    for (const result of lookups) {
      processed++
      if (result.rateLimited && !result.mined) continue
      if (result.error) {
        errors++
        if (errors <= 10) {
          console.warn(`  ⚠️  ${result.txid.slice(0, 12)}…: ${result.error}`)
        }
        continue
      }
      if (!result.mined) {
        stillMempoolOrMissing++
        continue
      }
      mined.push({
        txid: result.txid,
        blockHeight: result.blockHeight,
        blockTime: result.blockTime,
      })
    }

    if (mined.length > 0) {
      try {
        const wrote = await applyConfirmationsBatch(mined)
        confirmed += wrote
        const lastMined = mined[mined.length - 1]!
        console.log(
          `  ✅ confirmed +${wrote.toLocaleString()} ` +
            `(total ${confirmed.toLocaleString()}) ` +
            `last ${lastMined.txid.slice(0, 12)}… height=${lastMined.blockHeight || '?'} ` +
            `rate=${formatRate(processed, Date.now() - startedAt)} ` +
            `eta=${estimateRemaining(processed, Date.now() - startedAt, staleHint == null ? null : Math.max(0, staleHint - processed))}`,
        )
      } catch (err) {
        errors++
        console.warn(
          `  ⚠️  batch write failed (${mined.length} txids): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
        // Fall back to one-by-one so a single bad row cannot stall the whole pass.
        for (const row of mined) {
          try {
            await confirmReading(row.txid, row.blockHeight, row.blockTime)
            confirmed++
          } catch (inner) {
            errors++
            console.warn(
              `  ⚠️  ${row.txid.slice(0, 12)}…: ` +
                `${inner instanceof Error ? inner.message : String(inner)}`,
            )
          }
        }
      }
    } else if (processed % 1000 < batch.length) {
      console.log(
        `  … processed ${processed.toLocaleString()} ` +
          `(confirmed ${confirmed.toLocaleString()}, missing/mempool ${stillMempoolOrMissing.toLocaleString()}) ` +
          `rate=${formatRate(processed, Date.now() - startedAt)}`,
      )
    }

    if (rateLimited || errors >= 50) break
  }

  return {
    processed,
    confirmed,
    stillMempoolOrMissing,
    errors,
    rateLimited,
    emptied: false,
  }
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  Explorer confirmation backfill')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(
    `  mode=${APPLY ? 'APPLY' : 'DRY-RUN'} olderThanDays=${OLDER_THAN_DAYS} ` +
      `newerThanDays=${NEWER_THAN_DAYS || 'none'} limit=${LIMIT} batch=${BATCH_SIZE} ` +
      `concurrency=${CONCURRENCY} reqIntervalMs=${REQ_INTERVAL_MS} ` +
      `fetchTimeoutMs=${FETCH_TIMEOUT_MS} loop=${LOOP} source=bitails-status`,
  )

  let staleHint: number | null = null
  if (COUNT || !APPLY) {
    console.log('  counting stale rows (expensive on multi-million tables)…')
    staleHint = await countStale()
    console.log(`  stale unconfirmed rows in window: ${staleHint.toLocaleString()}`)
    if (staleHint === 0) {
      console.log('  Nothing to do.')
      return
    }
  } else {
    console.log('  skipping COUNT(*) — pass --count if you want a remaining total / ETA seed')
  }

  let pass = 0
  let grandProcessed = 0
  let grandConfirmed = 0
  let grandMissing = 0
  let grandErrors = 0
  const wallStart = Date.now()

  do {
    pass++
    if (LOOP && pass > 1) {
      console.log(`\n── pass ${pass} ──`)
    }

    const result = await runOnce(staleHint)
    grandProcessed += result.processed
    grandConfirmed += result.confirmed
    grandMissing += result.stillMempoolOrMissing
    grandErrors += result.errors

    console.log('')
    console.log('───────────────────────────────────────────────────────────────')
    console.log(
      `  pass=${pass} processed=${result.processed.toLocaleString()} ` +
        `confirmed=${result.confirmed.toLocaleString()} ` +
        `notMinedOrMissing=${result.stillMempoolOrMissing.toLocaleString()} ` +
        `errors=${result.errors}`,
    )
    console.log(
      `  cumulative: processed=${grandProcessed.toLocaleString()} ` +
        `confirmed=${grandConfirmed.toLocaleString()} ` +
        `rate=${formatRate(grandProcessed, Date.now() - wallStart)}`,
    )

    if (!APPLY) {
      console.log('  Dry-run only. Re-run with --apply to write confirmations.')
      break
    }
    if (result.rateLimited) {
      console.log('  Stopped on rate-limit. Re-run shortly; lower --concurrency if it persists.')
      break
    }
    if (result.errors >= 50) {
      console.log('  Stopped after too many errors.')
      break
    }
    if (result.emptied || result.processed === 0) {
      console.log('  Window empty — backlog cleared for this filter.')
      break
    }
    if (!LOOP) {
      console.log(`  Re-run with the same flags (or add --loop) to continue (next --limit ${LIMIT}).`)
      break
    }
    // Soft pause between loop passes so a runaway cannot hammer Bitails.
    await sleep(1_000)
  } while (LOOP)

  if (COUNT && APPLY) {
    const remaining = await countStale()
    console.log(`  remaining stale unconfirmed in window: ${remaining.toLocaleString()}`)
  }
  console.log('Done.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
