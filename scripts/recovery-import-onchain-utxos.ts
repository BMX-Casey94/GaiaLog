#!/usr/bin/env npx tsx
/**
 * RECOVERY: import on-chain unspent UTXOs into overlay_admitted_utxos.
 *
 * Use case
 * --------
 * The system optimistically inserts change outputs into overlay_admitted_utxos
 * with confirmed=false at broadcast time, then expects the confirmation worker
 * to flip them to confirmed=true once they land in a block. If broadcasts
 * silently land in orphan mempool (e.g. BSV_ARC_ACCEPT_ORPHAN_MEMPOOL=true
 * was misconfigured), the system happily chains new broadcasts on phantom
 * outputs forever and our DB drifts arbitrarily far from on-chain reality.
 *
 * This script is the recovery path:
 *
 *   1. Soft-archive every confirmed=false, removed=false row (mark
 *      removed=true, removed_at=now()) so workers stop picking them.
 *      Rows are *not* deleted — they remain queryable for forensics, and
 *      the nightly retention prune will reap them after a few days.
 *
 *   2. Bulk-insert (or upsert) the on-chain unspent set as
 *      confirmed=true, removed=false rows so workers can resume
 *      broadcasting on real, mineable UTXOs.
 *
 *   3. Verify counts and totals per wallet.
 *
 * Inputs
 * ------
 * Newline-delimited JSON files, one per wallet, at:
 *   /tmp/recovery/W1.utxos.json
 *   /tmp/recovery/W2.utxos.json
 *   /tmp/recovery/W3.utxos.json
 *
 * Each line:
 *   {"wallet":"W1","addr":"13S6zUA...","txid":"<hex>","vout":<int>,"satoshis":<int>}
 *
 * Generate them with /tmp/recovery/discover-utxos.sh (Bitails enumeration).
 *
 * Safety
 * ------
 *   - Default is DRY-RUN. Pass --apply to actually mutate the database.
 *   - Archive + insert run in a single transaction per wallet so partial
 *     failure does not leave the system half-recovered.
 *   - INSERT uses ON CONFLICT DO UPDATE so re-running after a crash is safe.
 *   - Refuses to run unless gaialog-workers and gaialog-utxo-replenish are
 *     stopped (checked via PM2's CLI), so we do not race against live writers.
 *
 * Usage
 * -----
 *   pm2 stop gaialog-workers gaialog-utxo-replenish
 *   /tmp/recovery/discover-utxos.sh                       # builds the JSON files
 *   npx tsx scripts/recovery-import-onchain-utxos.ts      # dry-run preview
 *   npx tsx scripts/recovery-import-onchain-utxos.ts --apply
 *   pm2 start gaialog-workers gaialog-utxo-replenish      # resume
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'
import { execSync } from 'node:child_process'

// Load the production env so DB credentials are picked up regardless of how
// the script was invoked (e.g. via npm script vs raw npx).
dotenv.config({ path: path.join(process.cwd(), '.env'), override: true })

import { P2PKH } from '@bsv/sdk'
import { query, dbPool } from '../lib/db'
import { getTreasuryTopicForWallet } from '../lib/treasury-topics'

// ─── Config ──────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes('--apply')
const SKIP_PM2_CHECK = process.argv.includes('--skip-pm2-check')
const RECOVERY_DIR = '/tmp/recovery'
const INSERT_BATCH_SIZE = 500
const WALLETS: Array<{
  name: 'W1' | 'W2' | 'W3'
  walletIndex: 0 | 1 | 2
  address: string
  inputFile: string
}> = [
  { name: 'W1', walletIndex: 0, address: '13S6zUA88PtDNy9DKHZuh3QQmy4d4eN4Se', inputFile: 'W1.utxos.json' },
  { name: 'W2', walletIndex: 1, address: '127HLeWpr66JU3SDmQJ9dmjBo6RgNsRU1w', inputFile: 'W2.utxos.json' },
  { name: 'W3', walletIndex: 2, address: '1Jm2t7cmarKskV65UsigAr7tveS5WhPdJS', inputFile: 'W3.utxos.json' },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface DiscoveredUtxo {
  wallet: string
  addr: string
  txid: string
  vout: number
  satoshis: number
}

function buildP2PKHHex(address: string): string {
  const script = new P2PKH().lock(address)
  const hex = script.toHex()
  if (!/^76a914[0-9a-f]{40}88ac$/i.test(hex)) {
    throw new Error(`Generated script for ${address} is not P2PKH: ${hex}`)
  }
  return hex.toLowerCase()
}

function isValidUtxo(u: unknown): u is DiscoveredUtxo {
  if (!u || typeof u !== 'object') return false
  const o = u as Record<string, unknown>
  if (typeof o.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(o.txid)) return false
  if (typeof o.vout !== 'number' || !Number.isInteger(o.vout) || o.vout < 0) return false
  if (typeof o.satoshis !== 'number' || !Number.isInteger(o.satoshis) || o.satoshis < 1) return false
  return true
}

async function readUtxoFile(filePath: string): Promise<DiscoveredUtxo[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing input file: ${filePath}. Run /tmp/recovery/discover-utxos.sh first.`)
  }
  const utxos: DiscoveredUtxo[] = []
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, 'utf8'),
    crlfDelay: Infinity,
  })
  let lineNo = 0
  for await (const line of rl) {
    lineNo++
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (e) {
      throw new Error(`${filePath}:${lineNo}: invalid JSON — ${(e as Error).message}`)
    }
    if (!isValidUtxo(parsed)) {
      throw new Error(`${filePath}:${lineNo}: row failed validation: ${trimmed}`)
    }
    utxos.push(parsed)
  }
  return utxos
}

function deduplicateByOutpoint(utxos: DiscoveredUtxo[]): DiscoveredUtxo[] {
  const seen = new Set<string>()
  const out: DiscoveredUtxo[] = []
  for (const u of utxos) {
    const key = `${u.txid}:${u.vout}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(u)
  }
  return out
}

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
  const blockers = ['gaialog-workers', 'gaialog-utxo-replenish']
  const running = processes
    .filter((p) => blockers.includes(String(p.name)))
    .filter((p) => p.pm2_env?.status === 'online')
    .map((p) => p.name as string)
  if (running.length > 0) {
    console.error(`❌ Refusing to run while these PM2 processes are online: ${running.join(', ')}`)
    console.error('   Stop them first:  pm2 stop ' + running.join(' '))
    process.exit(2)
  }
  console.log('✅ PM2 check: gaialog-workers and gaialog-utxo-replenish are stopped.')
}

// ─── Per-wallet recovery ─────────────────────────────────────────────────────

interface WalletRecoveryStats {
  wallet: string
  walletIndex: number
  topic: string
  outputScriptHex: string
  utxoCount: number
  totalSats: number
  archivedRows: number
  insertedRows: number
  updatedRows: number
}

async function recoverWallet(
  wallet: typeof WALLETS[number],
  client: import('pg').PoolClient,
): Promise<WalletRecoveryStats> {
  const topic = getTreasuryTopicForWallet(wallet.walletIndex)
  const outputScriptHex = buildP2PKHHex(wallet.address)

  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  ${wallet.name}  (wallet_index=${wallet.walletIndex}, topic=${topic})`)
  console.log(`  address  : ${wallet.address}`)
  console.log(`  P2PKH    : ${outputScriptHex}`)
  console.log('═══════════════════════════════════════════════════════════')

  const filePath = path.join(RECOVERY_DIR, wallet.inputFile)
  const allUtxos = await readUtxoFile(filePath)
  const utxos = deduplicateByOutpoint(allUtxos)
  if (utxos.length !== allUtxos.length) {
    console.warn(`⚠️  Removed ${allUtxos.length - utxos.length} duplicate outpoints.`)
  }
  const totalSats = utxos.reduce((acc, u) => acc + u.satoshis, 0)
  console.log(`  inputs   : ${utxos.length} unique UTXOs, ${totalSats} sats`)

  if (!APPLY) {
    console.log(`  (dry-run) — would soft-archive phantom UTXOs and upsert ${utxos.length} real UTXOs`)
    return {
      wallet: wallet.name,
      walletIndex: wallet.walletIndex,
      topic,
      outputScriptHex,
      utxoCount: utxos.length,
      totalSats,
      archivedRows: 0,
      insertedRows: 0,
      updatedRows: 0,
    }
  }

  const archivedRows = await archivePhantomUtxos(client, topic)
  console.log(`  archived : ${archivedRows} phantom UTXOs (set removed=true)`)

  const { inserted, updated } = await upsertRealUtxos(
    client,
    topic,
    wallet.walletIndex,
    outputScriptHex,
    utxos,
  )
  console.log(`  inserted : ${inserted} new rows`)
  console.log(`  updated  : ${updated} existing rows (revived from removed)`)

  return {
    wallet: wallet.name,
    walletIndex: wallet.walletIndex,
    topic,
    outputScriptHex,
    utxoCount: utxos.length,
    totalSats,
    archivedRows,
    insertedRows: inserted,
    updatedRows: updated,
  }
}

async function archivePhantomUtxos(
  client: import('pg').PoolClient,
  topic: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE overlay_admitted_utxos
        SET removed = true,
            removed_at = COALESCE(removed_at, now()),
            spending_txid = COALESCE(spending_txid, 'phantom-orphan-archive'),
            locked = false,
            locked_by = NULL,
            locked_at = NULL
      WHERE topic = $1
        AND confirmed = false
        AND removed = false`,
    [topic],
  )
  return result.rowCount ?? 0
}

async function upsertRealUtxos(
  client: import('pg').PoolClient,
  topic: string,
  walletIndex: number,
  outputScriptHex: string,
  utxos: DiscoveredUtxo[],
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0
  let updated = 0

  for (let i = 0; i < utxos.length; i += INSERT_BATCH_SIZE) {
    const batch = utxos.slice(i, i + INSERT_BATCH_SIZE)

    // Multi-row VALUES with ON CONFLICT DO UPDATE so a re-run safely
    // brings rows back from removed=true and refreshes confirmed=true.
    // We include acquirable_at = now() so workers can immediately pick
    // these UTXOs without waiting for the propagation grace window.
    const values: string[] = []
    const params: unknown[] = []
    for (const u of batch) {
      const offset = params.length
      values.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, NULL, NULL::jsonb, true, $${offset + 6}, 'pool', false, NULL, NULL, false, NULL, NULL, now())`,
      )
      params.push(topic, u.txid, u.vout, u.satoshis, outputScriptHex, walletIndex)
    }

    const sql = `
      INSERT INTO overlay_admitted_utxos
        (topic, txid, vout, satoshis, output_script, raw_tx, beef,
         confirmed, wallet_index, utxo_role, locked, locked_by, locked_at,
         removed, removed_at, spending_txid, acquirable_at)
      VALUES ${values.join(',')}
      ON CONFLICT (topic, txid, vout) DO UPDATE SET
        satoshis      = EXCLUDED.satoshis,
        output_script = EXCLUDED.output_script,
        confirmed     = true,
        wallet_index  = EXCLUDED.wallet_index,
        utxo_role     = EXCLUDED.utxo_role,
        locked        = false,
        locked_by     = NULL,
        locked_at     = NULL,
        removed       = false,
        removed_at    = NULL,
        spending_txid = NULL,
        acquirable_at = now()
      RETURNING (xmax = 0) AS was_inserted
    `
    const res = await client.query<{ was_inserted: boolean }>(sql, params)
    for (const row of res.rows) {
      if (row.was_inserted) inserted++
      else updated++
    }

    if ((i + batch.length) % 5000 === 0 || i + batch.length >= utxos.length) {
      console.log(`    progress: ${i + batch.length}/${utxos.length}`)
    }
  }

  return { inserted, updated }
}

// ─── Verification ────────────────────────────────────────────────────────────

async function verifyFinalState(stats: WalletRecoveryStats[]): Promise<void> {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Post-recovery verification')
  console.log('═══════════════════════════════════════════════════════════')

  for (const s of stats) {
    const result = await query<{
      live_confirmed: string
      live_unconfirmed: string
      removed: string
      live_sats: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE removed = false AND confirmed = true)::text  AS live_confirmed,
         COUNT(*) FILTER (WHERE removed = false AND confirmed = false)::text AS live_unconfirmed,
         COUNT(*) FILTER (WHERE removed = true)::text                         AS removed,
         COALESCE(SUM(satoshis) FILTER (WHERE removed = false AND confirmed = true), 0)::text AS live_sats
       FROM overlay_admitted_utxos
       WHERE topic = $1`,
      [s.topic],
    )
    const row = result.rows[0]
    if (!row) {
      console.error(`  ❌ ${s.wallet}: no rows returned (topic=${s.topic})`)
      continue
    }
    const liveConfirmed = Number(row.live_confirmed)
    const liveSats = Number(row.live_sats)
    const ok = liveConfirmed === s.utxoCount && liveSats === s.totalSats
    console.log(
      `  ${ok ? '✅' : '❌'} ${s.wallet}  live_confirmed=${liveConfirmed} (expected ${s.utxoCount})  ` +
        `live_sats=${liveSats} (expected ${s.totalSats})  unconfirmed=${row.live_unconfirmed}  removed=${row.removed}`,
    )
  }
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('')
  console.log(`Mode: ${APPLY ? 'APPLY (will mutate DB)' : 'DRY-RUN (read-only)'}`)
  console.log(`Source dir: ${RECOVERY_DIR}`)

  ensureWritersStopped()

  const allStats: WalletRecoveryStats[] = []

  if (APPLY) {
    // Use ONE dedicated client for the whole run so we can disable the
    // per-row trigger that would otherwise full-scan the topic on every
    // single inserted row (~85+ minutes on 169k inserts).
    //
    // ALTER TABLE ... DISABLE TRIGGER takes an ACCESS EXCLUSIVE lock and
    // affects all sessions. That is safe here because we have already
    // verified the workers are stopped. The try/finally guarantees the
    // trigger is re-enabled even if the script crashes mid-load.
    const client = await dbPool.connect()
    let triggerDisabled = false
    try {
      console.log('')
      console.log('Disabling overlay_topic_counts_apply trigger for bulk load…')
      await client.query(
        `ALTER TABLE overlay_admitted_utxos DISABLE TRIGGER trg_overlay_topic_counts_apply`,
      )
      triggerDisabled = true

      for (const wallet of WALLETS) {
        const stats = await recoverWallet(wallet, client)
        allStats.push(stats)
      }

      console.log('')
      console.log('Refreshing overlay_topic_counts for each wallet topic…')
      for (const stats of allStats) {
        await client.query(`SELECT refresh_overlay_topic_counts($1)`, [stats.topic])
      }
    } finally {
      if (triggerDisabled) {
        try {
          await client.query(
            `ALTER TABLE overlay_admitted_utxos ENABLE TRIGGER trg_overlay_topic_counts_apply`,
          )
          console.log('Re-enabled overlay_topic_counts_apply trigger.')
        } catch (reEnableErr) {
          console.error(
            '❌ FAILED to re-enable trigger trg_overlay_topic_counts_apply. ' +
              'Run this manually before resuming workers:\n' +
              '   ALTER TABLE overlay_admitted_utxos ENABLE TRIGGER trg_overlay_topic_counts_apply;',
          )
          console.error(reEnableErr)
        }
      }
      client.release()
    }

    await verifyFinalState(allStats)
  } else {
    for (const wallet of WALLETS) {
      // Dry-run path doesn't touch the DB beyond reads — passing a fresh
      // ad-hoc client would be overkill, so we use the pool directly.
      const fakeClient = {
        query: (text: string, params?: unknown[]) => query(text, params as any[]),
      } as unknown as import('pg').PoolClient
      const stats = await recoverWallet(wallet, fakeClient)
      allStats.push(stats)
    }
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Summary')
  console.log('═══════════════════════════════════════════════════════════')
  let totalUtxos = 0
  let totalSats = 0
  let totalArchived = 0
  let totalInserted = 0
  let totalUpdated = 0
  for (const s of allStats) {
    totalUtxos += s.utxoCount
    totalSats += s.totalSats
    totalArchived += s.archivedRows
    totalInserted += s.insertedRows
    totalUpdated += s.updatedRows
    console.log(
      `  ${s.wallet}: ${s.utxoCount} UTXOs, ${s.totalSats} sats  ` +
        `(archived=${s.archivedRows} inserted=${s.insertedRows} updated=${s.updatedRows})`,
    )
  }
  console.log('  ' + '─'.repeat(60))
  console.log(
    `  TOTAL: ${totalUtxos} UTXOs, ${totalSats} sats  ` +
      `(archived=${totalArchived} inserted=${totalInserted} updated=${totalUpdated})`,
  )

  if (!APPLY) {
    console.log('')
    console.log('Re-run with --apply to perform the recovery.')
  } else {
    console.log('')
    console.log('Recovery complete. Next steps:')
    console.log('  1. pm2 start gaialog-workers --update-env  (start at low concurrency)')
    console.log('  2. Watch for confirmations:')
    console.log('     pm2 logs gaialog-workers --raw 2>/dev/null | grep "writeToChain ok"')
    console.log('  3. Pick one TXID and verify it confirms on-chain within ~30 minutes:')
    console.log('     curl -sS https://api.bitails.io/output/<txid>/<vout> | jq')
    console.log('  4. Once confirmed, ramp BSV_QUEUE_CONCURRENCY back up to target.')
    console.log('  5. Re-enable gaialog-utxo-replenish.')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Recovery failed:', err)
    process.exit(1)
  })
