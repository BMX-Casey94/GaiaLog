#!/usr/bin/env npx tsx
/**
 * Consolidate (and optionally rebalance) the per-wallet UTXO inventory in
 * `overlay_admitted_utxos`.
 *
 * Why this exists
 * ---------------
 * Repeated splits and broadcasts grind a wallet's inventory into hundreds of
 * thousands of dust-sized fragments (≤ ~2,000 sats each). Once every UTXO is
 * smaller than `BSV_UTXO_SPLIT_OUTPUT_SATS × 2 + fee + dust` (~4,156 sats by
 * default), the in-process splitter (`lib/utxo-maintainer.ts`) has no
 * splittable input and the system silently starves — even though the wallet's
 * total balance may still be substantial.
 *
 * This script consolidates many small UTXOs back into a small number of large
 * outputs the maintainer can split again. Each batched consolidation:
 *
 *   1. Picks N (default 5,000) confirmed live UTXOs from one wallet, smallest
 *      first, and atomically marks them locked.
 *   2. Builds one `N inputs → 1 output` P2PKH transaction signed by that
 *      wallet's private key, with the explicit fee at `BSV_TX_FEE_RATE`.
 *   3. Broadcasts via the same ARC path used by the splitter (GorillaPool →
 *      TAAL → WoC fallback chain in `lib/broadcast-raw-tx.ts`).
 *   4. On `ok`: marks all N inputs `removed=true, spending_txid=<txid>` and
 *      admits the new big output as a `reserve` UTXO so the maintainer picks
 *      it up on its next cycle.
 *   5. On failure: releases the N locks (with a cooldown) so a re-run can
 *      retry without operator intervention.
 *
 * Optional `--rebalance` second phase
 * -----------------------------------
 * After consolidation, computes the average wallet balance and issues
 * `1 input → 2 output` transfers from over-target wallets to the most
 * under-target wallet, until every wallet is within ±REBALANCE_TOLERANCE_PCT
 * (default 1%) of the average. Each transfer also lands as a `reserve` UTXO
 * in the recipient wallet's overlay row so the splitter picks it up
 * immediately.
 *
 * Safety
 * ------
 *   - DRY-RUN by default. Pass `--apply` to actually broadcast and mutate.
 *   - Race-safe with live workers: `FOR UPDATE SKIP LOCKED` + `locked=true`
 *     plumbing is identical to `lib/utxo-inventory.ts:acquireInventoryUtxo`,
 *     so `gaialog-workers` may continue to broadcast against UTXOs this
 *     script has not yet locked.
 *   - Per-batch atomic: the lock + broadcast + admit cycle is idempotent.
 *     A partially-completed run (network drop mid-broadcast) leaves at most
 *     one batch's worth of UTXOs reserved by an expired lock owner — those
 *     locks are reaped naturally once the lock TTL expires (workers just
 *     skip them in the meantime).
 *   - Dry-run never touches the network or DB writes.
 *
 * Usage
 * -----
 *   pm2 logs gaialog-workers --lines 50          # confirm system state
 *   npx tsx scripts/consolidate-wallet-utxos.ts                     # dry-run all wallets
 *   npx tsx scripts/consolidate-wallet-utxos.ts --apply             # apply all wallets
 *   npx tsx scripts/consolidate-wallet-utxos.ts --apply --rebalance # apply + balance
 *   npx tsx scripts/consolidate-wallet-utxos.ts --apply --wallet W2 # one wallet only
 *   npx tsx scripts/consolidate-wallet-utxos.ts --apply --batch-size 3000
 *   npx tsx scripts/consolidate-wallet-utxos.ts --apply --include-unconfirmed
 *   npx tsx scripts/consolidate-wallet-utxos.ts --apply --min-input-sats 50
 *
 * Economically-spendable floor (--min-input-sats)
 * -----------------------------------------------
 * Each input costs ~SIGNED_P2PKH_INPUT_BYTES × feeRate sats to spend (~15.3
 * sats at 0.1025 sat/byte). UTXOs below ~2× this value are net-loss to
 * consolidate (you pay more in fees than the input is worth). The script
 * therefore filters them out of every batch by default. Override with
 * `--min-input-sats 0` to consolidate everything regardless of economics
 * (useful for cleaning up the inventory table even at a small BSV cost).
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'node:path'
import * as bsvLib from 'bsv'
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'

// Load production env so DB credentials / WIFs are present regardless of
// how the script is invoked (npm script vs raw npx).
dotenv.config({ path: path.join(process.cwd(), '.env'), override: true })

import { bsvConfig } from '../lib/bsv-config'
import { attachClientErrorHandler, dbPool } from '../lib/db'
import { broadcastSplitTransactionRaw } from '../lib/broadcast-raw-tx'
import { getTreasuryTopicForWallet } from '../lib/treasury-topics'
import { getLockOwnerId } from '../lib/utxo-locks'
import { withOverlayTransaction, refreshTopicCounts } from '../lib/overlay-repository'

// ─── CLI parsing ──────────────────────────────────────────────────────────────

interface CliOptions {
  apply: boolean
  rebalance: boolean
  walletFilter: 'W1' | 'W2' | 'W3' | null
  batchSize: number
  includeUnconfirmed: boolean
  feeRate: number
  rebalanceTolerancePct: number
  // Floor at which UTXOs are economically worth spending. Per-input cost is
  // SIGNED_P2PKH_INPUT_BYTES × feeRate sats; below ~2× that, batches go
  // negative (fee > inputs) and the operator burns money cleaning up dust.
  // A null sentinel means "auto" — derived from feeRate at runtime.
  minInputSats: number | null
  // Minimum age (in seconds) an UNCONFIRMED UTXO must have spent in the
  // inventory before this script will spend it. Stops us picking up
  // splitter-produced outputs while their parent transaction is still
  // propagating across ARC relays — production saw "Missing inputs" 400s
  // from WoC when consolidating fresh maintainer outputs at 0s grace.
  unconfirmedMinAgeSeconds: number
  // Maximum CONSECUTIVE batch broadcast failures before we give up on a
  // wallet. A single failure (often transient — ARC 504, fetch failed) used
  // to abort the entire wallet. We now treat each batch independently.
  maxConsecutiveFailures: number
}

function parseArgs(argv: string[]): CliOptions {
  const apply = argv.includes('--apply')
  const rebalance = argv.includes('--rebalance')
  const includeUnconfirmed = argv.includes('--include-unconfirmed')

  const walletArg = takeValue(argv, '--wallet')
  const walletFilter =
    walletArg === 'W1' || walletArg === 'W2' || walletArg === 'W3' ? walletArg : null
  if (walletArg && !walletFilter) {
    throw new Error(`--wallet must be one of W1, W2, W3 (got "${walletArg}")`)
  }

  const batchSizeRaw = Number(takeValue(argv, '--batch-size') || '5000')
  if (!Number.isFinite(batchSizeRaw) || batchSizeRaw < 50 || batchSizeRaw > 8000) {
    throw new Error(`--batch-size must be between 50 and 8000 (got ${batchSizeRaw})`)
  }

  const feeRateRaw = Number(
    takeValue(argv, '--fee-rate') ||
      process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ||
      process.env.BSV_TX_FEE_RATE ||
      '0.105',
  )
  if (!Number.isFinite(feeRateRaw) || feeRateRaw <= 0) {
    throw new Error(`--fee-rate must be > 0 (got ${feeRateRaw})`)
  }

  const tolPctRaw = Number(takeValue(argv, '--rebalance-tolerance-pct') || '1')
  if (!Number.isFinite(tolPctRaw) || tolPctRaw < 0.1 || tolPctRaw > 50) {
    throw new Error(`--rebalance-tolerance-pct must be between 0.1 and 50 (got ${tolPctRaw})`)
  }

  const minInputSatsArg = takeValue(argv, '--min-input-sats')
  let minInputSats: number | null = null
  if (minInputSatsArg !== null) {
    const parsed = Number(minInputSatsArg)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`--min-input-sats must be ≥ 0 (got ${minInputSatsArg})`)
    }
    minInputSats = Math.floor(parsed)
  }

  const unconfirmedMinAgeArg = takeValue(argv, '--unconfirmed-min-age-seconds')
  const unconfirmedMinAge = unconfirmedMinAgeArg === null ? 60 : Number(unconfirmedMinAgeArg)
  if (!Number.isFinite(unconfirmedMinAge) || unconfirmedMinAge < 0 || unconfirmedMinAge > 3600) {
    throw new Error(
      `--unconfirmed-min-age-seconds must be between 0 and 3600 (got ${unconfirmedMinAgeArg})`,
    )
  }

  const maxFailuresArg = takeValue(argv, '--max-consecutive-failures')
  const maxFailures = maxFailuresArg === null ? 3 : Number(maxFailuresArg)
  if (!Number.isFinite(maxFailures) || maxFailures < 1 || maxFailures > 50) {
    throw new Error(
      `--max-consecutive-failures must be between 1 and 50 (got ${maxFailuresArg})`,
    )
  }

  return {
    apply,
    rebalance,
    walletFilter,
    batchSize: Math.floor(batchSizeRaw),
    includeUnconfirmed,
    feeRate: feeRateRaw,
    rebalanceTolerancePct: tolPctRaw,
    minInputSats,
    unconfirmedMinAgeSeconds: Math.floor(unconfirmedMinAge),
    maxConsecutiveFailures: Math.floor(maxFailures),
  }
}

// Per-input cost in sats given the current fee rate. Inputs below this value
// always lose money to spend. We default --min-input-sats to ~2× this so the
// batch as a whole nets at least ~1 sat per input above its share of the fee.
function autoMinInputSats(feeRate: number): number {
  return Math.max(1, Math.ceil(SIGNED_P2PKH_INPUT_BYTES * feeRate * 2))
}

function effectiveMinInputSats(options: CliOptions): number {
  return options.minInputSats !== null ? options.minInputSats : autoMinInputSats(options.feeRate)
}

function takeValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag)
  if (idx === -1) return null
  const val = argv[idx + 1]
  if (!val || val.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return val
}

// ─── Wallet bindings (WIF + address + topic per wallet index) ────────────────

interface WalletBinding {
  walletIndex: number
  label: 'W1' | 'W2' | 'W3'
  wif: string
  address: string
  outputScriptHex: string
  topic: string
}

function deriveBindings(): WalletBinding[] {
  const wifs = (bsvConfig?.wallets?.privateKeys || []).filter((k): k is string => !!k)
  if (wifs.length === 0) {
    throw new Error('No BSV wallet private keys configured (BSV_WALLET_*_PRIVATE_KEY)')
  }
  return wifs.slice(0, 3).map((wif, walletIndex) => {
    const sdkKey = SDKPrivateKey.fromWif(wif)
    const address = sdkKey.toPublicKey().toAddress().toString()
    const pubKeyHash = Buffer.from(sdkKey.toPublicKey().toHash()).toString('hex')
    const outputScriptHex = `76a914${pubKeyHash}88ac`
    return {
      walletIndex,
      label: `W${walletIndex + 1}` as 'W1' | 'W2' | 'W3',
      wif,
      address,
      outputScriptHex,
      topic: getTreasuryTopicForWallet(walletIndex),
    }
  })
}

// ─── Fee maths (must mirror lib/utxo-maintainer.ts) ──────────────────────────

const SIGNED_P2PKH_INPUT_BYTES = 149 // worst-case (high-S signature variance)
const P2PKH_OUTPUT_BYTES = 34 // 8 value + 1 scriptLen + 25 script
const TX_BASE_BYTES_BASE = 12 // 4 version + 4 locktime + minimum varint counts

function txOverheadBytes(numInputs: number, numOutputs: number): number {
  // input/output count varints scale: 1 byte ≤ 252, 3 bytes ≤ 65535, 5 bytes ≤ 2^32.
  // We round up generously: assume 3-byte varints when N > 252 to size the fee
  // safely, and 5-byte when N > 65535. This over-fees by ≤ 4 bytes per varint
  // on small txs, which is negligible.
  const inVarBytes = numInputs > 65535 ? 5 : numInputs > 252 ? 3 : 1
  const outVarBytes = numOutputs > 65535 ? 5 : numOutputs > 252 ? 3 : 1
  return 4 /* version */ + inVarBytes + outVarBytes + 4 /* locktime */
}

