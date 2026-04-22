#!/usr/bin/env npx tsx
/**
 * BACKLOG CLEANUP: soft-archive `tx_log` rows that are stuck at `pending`.
 *
 * Use case
 * --------
 * Until 21bb785 (broadcaster-swap to TAAL-primary), all worker broadcasts
 * went to GorillaPool ARC first. GorillaPool's outbound peer relay was
 * silently failing — TXs sat at ANNOUNCED_TO_NETWORK in GorillaPool's
 * mempool only, never propagated to peer nodes, never mined. The
 * confirmation worker therefore never saw them on-chain and the
 * `tx_log.status` stayed at `pending` indefinitely. Over ~24h+ this
 * accumulated to roughly 3 million unrecoverable rows whose underlying
 * raw TXs will eventually be evicted from GorillaPool's mempool (and
 * never reach any miner).
 *
 * What this script does
 * ---------------------
 *   1. Finds every `tx_log` row with status='pending' AND
 *      collected_at < NOW() - INTERVAL '<--older-than-hours> hours'
 *      (default 6h — long enough that a healthy TX would have either
 *      confirmed or been retried).
 *   2. Updates them in capped batches to status='failed' with an `error`
 *      annotation that records the soft-archive reason and timestamp,
 *      bumping `retries` so any future re-broadcast attempt is visible.
 *   3. Reports per-batch progress and total impact.
 *
 * What this script does NOT do
 * ----------------------------
 *   * It does NOT touch `overlay_admitted_utxos`. Phantom UTXOs created
 *     by these failed TXs are recovered separately by
 *     `scripts/recovery-import-onchain-utxos.ts`, which reads chain
 *     truth (Bitails) rather than guessing from `tx_log`. Trying to
 *     revive UTXOs from `tx_log` alone risks double-spends if the
 *     broadcast actually succeeded but the confirmation worker missed
 *     the on-chain landing.
 *   * It does NOT delete rows. Failed rows remain queryable for
 *     forensics; the standard retention prune will reap them after a
 *     few days.
 *
 * Safety
 * ------
 *   - Default is DRY-RUN. Pass --apply to actually mutate the database.
 *   - Refuses to run while gaialog-workers is online (matches
 *     `recovery-import-onchain-utxos.ts` convention).
 *   - Idempotent: re-runs only touch rows that are still `pending` past
 *     the threshold; previously-failed rows are skipped.
 *   - Updates run in capped batches of `--batch-size` (default 50_000)
 *     in their own transactions so a long-running scan does not hold
 *     locks.
 *   - `--limit=N` caps total rows touched in a single invocation
 *     (default unlimited, but use it for first-time large backlogs to
 *     verify behaviour before letting it run free).
 *
 * Usage
 * -----
 *   pm2 stop gaialog-workers
 *   npx tsx scripts/archive-stuck-tx-log.ts                       # dry-run preview
 *   npx tsx scripts/archive-stuck-tx-log.ts --apply               # archive >6h pending
 *   npx tsx scripts/archive-stuck-tx-log.ts --apply \
 *           --older-than-hours=12 --batch-size=100000             # tune for backlog size
 *   pm2 start gaialog-workers
 *
 *   # Then refresh UTXO truth from chain:
 *   /tmp/recovery/discover-utxos.sh
 *   npx tsx scripts/recovery-import-onchain-utxos.ts --apply
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'node:path'
import { execSync } from 'node:child_process'

dotenv.config({ path: path.join(process.cwd(), '.env'), override: true })

import { attachClientErrorHandler, dbPool, query } from '../lib/db'

// ─── CLI args ────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes('--apply')
const SKIP_PM2_CHECK = process.argv.includes('--skip-pm2-check')

function parseIntArg(name: string, fallback: number, min: number): number {
  const flag = `--${name}=`
  const raw = process.argv.find((a) => a.startsWith(flag))
  if (!raw) return fallback
  const v = Number(raw.slice(flag.length))
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < min) {
    throw new Error(`Invalid --${name}: ${raw}. Must be an integer >= ${min}.`)
  }
  return v
}

const OLDER_THAN_HOURS = parseIntArg('older-than-hours', 6, 1)
const BATCH_SIZE = parseIntArg('batch-size', 50_000, 100)
const LIMIT_TOTAL = parseIntArg('limit', 0, 0) // 0 = unlimited

const ARCHIVE_REASON = `archive: stuck-pending (broadcast did not propagate, soft-archived ${new Date().toISOString()})`

// ─── PM2 guard (matches recovery-import-onchain-utxos.ts) ────────────────────

function ensureWritersStopped(): void {
  if (SKIP_PM2_CHECK) {
    console.warn('⚠️  --skip-pm2-check: not verifying that workers are stopped. Be sure!')
    return
  }
  let raw: string
  try {
    raw = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    console.warn('⚠️  Could not query PM2. Pass --skip-pm2-check if PM2 is not in use.')
    process.exit(2)
  }
  let processes: Array<{ name?: string; pm2_env?: { status?: string } }>
  try {
    processes = JSON.parse(raw)
  } catch {
    throw new Error('PM2 returned non-JSON output')
  }
  // gaialog-workers is the only writer to tx_log; overlay does not write status.
  const blockers = ['gaialog-workers']
  const running = processes
    .filter((p) => blockers.includes(String(p.name)))
    .filter((p) => p.pm2_env?.status === 'online')
    .map((p) => p.name as string)
  if (running.length > 0) {
    console.error(`❌ Refusing to run while these PM2 processes are online: ${running.join(', ')}`)
    console.error('   Stop them first:  pm2 stop ' + running.join(' '))
    process.exit(2)
  }
  console.log('✅ PM2 check: gaialog-workers is stopped.')
}

// ─── Pre-flight snapshot ─────────────────────────────────────────────────────

interface BacklogSnapshot {
  total_pending: number
  pending_within_threshold: number
  pending_past_threshold: number
  oldest_pending: string | null
  newest_past_threshold: string | null
  failed_already: number
  confirmed_total: number
}

async function captureSnapshot(): Promise<BacklogSnapshot> {
  const res = await query<{
    total_pending: string
    pending_within_threshold: string
    pending_past_threshold: string
    oldest_pending: string | null
    newest_past_threshold: string | null
    failed_already: string
    confirmed_total: string
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::text                                                AS total_pending,
       COUNT(*) FILTER (WHERE status = 'pending' AND collected_at >= NOW() - ($1 || ' hours')::interval)::text AS pending_within_threshold,
       COUNT(*) FILTER (WHERE status = 'pending' AND collected_at <  NOW() - ($1 || ' hours')::interval)::text AS pending_past_threshold,
       MIN(collected_at) FILTER (WHERE status = 'pending')                                              AS oldest_pending,
       MAX(collected_at) FILTER (WHERE status = 'pending' AND collected_at < NOW() - ($1 || ' hours')::interval) AS newest_past_threshold,
       COUNT(*) FILTER (WHERE status = 'failed')::text                                                  AS failed_already,
       COUNT(*) FILTER (WHERE status = 'confirmed')::text                                               AS confirmed_total
     FROM tx_log`,
    [String(OLDER_THAN_HOURS)],
  )
  const row = res.rows[0]
  return {
    total_pending: Number(row?.total_pending ?? 0),
    pending_within_threshold: Number(row?.pending_within_threshold ?? 0),
    pending_past_threshold: Number(row?.pending_past_threshold ?? 0),
    oldest_pending: row?.oldest_pending ?? null,
    newest_past_threshold: row?.newest_past_threshold ?? null,
    failed_already: Number(row?.failed_already ?? 0),
    confirmed_total: Number(row?.confirmed_total ?? 0),
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-GB')
}

function printSnapshot(label: string, snap: BacklogSnapshot): void {
  console.log('')
  console.log(`  ${label}`)
  console.log('  ' + '─'.repeat(60))
  console.log(`  pending (total)            : ${fmt(snap.total_pending)}`)
  console.log(`  pending (>= ${OLDER_THAN_HOURS}h, eligible) : ${fmt(snap.pending_past_threshold)}`)
  console.log(`  pending (<  ${OLDER_THAN_HOURS}h, retained) : ${fmt(snap.pending_within_threshold)}`)
  console.log(`  failed (already)           : ${fmt(snap.failed_already)}`)
  console.log(`  confirmed (total)          : ${fmt(snap.confirmed_total)}`)
  if (snap.oldest_pending) {
    console.log(`  oldest pending             : ${snap.oldest_pending}`)
  }
  if (snap.newest_past_threshold) {
    console.log(`  newest eligible            : ${snap.newest_past_threshold}`)
  }
}

// ─── Archive loop ────────────────────────────────────────────────────────────

async function archivePastThresholdInBatches(): Promise<{
  batchesRun: number
  rowsArchived: number
  hitLimit: boolean
}> {
  let totalArchived = 0
  let batches = 0
  let hitLimit = false

  while (true) {
    const remainingBudget = LIMIT_TOTAL > 0 ? LIMIT_TOTAL - totalArchived : Number.POSITIVE_INFINITY
    if (remainingBudget <= 0) {
      hitLimit = true
      break
    }
    const thisBatch = Math.min(BATCH_SIZE, remainingBudget)

    // Single statement per batch in its own implicit transaction. The
    // CTE selects-and-locks a bounded slice (FOR UPDATE SKIP LOCKED) so
    // we never block the confirmation worker on a long table scan, and
    // we never UPDATE-then-LIMIT (which Postgres does not support
    // directly) — the CTE bounds the slice instead.
    const client = await dbPool.connect()
    attachClientErrorHandler(client)
    let updated = 0
    try {
      const sql = `
        WITH stuck AS (
          SELECT txid
            FROM tx_log
           WHERE status = 'pending'
             AND collected_at < NOW() - ($1 || ' hours')::interval
           ORDER BY collected_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        UPDATE tx_log AS t
           SET status  = 'failed',
               error   = $3,
               retries = t.retries + 1
          FROM stuck
         WHERE t.txid = stuck.txid
        RETURNING t.txid
      `
      const startedAt = Date.now()
      const res = await client.query<{ txid: string }>(sql, [
        String(OLDER_THAN_HOURS),
        thisBatch,
        ARCHIVE_REASON,
      ])
      updated = res.rowCount ?? 0
      const tookMs = Date.now() - startedAt
      batches++
      totalArchived += updated
      console.log(
        `  batch ${batches}: archived ${fmt(updated)} rows in ${tookMs}ms ` +
          `(running total: ${fmt(totalArchived)})`,
      )
    } finally {
      client.release()
    }

    if (updated < thisBatch) {
      // The batch returned fewer rows than the cap, so there is nothing
      // left to archive at this threshold.
      break
    }
    if (LIMIT_TOTAL > 0 && totalArchived >= LIMIT_TOTAL) {
      hitLimit = true
      break
    }
  }

  return { batchesRun: batches, rowsArchived: totalArchived, hitLimit }
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('')
  console.log(`Mode             : ${APPLY ? 'APPLY (will mutate tx_log)' : 'DRY-RUN (read-only)'}`)
  console.log(`Older-than       : ${OLDER_THAN_HOURS} hours`)
  console.log(`Batch size       : ${fmt(BATCH_SIZE)}`)
  console.log(`Limit (total)    : ${LIMIT_TOTAL > 0 ? fmt(LIMIT_TOTAL) : 'unlimited'}`)
  console.log(`Reason annotation: ${ARCHIVE_REASON}`)

  ensureWritersStopped()

  const before = await captureSnapshot()
  printSnapshot('Pre-archive snapshot', before)

  if (before.pending_past_threshold === 0) {
    console.log('')
    console.log('Nothing to do — no pending rows past the threshold.')
    return
  }

  if (!APPLY) {
    console.log('')
    console.log(
      `(dry-run) — would archive up to ${
        LIMIT_TOTAL > 0
          ? `min(${fmt(before.pending_past_threshold)}, ${fmt(LIMIT_TOTAL)})`
          : fmt(before.pending_past_threshold)
      } rows in batches of ${fmt(BATCH_SIZE)}.`,
    )
    console.log('Re-run with --apply to perform the archive.')
    return
  }

  console.log('')
  console.log('Archiving …')
  const result = await archivePastThresholdInBatches()

  const after = await captureSnapshot()
  printSnapshot('Post-archive snapshot', after)

  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Archive complete')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  batches run    : ${fmt(result.batchesRun)}`)
  console.log(`  rows archived  : ${fmt(result.rowsArchived)}`)
  console.log(
    `  delta pending  : ${fmt(before.total_pending)} → ${fmt(after.total_pending)} ` +
      `(-${fmt(before.total_pending - after.total_pending)})`,
  )
  console.log(
    `  delta failed   : ${fmt(before.failed_already)} → ${fmt(after.failed_already)} ` +
      `(+${fmt(after.failed_already - before.failed_already)})`,
  )
  if (result.hitLimit) {
    console.log('')
    console.log(
      `⚠️  Hit --limit=${fmt(LIMIT_TOTAL)} cap. ${fmt(after.pending_past_threshold)} rows still ` +
        'past the threshold — re-run to continue.',
    )
  }

  console.log('')
  console.log('Next steps:')
  console.log('  1. Re-import on-chain UTXO truth so workers stop chaining onto phantom outputs:')
  console.log('     /tmp/recovery/discover-utxos.sh')
  console.log('     npx tsx scripts/recovery-import-onchain-utxos.ts            # dry-run')
  console.log('     npx tsx scripts/recovery-import-onchain-utxos.ts --apply')
  console.log('  2. Restart workers:')
  console.log('     pm2 start gaialog-workers --update-env')
  console.log('  3. Watch the new TAAL-primary broadcast path confirm cleanly:')
  console.log("     pm2 logs gaialog-workers --raw | grep -E 'taal_arc phase=accepted|writeToChain ok'")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Backlog archive failed:', err)
    process.exit(1)
  })
