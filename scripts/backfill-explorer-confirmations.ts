#!/usr/bin/env npx tsx
/**
 * Backfill confirmations for stale `overlay_explorer_readings` rows.
 *
 * Why
 * ---
 * The live confirmation worker only chases a recent window (default 72h) plus
 * a short catch-up (historically 30 days). Rows that sat at confirmed=false
 * for months — worker downtime, WoC 429s, or pre-worker history — never get
 * revisited. The explorer then shows "Unconfirmed" forever even though the
 * TX mined long ago.
 *
 * This script walks oldest-first unconfirmed explorer rows, looks up each
 * txid on Bitails (not WhatsOnChain — avoids competing with the live worker's
 * WoC quota), and applies the same idempotent confirmReading / UTXO / tx_log
 * updates the worker uses.
 *
 * Safety
 * ------
 *   - Default is DRY-RUN (counts + samples only). Pass --apply to mutate.
 *   - Safe to run while gaialog-workers is online (idempotent UPDATEs).
 *   - Self-throttled Bitails requests; backs off on 429/5xx.
 *   - Bounded by --limit and --batch-size.
 *
 * Usage
 * -----
 *   cd /opt/gaialog
 *   npx tsx scripts/backfill-explorer-confirmations.ts
 *   npx tsx scripts/backfill-explorer-confirmations.ts --apply --limit 500
 *   npx tsx scripts/backfill-explorer-confirmations.ts --apply \
 *           --older-than-days 2 --limit 5000 --req-interval-ms 250
 */

import dotenv from 'dotenv'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..')
dotenv.config({ path: path.join(repoRoot, '.env'), override: true })
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.join(repoRoot, '.env.local'), override: true })
}

import { query } from '../lib/db'
import { confirmReading } from '../lib/overlay-explorer-repository'

// ─── CLI ─────────────────────────────────────────────────────────────────────