function estimateTxSize(numInputs: number, numOutputs: number): number {
  return (
    txOverheadBytes(numInputs, numOutputs) +
    numInputs * SIGNED_P2PKH_INPUT_BYTES +
    numOutputs * P2PKH_OUTPUT_BYTES
  )
}

function estimateFee(numInputs: number, numOutputs: number, feeRate: number): number {
  return Math.ceil(estimateTxSize(numInputs, numOutputs) * feeRate)
}

// ─── Per-wallet snapshots ────────────────────────────────────────────────────

interface WalletSnapshot {
  binding: WalletBinding
  liveUtxos: number
  confirmedUtxos: number
  largestSats: number
  largestConfirmedSats: number
  totalLiveSats: number
  totalConfirmedSats: number
  eligibleSats: number // sats this script will actually try to consolidate
  eligibleUtxos: number // count this script will actually try to consolidate
}

async function snapshotWallet(
  binding: WalletBinding,
  includeUnconfirmed: boolean,
  minInputSats: number,
  unconfirmedMinAgeSeconds: number,
): Promise<WalletSnapshot> {
  const res = await withOverlayTransaction(async (client) => {
    return client.query<{
      live_utxos: string
      confirmed_utxos: string
      largest_sats: string
      largest_confirmed_sats: string
      total_live_sats: string
      total_confirmed_sats: string
      eligible_sats: string
      eligible_utxos: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE removed = false)::text                                                      AS live_utxos,
         COUNT(*) FILTER (WHERE removed = false AND confirmed = true)::text                                 AS confirmed_utxos,
         COALESCE(MAX(satoshis) FILTER (WHERE removed = false), 0)::text                                    AS largest_sats,
         COALESCE(MAX(satoshis) FILTER (WHERE removed = false AND confirmed = true), 0)::text               AS largest_confirmed_sats,
         COALESCE(SUM(satoshis) FILTER (WHERE removed = false), 0)::text                                    AS total_live_sats,
         COALESCE(SUM(satoshis) FILTER (WHERE removed = false AND confirmed = true), 0)::text               AS total_confirmed_sats,
         COALESCE(SUM(satoshis) FILTER (WHERE removed = false
                                           AND locked = false
                                           AND satoshis >= $3
                                           AND ($2::boolean = true OR confirmed = true)
                                           AND (confirmed = true OR admitted_at <= now() - ($4::bigint * interval '1 second'))
                                          ), 0)::text AS eligible_sats,
         COUNT(*) FILTER (WHERE removed = false
                            AND locked = false
                            AND satoshis >= $3
                            AND ($2::boolean = true OR confirmed = true)
                            AND (confirmed = true OR admitted_at <= now() - ($4::bigint * interval '1 second'))
                         )::text AS eligible_utxos
       FROM overlay_admitted_utxos
       WHERE wallet_index = $1`,
      [
        binding.walletIndex,
        includeUnconfirmed,
        Math.max(0, Math.floor(minInputSats)),
        Math.max(0, Math.floor(unconfirmedMinAgeSeconds)),
      ],
    )
  })
  const row = res.rows[0]
  return {
    binding,
    liveUtxos: Number(row?.live_utxos || '0'),
    confirmedUtxos: Number(row?.confirmed_utxos || '0'),
    largestSats: Number(row?.largest_sats || '0'),
    largestConfirmedSats: Number(row?.largest_confirmed_sats || '0'),
    totalLiveSats: Number(row?.total_live_sats || '0'),
    totalConfirmedSats: Number(row?.total_confirmed_sats || '0'),
    eligibleSats: Number(row?.eligible_sats || '0'),
    eligibleUtxos: Number(row?.eligible_utxos || '0'),
  }
}

// ─── Lock / unlock primitives (race-safe with live workers) ──────────────────

interface LockedInput {
  topic: string
  txid: string
  vout: number
  satoshis: number
  output_script: string
}

async function lockBatch(
  binding: WalletBinding,
  batchSize: number,
  includeUnconfirmed: boolean,
  minInputSats: number,
  unconfirmedMinAgeSeconds: number,
  lockedBy: string,
): Promise<LockedInput[]> {
  return withOverlayTransaction(async (client) => {
    // Statement timeout guard: very large LIMIT + ORDER BY satoshis can be
    // slow on a heavily bloated table. Bound it so we fail loud rather than
    // hold a pool client hostage.
    await client.query(`SET LOCAL statement_timeout = 30000`)
    const res = await client.query<{
      topic: string
      txid: string
      vout: number
      satoshis: string
      output_script: string
    }>(
      `WITH candidates AS (
         SELECT topic, txid, vout
           FROM overlay_admitted_utxos
          WHERE wallet_index = $1
            AND removed = false
            AND locked = false
            AND satoshis >= $5
            AND ($2::boolean = true OR confirmed = true)
            AND acquirable_at <= now()
            -- Unconfirmed inputs must have aged at least N seconds in the
            -- inventory before we spend them. This prevents us picking up
            -- splitter-produced outputs whose parents have not yet
            -- propagated to all ARC relays (production saw WoC reject
            -- with "Missing inputs" 400 at 0s grace). Confirmed rows
            -- are exempt — their parent is already in a block.
            AND (confirmed = true OR admitted_at <= now() - ($6::bigint * interval '1 second'))
          ORDER BY satoshis ASC, admitted_at ASC, txid ASC, vout ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $3
       )
       UPDATE overlay_admitted_utxos u
          SET locked = true,
              locked_by = $4,
              locked_at = now()
         FROM candidates c
        WHERE u.topic = c.topic AND u.txid = c.txid AND u.vout = c.vout
       RETURNING u.topic, u.txid, u.vout, u.satoshis, u.output_script`,
      [
        binding.walletIndex,
        includeUnconfirmed,
        batchSize,
        lockedBy,
        Math.max(0, Math.floor(minInputSats)),
        Math.max(0, Math.floor(unconfirmedMinAgeSeconds)),
      ],
    )
    return res.rows.map((row) => ({
      topic: row.topic,
      txid: row.txid,
      vout: row.vout,
      satoshis: Number(row.satoshis),
      output_script: row.output_script,
    }))
  })
}

async function releaseBatch(
  inputs: LockedInput[],
  lockedBy: string,
  cooldownMs: number,
): Promise<void> {
  if (inputs.length === 0) return
  await withOverlayTransaction(async (client) => {
    // Build (topic,txid,vout) tuple lists for a single bulk update.
    const topics = inputs.map((i) => i.topic)
    const txids = inputs.map((i) => i.txid)
    const vouts = inputs.map((i) => i.vout)
    await client.query(
      `UPDATE overlay_admitted_utxos u
          SET locked = false,
              locked_by = NULL,
              locked_at = NULL,
              acquirable_at = GREATEST(acquirable_at, now() + ($5::bigint * interval '1 millisecond'))
         FROM unnest($1::text[], $2::text[], $3::int[]) AS t(topic, txid, vout)
        WHERE u.topic = t.topic
          AND u.txid = t.txid
          AND u.vout = t.vout
          AND u.locked = true
          AND ($4::text = '' OR u.locked_by = $4)`,
      [topics, txids, vouts, lockedBy, cooldownMs],
    )
  })
}

// ─── Atomic admit: mark inputs spent + insert new output (one DB tx) ─────────

interface AdmittedOutput {
  vout: number
  satoshis: number
  outputScript: string
  walletIndex: number
  topic: string
  utxoRole: 'reserve' | 'pool'
  confirmed: boolean
}

async function commitConsolidation(input: {
  inputs: LockedInput[]
  spendingTxid: string
  rawTx: string
  output: AdmittedOutput
}): Promise<void> {
  await withOverlayTransaction(async (client) => {
    // Mark all inputs as spent (single bulk UPDATE).
    const topics = input.inputs.map((i) => i.topic)
    const txids = input.inputs.map((i) => i.txid)
    const vouts = input.inputs.map((i) => i.vout)
    const removed = await client.query(
      `UPDATE overlay_admitted_utxos u
          SET removed = true,
              removed_at = now(),
              spending_txid = $4,
              locked = false,
              locked_by = NULL,
              locked_at = NULL
         FROM unnest($1::text[], $2::text[], $3::int[]) AS t(topic, txid, vout)
        WHERE u.topic = t.topic
          AND u.txid = t.txid
          AND u.vout = t.vout
          AND u.removed = false
        RETURNING u.topic`,
      [topics, txids, vouts, input.spendingTxid],
    )
    if ((removed.rowCount || 0) !== input.inputs.length) {
      throw new Error(
        `commitConsolidation: expected to mark ${input.inputs.length} inputs spent, only marked ${removed.rowCount || 0}. Aborting.`,
      )
    }

    // Insert the new consolidated output as confirmed=false (it just hit
    // the network this instant). The maintainer will pick it up on its
    // next cycle as soon as the propagation grace expires (default 2.5s).
    await client.query(
      `INSERT INTO overlay_admitted_utxos (
         topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed,
         wallet_index, utxo_role, locked, locked_by, locked_at,
         removed, removed_at, spending_txid, acquirable_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NULL, false,
               $7, $8, false, NULL, NULL,
               false, NULL, NULL, now() + interval '2500 milliseconds')
       ON CONFLICT (topic, txid, vout) DO UPDATE SET
         satoshis = EXCLUDED.satoshis,
         output_script = EXCLUDED.output_script,
         raw_tx = EXCLUDED.raw_tx,
         confirmed = false,
         wallet_index = EXCLUDED.wallet_index,
         utxo_role = EXCLUDED.utxo_role,
         removed = false,
         removed_at = NULL,
         spending_txid = NULL,
         locked = false,
         locked_by = NULL,
         locked_at = NULL,
         acquirable_at = EXCLUDED.acquirable_at`,
      [
        input.output.topic,
        input.spendingTxid,
        input.output.vout,
        input.output.satoshis,
        input.output.outputScript,
        input.rawTx,
        input.output.walletIndex,
        input.output.utxoRole,
      ],
    )

    // Net effect on topic count: -inputs.length + 1 (one big output replaces N).
    const delta = 1 - input.inputs.length
    await refreshTopicCounts(client, input.output.topic, delta)
  })
}

// ─── Tx builder: many inputs → one output (consolidation) ────────────────────

interface BuiltTx {
  rawHex: string
  fee: number
  outputSats: number
  txSizeBytes: number
}

function buildConsolidationTx(
  binding: WalletBinding,
  inputs: LockedInput[],
  feeRate: number,
): BuiltTx {
  const txSizeBytes = estimateTxSize(inputs.length, 1)
  const fee = Math.ceil(txSizeBytes * feeRate)
  const inputSum = inputs.reduce((acc, i) => acc + i.satoshis, 0)
  const outputSats = inputSum - fee
  if (outputSats <= 1) {
    throw new Error(
      `Refusing to build consolidation TX with outputSats=${outputSats} (inputSum=${inputSum} - fee=${fee}). Increase batch size or check inputs.`,
    )
  }

  const tx = new (bsvLib as any).Transaction()
  tx.from(
    inputs.map((i) => ({
      txId: i.txid,
      outputIndex: i.vout,
      address: binding.address,
      script: i.output_script,
      satoshis: i.satoshis,
    })),
  )
  tx.to(binding.address, outputSats)
  // No change output: we already accounted for the entire input sum minus fee.
  tx.fee(fee)
  const signingKey = (bsvLib as any).PrivateKey.fromWIF(binding.wif)
  tx.sign(signingKey)
  const rawHex = tx.serialize()
  return { rawHex, fee, outputSats, txSizeBytes }
}

// ─── Tx builder: one input → two outputs (rebalance transfer) ────────────────

function buildTransferTx(
  donor: WalletBinding,
  recipientAddress: string,
  inputs: LockedInput[],
  donateSats: number,
  feeRate: number,
): { rawHex: string; fee: number; donateSats: number; changeSats: number; txSizeBytes: number } {
  if (inputs.length === 0) throw new Error('buildTransferTx: no inputs')
  const txSizeBytes = estimateTxSize(inputs.length, 2)
  const fee = Math.ceil(txSizeBytes * feeRate)
  const inputSum = inputs.reduce((acc, i) => acc + i.satoshis, 0)
  const changeSats = inputSum - donateSats - fee
  if (changeSats <= 1) {
    throw new Error(
      `Refusing to build transfer TX with changeSats=${changeSats} (inputSum=${inputSum} donate=${donateSats} fee=${fee}).`,
    )
  }
  const tx = new (bsvLib as any).Transaction()
  tx.from(
    inputs.map((i) => ({
      txId: i.txid,
      outputIndex: i.vout,
      address: donor.address,
      script: i.output_script,
      satoshis: i.satoshis,
    })),
  )
  tx.to(recipientAddress, donateSats)
  tx.to(donor.address, changeSats)
  tx.fee(fee)
  const signingKey = (bsvLib as any).PrivateKey.fromWIF(donor.wif)
  tx.sign(signingKey)
  const rawHex = tx.serialize()
  return { rawHex, fee, donateSats, changeSats, txSizeBytes }
}

// ─── Phase 1: per-wallet consolidation ───────────────────────────────────────

interface ConsolidationStats {
  binding: WalletBinding
  batches: number
  inputsSpent: number
  satsConsolidated: number
  feesPaid: number
  txids: string[]
}

async function consolidateWallet(
  binding: WalletBinding,
  options: CliOptions,
  lockedBy: string,
): Promise<ConsolidationStats> {
  const stats: ConsolidationStats = {
    binding,
    batches: 0,
    inputsSpent: 0,
    satsConsolidated: 0,
    feesPaid: 0,
    txids: [],
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log(`  Consolidating ${binding.label}  (${binding.address})`)
  console.log('═══════════════════════════════════════════════════════════════════')

  const minInputSats = effectiveMinInputSats(options)
  let batchNo = 0
  let consecutiveFailures = 0
  while (true) {
    batchNo += 1
    const inputs = await lockBatch(
      binding,
      options.batchSize,
      options.includeUnconfirmed,
      minInputSats,
      options.unconfirmedMinAgeSeconds,
      lockedBy,
    )
    if (inputs.length === 0) {
      console.log(`  Batch #${batchNo}: no more eligible UTXOs — wallet ${binding.label} done.`)
      break
    }

    const inputSum = inputs.reduce((acc, i) => acc + i.satoshis, 0)
    const fee = estimateFee(inputs.length, 1, options.feeRate)
    const outputSats = inputSum - fee
    const txSizeBytes = estimateTxSize(inputs.length, 1)

    console.log(
      `  Batch #${batchNo}: locked ${inputs.length.toLocaleString()} input(s)  ` +
        `inputSum=${inputSum.toLocaleString()} sats  ` +
        `fee=${fee.toLocaleString()} sats  ` +
        `output=${outputSats.toLocaleString()} sats  ` +
        `txSize≈${(txSizeBytes / 1024).toFixed(1)} KB`,
    )

    if (outputSats <= 1) {
      console.warn(
        `  ⚠️  Batch #${batchNo}: outputSats=${outputSats} — releasing locks and skipping. ` +
          `Inputs are economically unspendable (per-input fee ≈ ${Math.ceil(SIGNED_P2PKH_INPUT_BYTES * options.feeRate)} sats > average input value). ` +
          `Try \`--min-input-sats ${Math.ceil(SIGNED_P2PKH_INPUT_BYTES * options.feeRate * 3)}\` and/or ` +
          `\`--include-unconfirmed\` if larger UTXOs exist in the unconfirmed set.`,
      )
      await releaseBatch(inputs, lockedBy, 60_000)
      break
    }

    if (!options.apply) {
      console.log(`  Batch #${batchNo}: (dry-run) — releasing locks, no broadcast.`)
      await releaseBatch(inputs, lockedBy, 0)
      stats.batches += 1
      stats.inputsSpent += inputs.length
      stats.satsConsolidated += outputSats
      stats.feesPaid += fee
      // For dry-run we stop after the first batch per wallet to avoid locking
      // the same UTXOs repeatedly under SKIP LOCKED — once is enough to give
      // the operator an accurate per-batch cost preview.
      console.log(
        `  Batch #${batchNo}: (dry-run) — stopping after first batch. ` +
          `Pass --apply to process all ${Math.ceil(stats.inputsSpent || inputs.length)} eligible UTXOs.`,
      )
      break
    }

    let built: BuiltTx
    try {
      built = buildConsolidationTx(binding, inputs, options.feeRate)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  ❌ Batch #${batchNo}: build failed — ${message}. Releasing locks.`)
      await releaseBatch(inputs, lockedBy, 60_000)
      // Build failures are deterministic on the same inputs; abort the wallet.
      throw err
    }

    let txid: string
    try {
      txid = await broadcastSplitTransactionRaw(built.rawHex)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const transient = classifyBroadcastError(message)
      consecutiveFailures += 1
      console.error(
        `  ❌ Batch #${batchNo}: broadcast failed (${transient.label}) — ${message.split('\n')[0].substring(0, 200)}. ` +
          `Releasing locks (${Math.round(transient.cooldownMs / 1000)}s cooldown). ` +
          `Consecutive failures: ${consecutiveFailures}/${options.maxConsecutiveFailures}.`,
      )
      if (transient.hint) console.error(`     hint: ${transient.hint}`)
      await releaseBatch(inputs, lockedBy, transient.cooldownMs)
      if (consecutiveFailures >= options.maxConsecutiveFailures) {
        console.error(
          `  ⛔ Wallet ${binding.label}: ${consecutiveFailures} consecutive broadcast failures — ` +
            `giving up on this wallet. ${stats.batches} batch(es) succeeded before this. ` +
            `Re-run with the same flags to retry the remainder.`,
        )
        break
      }
      // Wait briefly before next batch attempt to let upstream issues clear.
      await new Promise((r) => setTimeout(r, transient.preBatchSleepMs))
      continue
    }

    try {
      await commitConsolidation({
        inputs,
        spendingTxid: txid,
        rawTx: built.rawHex,
        output: {
          vout: 0,
          satoshis: built.outputSats,
          outputScript: binding.outputScriptHex,
          walletIndex: binding.walletIndex,
          topic: binding.topic,
          utxoRole: 'reserve',
          confirmed: false,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The TX is on-chain; we just failed to update the DB. This is recoverable
      // by re-running the recovery import, but we surface it loudly so the
      // operator does not assume the inventory is consistent.
      console.error(
        `  ⚠️  Batch #${batchNo}: TX ${txid} BROADCAST OK but DB commit failed — ${message}. ` +
          `Inputs remain locked; releasing locks. Re-run /tmp/recovery/discover-utxos.sh + ` +
          `\`scripts/recovery-import-onchain-utxos.ts --apply\` to reconcile.`,
      )
      await releaseBatch(inputs, lockedBy, 60_000)
      // Hard abort: an on-chain TX with stale DB state must be reconciled
      // before continuing, otherwise the next batch may double-spend.
      throw err
    }

    consecutiveFailures = 0
    stats.batches += 1
    stats.inputsSpent += inputs.length
    stats.satsConsolidated += built.outputSats
    stats.feesPaid += built.fee
    stats.txids.push(txid)
    console.log(
      `  ✅ Batch #${batchNo}: txid=${txid} broadcast and admitted as reserve UTXO.`,
    )

    // If we got back fewer rows than we asked for, no more eligible UTXOs exist.
    if (inputs.length < options.batchSize) {
      console.log(`  Batch #${batchNo}: partial batch — wallet ${binding.label} done.`)
      break
    }
  }

  return stats
}

interface BroadcastErrorClassification {
  label: 'transient' | 'missing-inputs' | 'mempool-chain' | 'unknown'
  cooldownMs: number
  preBatchSleepMs: number
  hint: string | null
}

function classifyBroadcastError(message: string): BroadcastErrorClassification {
  const lower = message.toLowerCase()
  if (lower.includes('missing inputs') || lower.includes('missing-inputs')) {
    return {
      label: 'missing-inputs',
      cooldownMs: 5 * 60_000,
      preBatchSleepMs: 5_000,
      hint:
        'WoC reports an input does not exist on-chain — likely an unconfirmed parent that has not yet propagated. ' +
        'Increase --unconfirmed-min-age-seconds (default 60) so we wait longer before consolidating fresh splitter outputs.',
    }
  }
  if (lower.includes('mempool_chain_limit') || lower.includes('too-long-mempool-chain')) {
    return {
      label: 'mempool-chain',
      cooldownMs: 10 * 60_000,
      preBatchSleepMs: 30_000,
      hint:
        'Mempool chain depth limit hit — wait for a block to confirm the chain. ' +
        'Re-running in ~10 minutes should clear this.',
    }
  }
  if (lower.includes('504') || lower.includes('fetch failed') || lower.includes('etimedout') || lower.includes('econnreset')) {
    return {
      label: 'transient',
      cooldownMs: 60_000,
      preBatchSleepMs: 5_000,
      hint: 'Likely upstream/network transient — next batch should succeed.',
    }
  }
  return {
    label: 'unknown',
    cooldownMs: 2 * 60_000,
    preBatchSleepMs: 10_000,
    hint: null,
  }
}

// ─── Phase 2: cross-wallet rebalancing ───────────────────────────────────────

/**
 * Locks the largest spendable UTXOs in `binding` until the cumulative sum
 * reaches `targetSats`, OR until `maxInputs` UTXOs have been picked.
 *
 * Returns the picked inputs (already locked in the DB). If the wallet has no
 * single + accumulated combination capable of reaching `targetSats`, the
 * partial set is still returned so the caller can release locks and report
 * the actual largest sum available.
 *
 * Skips dust below `minPerInputSats` so small inputs never drag the batch
 * into a net-loss fee position.
 */
async function lockLargestUtxosForAmount(input: {
  binding: WalletBinding
  targetSats: number
  maxInputs: number
  minPerInputSats: number
  unconfirmedMinAgeSeconds: number
  includeUnconfirmed: boolean
  lockedBy: string
}): Promise<LockedInput[]> {
  return withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = 30000`)
    const res = await client.query<{
      topic: string
      txid: string
      vout: number
      satoshis: string
      output_script: string
    }>(
      `WITH ranked AS (
         SELECT topic, txid, vout, satoshis, output_script,
                SUM(satoshis) OVER (ORDER BY satoshis DESC, admitted_at ASC, txid ASC, vout ASC ROWS UNBOUNDED PRECEDING) AS running_sum,
                ROW_NUMBER() OVER (ORDER BY satoshis DESC, admitted_at ASC, txid ASC, vout ASC) AS rn
           FROM overlay_admitted_utxos
          WHERE wallet_index = $1
            AND removed = false
            AND locked = false
            AND satoshis >= $2
            AND ($5::boolean = true OR confirmed = true)
            AND (confirmed = true OR admitted_at <= now() - ($6::bigint * interval '1 second'))
            AND acquirable_at <= now()
       ),
       candidates AS (
         SELECT topic, txid, vout
           FROM ranked
          WHERE rn <= $3
            AND (running_sum - satoshis) < $4   -- keep adding until cumulative covers target
       )
       UPDATE overlay_admitted_utxos u
          SET locked = true,
              locked_by = $7,
              locked_at = now()
         FROM candidates c
        WHERE u.topic = c.topic AND u.txid = c.txid AND u.vout = c.vout
          AND u.locked = false
       RETURNING u.topic, u.txid, u.vout, u.satoshis, u.output_script`,
      [
        input.binding.walletIndex,
        Math.max(0, Math.floor(input.minPerInputSats)),
        Math.max(1, Math.floor(input.maxInputs)),
        Math.max(1, Math.floor(input.targetSats)),
        input.includeUnconfirmed,
        Math.max(0, Math.floor(input.unconfirmedMinAgeSeconds)),
        input.lockedBy,
      ],
    )
    return res.rows
      .map((row) => ({
        topic: row.topic,
        txid: row.txid,
        vout: row.vout,
        satoshis: Number(row.satoshis),
        output_script: row.output_script,
      }))
      .sort((a, b) => b.satoshis - a.satoshis)
  })
}

async function commitTransfer(input: {
  donorBinding: WalletBinding
  recipientBinding: WalletBinding
  donorInputs: LockedInput[]
  spendingTxid: string
  rawTx: string
  donateSats: number
  changeSats: number
}): Promise<void> {
  await withOverlayTransaction(async (client) => {
    // 1) Mark all donor inputs as spent (single bulk UPDATE).
    const topics = input.donorInputs.map((i) => i.topic)
    const txids = input.donorInputs.map((i) => i.txid)
    const vouts = input.donorInputs.map((i) => i.vout)
    const removed = await client.query(
      `UPDATE overlay_admitted_utxos u
          SET removed = true,
              removed_at = now(),
              spending_txid = $4,
              locked = false,
              locked_by = NULL,
              locked_at = NULL
         FROM unnest($1::text[], $2::text[], $3::int[]) AS t(topic, txid, vout)
        WHERE u.topic = t.topic
          AND u.txid = t.txid
          AND u.vout = t.vout
          AND u.removed = false
        RETURNING u.topic`,
      [topics, txids, vouts, input.spendingTxid],
    )
    if ((removed.rowCount || 0) !== input.donorInputs.length) {
      throw new Error(
        `commitTransfer: expected ${input.donorInputs.length} inputs spent, marked ${removed.rowCount || 0}`,
      )
    }

    // 2) Insert recipient output (vout 0) into recipient's topic.
    await client.query(
      `INSERT INTO overlay_admitted_utxos (
         topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed,
         wallet_index, utxo_role, locked, locked_by, locked_at,
         removed, removed_at, spending_txid, acquirable_at
       )
       VALUES ($1, $2, 0, $3, $4, $5, NULL, false,
               $6, 'reserve', false, NULL, NULL,
               false, NULL, NULL, now() + interval '2500 milliseconds')
       ON CONFLICT (topic, txid, vout) DO UPDATE SET
         satoshis = EXCLUDED.satoshis,
         output_script = EXCLUDED.output_script,
         raw_tx = EXCLUDED.raw_tx,
         confirmed = false,
         wallet_index = EXCLUDED.wallet_index,
         utxo_role = 'reserve',
         removed = false,
         removed_at = NULL,
         spending_txid = NULL,
         locked = false,
         locked_by = NULL,
         locked_at = NULL,
         acquirable_at = EXCLUDED.acquirable_at`,
      [
        input.recipientBinding.topic,
        input.spendingTxid,
        input.donateSats,
        input.recipientBinding.outputScriptHex,
        input.rawTx,
        input.recipientBinding.walletIndex,
      ],
    )

    // 3) Insert donor change output (vout 1) into donor's topic.
    await client.query(
      `INSERT INTO overlay_admitted_utxos (
         topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed,
         wallet_index, utxo_role, locked, locked_by, locked_at,
         removed, removed_at, spending_txid, acquirable_at
       )
       VALUES ($1, $2, 1, $3, $4, $5, NULL, false,
               $6, 'reserve', false, NULL, NULL,
               false, NULL, NULL, now() + interval '2500 milliseconds')
       ON CONFLICT (topic, txid, vout) DO UPDATE SET
         satoshis = EXCLUDED.satoshis,
         output_script = EXCLUDED.output_script,
         raw_tx = EXCLUDED.raw_tx,
         confirmed = false,
         wallet_index = EXCLUDED.wallet_index,
         utxo_role = 'reserve',
         removed = false,
         removed_at = NULL,
         spending_txid = NULL,
         locked = false,
         locked_by = NULL,
         locked_at = NULL,
         acquirable_at = EXCLUDED.acquirable_at`,
      [
        input.donorBinding.topic,
        input.spendingTxid,
        input.changeSats,
        input.donorBinding.outputScriptHex,
        input.rawTx,
        input.donorBinding.walletIndex,
      ],
    )

    // Topic-count effect: donor lost N inputs + 1 change output → delta = 1 - N
    //                     recipient gained 1 output → delta = +1
    await refreshTopicCounts(client, input.donorBinding.topic, 1 - input.donorInputs.length)
    await refreshTopicCounts(client, input.recipientBinding.topic, 1)
  })
}

interface RebalanceStats {
  transfers: Array<{
    donor: 'W1' | 'W2' | 'W3'
    recipient: 'W1' | 'W2' | 'W3'
    donateSats: number
    feeSats: number
    txid: string
  }>
}

async function rebalanceWallets(
  bindings: WalletBinding[],
  options: CliOptions,
  lockedBy: string,
): Promise<RebalanceStats> {
  const stats: RebalanceStats = { transfers: [] }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('  Phase 2: cross-wallet rebalance')
  console.log('═══════════════════════════════════════════════════════════════════')

  const minInputSats = effectiveMinInputSats(options)
  const MAX_PASSES = 12
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const snapshots = await Promise.all(
      bindings.map((b) =>
        snapshotWallet(b, options.includeUnconfirmed, minInputSats, options.unconfirmedMinAgeSeconds),
      ),
    )
    const totalSats = snapshots.reduce((acc, s) => acc + s.totalLiveSats, 0)
    const target = Math.floor(totalSats / snapshots.length)
    const tolerance = Math.floor((target * options.rebalanceTolerancePct) / 100)

    console.log('')
    console.log(`  Pass ${pass}: target=${target.toLocaleString()} sats per wallet  (±${tolerance.toLocaleString()} tolerance)`)
    for (const s of snapshots) {
      const delta = s.totalLiveSats - target
      const tag = Math.abs(delta) <= tolerance ? '✅ ok' : delta > 0 ? `+${delta.toLocaleString()} surplus` : `${delta.toLocaleString()} deficit`
      console.log(`    ${s.binding.label}: ${s.totalLiveSats.toLocaleString()} sats  ${tag}`)
    }

    const sorted = [...snapshots].sort((a, b) => b.totalLiveSats - a.totalLiveSats)
    const richest = sorted[0]
    const poorest = sorted[sorted.length - 1]
    const surplus = richest.totalLiveSats - target
    const deficit = target - poorest.totalLiveSats

    if (surplus <= tolerance && deficit <= tolerance) {
      console.log('  ✅ All wallets within tolerance — rebalance complete.')
      break
    }

    const donateSats = Math.min(surplus, deficit)
    if (donateSats < 10_000) {
      console.log(`  ⏸  Smallest required transfer ${donateSats} sats < 10,000 floor — stopping.`)
      break
    }

    if (richest.binding.label === poorest.binding.label) {
      console.log('  ⏸  Richest == poorest — nothing to do.')
      break
    }

    // Multi-input transfer: pick largest reserves until cumulative sum
    // covers donateSats + fee + 1. Cap at MAX_TRANSFER_INPUTS so the TX
    // stays under typical ARC body limits (~5,000 inputs ≈ 745 KB).
    const MAX_TRANSFER_INPUTS = 5000
    // Rough fee for a multi-input estimate; we'll re-derive once we know
    // exactly how many inputs we got back.
    const provisionalFee = estimateFee(MAX_TRANSFER_INPUTS, 2, options.feeRate)
    const targetSum = donateSats + provisionalFee + 1
    const donorInputs = await lockLargestUtxosForAmount({
      binding: richest.binding,
      targetSats: targetSum,
      maxInputs: MAX_TRANSFER_INPUTS,
      minPerInputSats: minInputSats,
      unconfirmedMinAgeSeconds: options.unconfirmedMinAgeSeconds,
      includeUnconfirmed: options.includeUnconfirmed,
      lockedBy,
    })

    const lockedSum = donorInputs.reduce((acc, i) => acc + i.satoshis, 0)
    const exactFee = estimateFee(donorInputs.length, 2, options.feeRate)
    const minViableSum = donateSats + exactFee + 1

    if (donorInputs.length === 0 || lockedSum < minViableSum) {
      console.warn(
        `  ⚠️  Pass ${pass}: ${richest.binding.label} can only marshal ${lockedSum.toLocaleString()} sats ` +
          `from ${donorInputs.length} input(s) (need ≥ ${minViableSum.toLocaleString()} sats: ` +
          `${donateSats.toLocaleString()} donation + ${exactFee.toLocaleString()} fee). ` +
          `Run another consolidation pass to produce larger reserves, then re-run --rebalance.`,
      )
      if (donorInputs.length > 0) await releaseBatch(donorInputs, lockedBy, 0)
      break
    }

    if (!options.apply) {
      console.log(
        `  (dry-run) Would transfer ${donateSats.toLocaleString()} sats: ` +
          `${richest.binding.label} (${donorInputs.length} input(s) totalling ${lockedSum.toLocaleString()}) → ` +
          `${poorest.binding.label}  fee=${exactFee.toLocaleString()} sats  ` +
          `change=${(lockedSum - donateSats - exactFee).toLocaleString()} sats`,
      )
      await releaseBatch(donorInputs, lockedBy, 0)
      break
    }

    let built
    try {
      built = buildTransferTx(richest.binding, poorest.binding.address, donorInputs, donateSats, options.feeRate)
    } catch (err) {
      console.error(
        `  ❌ Pass ${pass}: transfer build failed — ${err instanceof Error ? err.message : String(err)}. Releasing locks.`,
      )
      await releaseBatch(donorInputs, lockedBy, 60_000)
      throw err
    }

    let txid: string
    try {
      txid = await broadcastSplitTransactionRaw(built.rawHex)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const transient = classifyBroadcastError(message)
      console.error(
        `  ❌ Pass ${pass}: transfer broadcast failed (${transient.label}) — ${message.split('\n')[0].substring(0, 200)}. ` +
          `Releasing locks (${Math.round(transient.cooldownMs / 1000)}s cooldown).`,
      )
      if (transient.hint) console.error(`     hint: ${transient.hint}`)
      await releaseBatch(donorInputs, lockedBy, transient.cooldownMs)
      // Stop the rebalance loop — same-pass retry against the same surplus
      // would lock the same UTXOs and likely hit the same upstream issue.
      break
    }

    try {
      await commitTransfer({
        donorBinding: richest.binding,
        recipientBinding: poorest.binding,
        donorInputs,
        spendingTxid: txid,
        rawTx: built.rawHex,
        donateSats: built.donateSats,
        changeSats: built.changeSats,
      })
    } catch (err) {
      console.error(
        `  ⚠️  Pass ${pass}: transfer ${txid} BROADCAST OK but DB commit failed — ` +
          `${err instanceof Error ? err.message : String(err)}. Re-run discover + recovery-import to reconcile.`,
      )
      throw err
    }

    stats.transfers.push({
      donor: richest.binding.label,
      recipient: poorest.binding.label,
      donateSats: built.donateSats,
      feeSats: built.fee,
      txid,
    })
    console.log(
      `  ✅ Pass ${pass}: txid=${txid}  ${richest.binding.label} → ${poorest.binding.label}  ` +
        `inputs=${donorInputs.length}  donated=${built.donateSats.toLocaleString()} sats  ` +
        `change=${built.changeSats.toLocaleString()} sats  fee=${built.fee} sats`,
    )

    // Wait briefly so the new outputs become acquirable_at-ready before the
    // next pass tries to spend them. Mirrors propagation grace.
    await new Promise((r) => setTimeout(r, 3000))
  }

  return stats
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  console.log('')
  console.log(`Mode: ${options.apply ? 'APPLY (will broadcast & mutate DB)' : 'DRY-RUN (read-only)'}`)
  console.log(`Rebalance phase: ${options.rebalance ? 'enabled' : 'disabled'}`)
  console.log(`Batch size: ${options.batchSize}`)
  console.log(`Fee rate: ${options.feeRate} sat/byte`)
  console.log(`Include unconfirmed UTXOs as inputs: ${options.includeUnconfirmed}`)
  if (options.walletFilter) console.log(`Wallet filter: ${options.walletFilter} only`)

  const allBindings = deriveBindings()
  const bindings = options.walletFilter
    ? allBindings.filter((b) => b.label === options.walletFilter)
    : allBindings
  if (bindings.length === 0) throw new Error('No matching wallet bindings.')

  const effectiveMin = effectiveMinInputSats(options)

  // Pre-flight snapshot.
  console.log('')
  console.log(
    `Effective --min-input-sats: ${effectiveMin}` +
      (options.minInputSats === null
        ? `  (auto: 2× per-input fee at ${options.feeRate} sat/byte)`
        : '  (operator override)'),
  )
  console.log('Pre-flight snapshot:')
  const preSnapshots = await Promise.all(
    bindings.map((b) =>
      snapshotWallet(b, options.includeUnconfirmed, effectiveMin, options.unconfirmedMinAgeSeconds),
    ),
  )
  for (const s of preSnapshots) {
    const eligibleBatches = Math.ceil(s.eligibleUtxos / options.batchSize)
    const estFeesPerBatch = estimateFee(options.batchSize, 1, options.feeRate)
    const estTotalFees = eligibleBatches * estFeesPerBatch
    console.log(
      `  ${s.binding.label} (${s.binding.address}): ` +
        `live=${s.liveUtxos.toLocaleString()}  confirmed=${s.confirmedUtxos.toLocaleString()}  ` +
        `largest=${s.largestSats.toLocaleString()} sats  total=${s.totalLiveSats.toLocaleString()} sats  ` +
        `eligible=${s.eligibleUtxos.toLocaleString()} (${s.eligibleSats.toLocaleString()} sats)  ` +
        `est. ${eligibleBatches} batch(es), ~${estTotalFees.toLocaleString()} sats fees total`,
    )
  }

  const lockedBy = `consolidate_${getLockOwnerId()}`

  // Phase 1: per-wallet consolidation.
  const consolidationStats: ConsolidationStats[] = []
  for (const binding of bindings) {
    try {
      const stats = await consolidateWallet(binding, options, lockedBy)
      consolidationStats.push(stats)
    } catch (err) {
      console.error(
        `❌ Consolidation aborted for ${binding.label}: ${err instanceof Error ? err.message : String(err)}`,
      )
      // Continue with remaining wallets — partial progress is still useful.
    }
  }

  // Phase 2: optional cross-wallet rebalance (operates on full binding set, not filter).
  let rebalanceStats: RebalanceStats | null = null
  if (options.rebalance) {
    if (options.walletFilter) {
      console.warn(
        '⚠️  --rebalance is incompatible with --wallet (rebalance needs all wallets). Skipping rebalance phase.',
      )
    } else {
      try {
        rebalanceStats = await rebalanceWallets(allBindings, options, lockedBy)
      } catch (err) {
        console.error(
          `❌ Rebalance aborted: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  // Final summary.
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('  Summary')
  console.log('═══════════════════════════════════════════════════════════════════')
  let totalInputs = 0
  let totalOutputSats = 0
  let totalFees = 0
  for (const s of consolidationStats) {
    totalInputs += s.inputsSpent
    totalOutputSats += s.satsConsolidated
    totalFees += s.feesPaid
    console.log(
      `  ${s.binding.label}: batches=${s.batches}  ` +
        `inputsSpent=${s.inputsSpent.toLocaleString()}  ` +
        `consolidated=${s.satsConsolidated.toLocaleString()} sats  ` +
        `fees=${s.feesPaid.toLocaleString()} sats  ` +
        `txids=${s.txids.length}`,
    )
  }
  console.log('  ' + '─'.repeat(63))
  console.log(
    `  TOTAL: inputsSpent=${totalInputs.toLocaleString()}  ` +
      `consolidated=${totalOutputSats.toLocaleString()} sats  ` +
      `fees=${totalFees.toLocaleString()} sats`,
  )

  if (rebalanceStats) {
    console.log('')
    console.log(`  Rebalance transfers: ${rebalanceStats.transfers.length}`)
    for (const t of rebalanceStats.transfers) {
      console.log(
        `    ${t.donor} → ${t.recipient}: ${t.donateSats.toLocaleString()} sats  fee=${t.feeSats} sats  txid=${t.txid}`,
      )
    }
  }

  // Post-flight snapshot (apply mode only — dry-run state is unchanged).
  if (options.apply) {
    console.log('')
    console.log('Post-flight snapshot:')
    const postSnapshots = await Promise.all(
      allBindings.map((b) =>
        snapshotWallet(b, options.includeUnconfirmed, effectiveMin, options.unconfirmedMinAgeSeconds),
      ),
    )
    for (const s of postSnapshots) {
      console.log(
        `  ${s.binding.label}: live=${s.liveUtxos.toLocaleString()}  ` +
          `largest=${s.largestSats.toLocaleString()} sats  ` +
          `total=${s.totalLiveSats.toLocaleString()} sats`,
      )
    }
  }

  if (!options.apply) {
    console.log('')
    console.log('This was a DRY-RUN. Re-run with `--apply` to perform the consolidation.')
    console.log('Add `--rebalance` to also redistribute balances across wallets.')
  } else {
    console.log('')
    console.log('Done. The maintainer (lib/utxo-maintainer.ts) will pick up the new')
    console.log('reserve UTXOs on its next cycle (~30s) and start refilling the pool.')
    console.log('Watch live throughput resume:')
    console.log('  pm2 logs gaialog-workers --lines 200 | grep -E "split|writeToChain ok|funding-monitor"')
  }
}

main()
  .then(async () => {
    try {
      // Best-effort attach handler so a final socket error from the pool tear-down
      // does not crash the script in our newly-hardened error model.
      const client = await dbPool.connect()
      attachClientErrorHandler(client)
      client.release()
    } catch {}
    await dbPool.end().catch(() => {})
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('❌ Consolidation script failed:', err)
    await dbPool.end().catch(() => {})
    process.exit(1)
  })