function argValue(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

const APPLY = process.argv.includes('--apply')
const OLDER_THAN_DAYS = Math.max(0, Number(argValue('--older-than-days', '1')))
const NEWER_THAN_DAYS = Math.max(
  0,
  Number(argValue('--newer-than-days', '0')), // 0 = no lower bound (include all history)
)
const LIMIT = Math.max(1, Number(argValue('--limit', '2000')))
const BATCH_SIZE = Math.max(1, Number(argValue('--batch-size', '100')))
const REQ_INTERVAL_MS = Math.max(50, Number(argValue('--req-interval-ms', '200')))
const BITAILS_BASE = (process.env.BSV_BITAILS_API_BASE || 'https://api.bitails.io').replace(/\/$/, '')

interface Candidate {
  txid: string
  reading_ts: string
}

interface LookupResult {
  mined: boolean
  blockHeight: number
  blockTime: Date | null
  rateLimited?: boolean
}

async function sleep(ms: number): Promise<void> {
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

async function fetchBatch(afterTs: string | null, afterTxid: string | null, limit: number): Promise<Candidate[]> {
  // Keyset pagination on (reading_ts ASC, txid ASC) so we never re-scan the
  // same page when rows flip to confirmed mid-run.
  if (afterTs == null) {
    const res = await query<Candidate>(
      `SELECT txid, reading_ts::text
         FROM overlay_explorer_readings
        WHERE confirmed = false
          AND reading_ts < now() - ($1::bigint * interval '1 day')
          AND ($2::bigint = 0 OR reading_ts > now() - ($2::bigint * interval '1 day'))
        ORDER BY reading_ts ASC, txid ASC
        LIMIT $3`,
      [OLDER_THAN_DAYS, NEWER_THAN_DAYS, limit],
    )
    return res.rows || []
  }

  const res = await query<Candidate>(
    `SELECT txid, reading_ts::text
       FROM overlay_explorer_readings
      WHERE confirmed = false
        AND reading_ts < now() - ($1::bigint * interval '1 day')
        AND ($2::bigint = 0 OR reading_ts > now() - ($2::bigint * interval '1 day'))
        AND (reading_ts, txid) > ($3::timestamptz, $4::text)
      ORDER BY reading_ts ASC, txid ASC
      LIMIT $5`,
    [OLDER_THAN_DAYS, NEWER_THAN_DAYS, afterTs, afterTxid, limit],
  )
  return res.rows || []
}

async function lookupBitails(txid: string): Promise<LookupResult> {
  const res = await fetch(`${BITAILS_BASE}/tx/${txid}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  })
  if (res.status === 429 || res.status === 503) {
    return { mined: false, blockHeight: 0, blockTime: null, rateLimited: true }
  }
  if (res.status === 404) {
    return { mined: false, blockHeight: 0, blockTime: null }
  }
  if (!res.ok) {
    throw new Error(`Bitails ${res.status} for ${txid}: ${(await res.text()).slice(0, 160)}`)
  }
  const body = (await res.json()) as {
    blockheight?: number
    blockHeight?: number
    confirmations?: number
    time?: number
    blocktime?: number
  }
  const blockHeightRaw =
    typeof body.blockheight === 'number' ? body.blockheight :
    typeof body.blockHeight === 'number' ? body.blockHeight :
    0
  const confirmations = typeof body.confirmations === 'number' ? body.confirmations : 0
  const mined = blockHeightRaw > 0 || confirmations >= 1
  const timeRaw =
    typeof body.blocktime === 'number' ? body.blocktime :
    typeof body.time === 'number' ? body.time :
    null
  return {
    mined,
    blockHeight: blockHeightRaw > 0 ? blockHeightRaw : 0,
    blockTime: timeRaw ? new Date(timeRaw * 1000) : null,
  }
}

async function applyConfirmation(txid: string, blockHeight: number, blockTime: Date | null): Promise<void> {
  await confirmReading(txid, blockHeight, blockTime)
  await query(
    `UPDATE overlay_admitted_utxos
        SET confirmed = true
      WHERE txid = $1
        AND confirmed = false`,
    [txid],
  )
  try {
    // tx_log has no block_height column — only flip status / onchain_at.
    await query(
      `UPDATE tx_log
          SET status = 'confirmed',
              onchain_at = COALESCE(onchain_at, $2)
        WHERE txid = $1
          AND status IS DISTINCT FROM 'confirmed'`,
      [txid, blockTime ?? new Date()],
    )
  } catch {
    // Best effort — explorer row is the source of truth for UI.
  }
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  Explorer confirmation backfill')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`  mode=${APPLY ? 'APPLY' : 'DRY-RUN'} olderThanDays=${OLDER_THAN_DAYS} ` +
    `newerThanDays=${NEWER_THAN_DAYS || 'none'} limit=${LIMIT} batch=${BATCH_SIZE} ` +
    `reqIntervalMs=${REQ_INTERVAL_MS} source=bitails`)

  const total = await countStale()
  console.log(`  stale unconfirmed rows in window: ${total.toLocaleString()}`)
  if (total === 0) {
    console.log('  Nothing to do.')
    return
  }

  let processed = 0
  let confirmed = 0
  let stillMempoolOrMissing = 0
  let errors = 0
  let afterTs: string | null = null
  let afterTxid: string | null = null

  while (processed < LIMIT) {
    const need = Math.min(BATCH_SIZE, LIMIT - processed)
    const batch = await fetchBatch(afterTs, afterTxid, need)
    if (batch.length === 0) break

    for (const row of batch) {
      processed++
      afterTs = row.reading_ts
      afterTxid = row.txid

      if (!APPLY) {
        if (processed <= 10) {
          console.log(`  (dry-run) would check ${row.txid}  reading_ts=${row.reading_ts}`)
        }
        continue
      }

      try {
        await sleep(REQ_INTERVAL_MS)
        let status = await lookupBitails(row.txid)
        if (status.rateLimited) {
          console.warn(`  ⏳ rate-limited at ${row.txid} — sleeping 60s`)
          await sleep(60_000)
          status = await lookupBitails(row.txid)
          if (status.rateLimited) {
            console.error('  ⛔ still rate-limited — stopping. Re-run later.')
            processed--
            break
          }
        }

        if (!status.mined) {
          stillMempoolOrMissing++
          continue
        }

        await applyConfirmation(row.txid, status.blockHeight, status.blockTime)
        confirmed++
        if (confirmed % 25 === 0 || confirmed <= 5) {
          console.log(
            `  ✅ confirmed ${confirmed.toLocaleString()} ` +
              `(last ${row.txid.slice(0, 12)}… height=${status.blockHeight || '?'})`,
          )
        }
      } catch (err) {
        errors++
        console.warn(
          `  ⚠️  ${row.txid.slice(0, 12)}…: ${err instanceof Error ? err.message : String(err)}`,
        )
        if (errors >= 20) {
          console.error('  ⛔ too many errors — stopping.')
          break
        }
      }
    }

    if (!APPLY && processed >= Math.min(10, LIMIT)) {
      console.log(`  (dry-run) sampled ${processed} row(s); pass --apply to mutate up to --limit ${LIMIT}.`)
      break
    }
    if (errors >= 20) break
  }

  const remaining = await countStale()
  console.log('')
  console.log('───────────────────────────────────────────────────────────────')
  console.log(`  processed=${processed.toLocaleString()} confirmed=${confirmed.toLocaleString()} ` +
    `notMinedOrMissing=${stillMempoolOrMissing.toLocaleString()} errors=${errors}`)
  console.log(`  remaining stale unconfirmed in window: ${remaining.toLocaleString()}`)
  if (!APPLY) {
    console.log('  Dry-run only. Re-run with --apply to write confirmations.')
  } else if (remaining > 0) {
    console.log(`  Re-run with the same flags to continue (next --limit ${LIMIT}).`)
  }
  console.log('Done.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
