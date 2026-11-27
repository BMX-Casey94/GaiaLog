#!/usr/bin/env npx tsx
/**
 * Consolidate the funds of the secondary treasury wallets (W2, W3, …) into the
 * single unified treasury wallet (W1).
 *
 * Why this exists
 * ---------------
 * The deployment is moving from three round-robin treasury wallets to one. The
 * funds do not move themselves: each secondary wallet still holds its own
 * UTXOs, and those UTXOs stay in `overlay_admitted_utxos` under that wallet's
 * topic (`TREASURY:v1:W2`, `TREASURY:v1:W3`) where the splitter keeps trying to
 * spend them. This tool drains every secondary wallet into W1, marks each spent
 * source row `removed = true` with its `spending_txid`, and admits the swept
 * output into W1's topic as a `reserve` UTXO — all in one database transaction
 * per batch.
 *
 * Safety
 * ------
 *   - DRY-RUN BY DEFAULT. Nothing is signed, broadcast or written unless
 *     `--apply` is passed (and, when attached to a terminal, confirmed by
 *     typing SWEEP).
 *   - Mainnet only. A WIF that resolves to a testnet address is rejected rather
 *     than spent.
 *   - Refuses to run while a source wallet has locked (in-flight) UTXOs, or while
 *     an outpoint is reserved in `utxo_locks`: those rows may be mid-spend, and
 *     consolidating them would double-spend.
 *   - Batches are capped at 500 inputs per transaction so every broadcast stays
 *     inside ARC's body limits and a failed batch only costs one batch's fee.
 *   - Inputs worth less than the fee to include them are excluded by default
 *     (`--min-input-sats`); spending dust recovers less than it costs.
 *   - Each batch is `N inputs → 1 output`. No change output is created, so a
 *     batch cannot silently leave dust behind: the whole input sum minus the
 *     explicit fee lands in W1.
 *   - The database mutation is atomic per batch: if marking the inputs spent and
 *     admitting the new output cannot both complete, the whole database
 *     transaction rolls back and the operator is told to reconcile, rather than
 *     leaving the inventory half-updated.
 *   - No WhatsOnChain wallet-address lookups. `--source=bitails` verifies against
 *     the Bitails indexer; the default `overlay` source reads our own table.
 *   - Broadcasts through `broadcastSplitTransactionRaw(rawHex, efBytes)`: the BSV
 *     Broadcaster (Arcade) first with BRC-30 EF bytes, then the legacy ARC chain
 *     only if the Broadcaster could not be reached.
 *
 * Usage
 * -----
 *   npx tsx scripts/migrate-to-single-wallet.ts --help
 *   npx tsx scripts/migrate-to-single-wallet.ts                       # dry-run, all secondary wallets
 *   npx tsx scripts/migrate-to-single-wallet.ts --source=bitails       # dry-run + on-chain verification
 *   npx tsx scripts/migrate-to-single-wallet.ts --apply               # broadcast (prompts on a TTY)
 *   npx tsx scripts/migrate-to-single-wallet.ts --apply --yes         # broadcast, no prompt
 *   npx tsx scripts/migrate-to-single-wallet.ts --from W2             # one source wallet only
 *
 * Environment
 * -----------
 *   BSV_WALLET_1_PRIVATE_KEY / BSV_WALLET_2_PRIVATE_KEY / BSV_WALLET_3_PRIVATE_KEY
 *   BSV_TX_FEE_RATE_SAT_PER_BYTE (or BSV_TX_FEE_RATE) — defaults to DEFAULT_TX_FEE_RATE
 *   BSV_GBP_RATE — optional, only used to print an approximate £ figure
 */

import './load-env-for-tools'

import { P2PKH, PrivateKey } from '@bsv/sdk'
import { DEFAULT_TX_FEE_RATE, bsvConfig } from '../lib/bsv-config'
import { getTreasuryTopicForWallet } from '../lib/treasury-topics'
import {
  buildConsolidationTx,
  p2pkhLockingScriptHexFromWif,
} from '../lib/broadcast/tx-builder'

const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 500
const SIGNED_P2PKH_INPUT_BYTES = 149 // worst-case signed P2PKH input (absorbs high-S variance)
const P2PKH_OUTPUT_BYTES = 34 // 8 value + 1 scriptLen + 25 script
const DUST_LIMIT = 1 // BSV has no protocol-enforced dust limit
const PROPAGATION_GRACE_MS = Math.max(0, Number(process.env.BSV_PROPAGATION_GRACE_MS || 2500))

const HELP = `GaiaLog — consolidate secondary treasury wallets into the single W1 treasury wallet

USAGE
  npx tsx scripts/migrate-to-single-wallet.ts [options]

OPTIONS
  --apply                     Broadcast the sweeps and update the database.
                              Without this flag the script is a read-only dry-run.
  --yes                       Skip the interactive "type SWEEP" confirmation.
                              Required when --apply runs without a terminal.
  --from W2,W3                Restrict the sweep to the listed wallets.
                              Default: every configured wallet except W1.
  --source overlay|bitails    Where the spendable UTXO set comes from.
                              overlay (default): our overlay_admitted_utxos table.
                              bitails: the same rows, verified against the Bitails
                                       indexer; rows the chain does not know about
                                       are excluded and anything the chain knows
                                       about but we do not is reported.
  --batch-size N              Inputs per consolidation transaction (1..500, default 500).
  --min-input-sats S          Leave inputs below S sats out of the sweep.
                              Default: the per-input fee (auto), i.e. inputs worth
                              exactly what they cost to spend are included, anything
                              cheaper is not. Pass 0 to sweep everything, dust included.
  --fee-rate R                Fee rate in satoshis per byte.
                              Default: BSV_TX_FEE_RATE_SAT_PER_BYTE, then
                              BSV_TX_FEE_RATE, then DEFAULT_TX_FEE_RATE.
  --include-unconfirmed       Also sweep UTXOs that are not yet confirmed.
                              Default: confirmed rows only.
  --skip-bitails-check        Alias for --source=overlay.
  --help, -h                  Show this help and exit.

NOTES
  - Stop the workers first (pm2 stop gaialog-workers gaialog-utxo-replenish) so
    nothing else spends from the source wallets while the sweep runs.
  - A £ estimate is printed only when BSV_GBP_RATE is set; no live price is
    fetched and no price is assumed.
  - Every spent source row is marked removed=true with spending_txid, and the
    swept output is admitted to W1's topic as a reserve UTXO.
`

interface CliOptions {
  apply: boolean
  yes: boolean
  from: string[] | null
  source: 'overlay' | 'bitails'
  batchSize: number
  feeRate: number | null
  minInputSats: number | null
  includeUnconfirmed: boolean
  help: boolean
}

function takeValue(argv: string[], flag: string): string {
  const idx = argv.indexOf(flag)
  if (idx === -1) throw new Error(`${flag} was passed without a value`)
  const value = argv[idx + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} was passed without a value`)
  return value
}

function parseArgs(argv: string[]): CliOptions {
  const help = argv.includes('--help') || argv.includes('-h')
  const apply = argv.includes('--apply')
  const yes = argv.includes('--yes')
  const includeUnconfirmed = argv.includes('--include-unconfirmed')

  let source: 'overlay' | 'bitails' = 'overlay'
  if (argv.includes('--skip-bitails-check')) {
    source = 'overlay'
  } else if (argv.some((a) => a.startsWith('--source'))) {
    const raw = takeValue(argv, '--source').trim().toLowerCase()
    if (raw !== 'overlay' && raw !== 'bitails' && raw !== 'both') {
      throw new Error(`--source must be overlay or bitails (got "${raw}")`)
    }
    // "both" is accepted as an alias: Bitails mode already reads the overlay
    // table and then verifies it against the chain.
    source = raw === 'overlay' ? 'overlay' : 'bitails'
  }

  let from: string[] | null = null
  if (argv.includes('--from')) {
    from = takeValue(argv, '--from')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
    if (from.length === 0) throw new Error('--from needs at least one wallet label (e.g. --from W2,W3)')
    for (const label of from) {
      if (!/^W[1-9][0-9]*$/.test(label)) {
        throw new Error(`--from entries must look like W2, W3 (got "${label}")`)
      }
    }
  }

  let batchSize = DEFAULT_BATCH_SIZE
  if (argv.includes('--batch-size')) {
    const parsed = Number(takeValue(argv, '--batch-size'))
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
      throw new Error(`--batch-size must be an integer between 1 and ${MAX_BATCH_SIZE}`)
    }
    batchSize = parsed
  }

  let feeRate: number | null = null
  if (argv.includes('--fee-rate')) {
    const parsed = Number(takeValue(argv, '--fee-rate'))
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--fee-rate must be greater than 0')
    feeRate = parsed
  }

  let minInputSats: number | null = null
  if (argv.includes('--min-input-sats')) {
    const parsed = Number(takeValue(argv, '--min-input-sats'))
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('--min-input-sats must be 0 or greater')
    minInputSats = Math.floor(parsed)
  }

  return { apply, yes, from, source, batchSize, feeRate, minInputSats, includeUnconfirmed, help }
}

function txOverheadBytes(numInputs: number, numOutputs: number): number {
  // Varint widths: 1 byte ≤ 252, 3 bytes ≤ 65535, 5 bytes above that.
  const inVar = numInputs > 65535 ? 5 : numInputs > 252 ? 3 : 1
  const outVar = numOutputs > 65535 ? 5 : numOutputs > 252 ? 3 : 1
  return 4 /* version */ + inVar + outVar + 4 /* locktime */
}

function estimateTxSize(numInputs: number, numOutputs: number): number {
  return (
    txOverheadBytes(numInputs, numOutputs) +
    numInputs * SIGNED_P2PKH_INPUT_BYTES +
    numOutputs * P2PKH_OUTPUT_BYTES
  )
}

function estimateFee(numInputs: number, numOutputs: number, feeRate: number): number {
  return Math.max(1, Math.ceil(estimateTxSize(numInputs, numOutputs) * feeRate))
}

function formatSats(sats: number): string {
  return `${sats.toLocaleString('en-GB')} sats`
}

function formatBsv(sats: number): string {
  return `${(sats / 1e8).toFixed(8)} BSV`
}

/**
 * Approximate sterling value, only when the operator supplies a rate.
 *
 * No price is fetched and none is assumed: a stale hard-coded rate in an
 * operator tool is worse than no figure at all.
 */
function formatGbp(sats: number): string | null {
  const raw = process.env.BSV_GBP_RATE || process.env.BSV_GBP_PRICE
  const rate = Number.parseFloat(String(raw ?? '').trim())
  if (!Number.isFinite(rate) || rate <= 0) return null
  return `£${((sats / 1e8) * rate).toFixed(2)} (at BSV_GBP_RATE=${rate})`
}

interface WalletBinding {
  walletIndex: number
  label: string
  wif: string
  address: string
  outputScriptHex: string
  topic: string
}

interface DbUtxo {
  topic: string
  txid: string
  vout: number
  satoshis: number
  output_script: string
  confirmed: boolean
  locked: boolean
  locked_by: string | null
}

interface LockedInput {
  topic: string
  txid: string
  vout: number
  satoshis: number
  output_script: string
}

interface BuiltTx {
  rawHex: string
  /** BRC-30 EF bytes for the BSV Broadcaster. */
  efBytes: Uint8Array
  txid: string
  fee: number
  outputSats: number
  txSizeBytes: number
}

// ─── Wallet resolution ───────────────────────────────────────────────────────

async function resolveBindings(options: CliOptions): Promise<{ primary: WalletBinding; sources: WalletBinding[] }> {
  if (bsvConfig.network !== 'mainnet') {
    throw new Error(`Refusing to run on ${bsvConfig.network}: GaiaLog is mainnet only.`)
  }

  const wifs = (bsvConfig.wallets.privateKeys || []).filter((k): k is string => !!k)
  if (wifs.length === 0) {
    throw new Error('No BSV wallet private keys configured. Set BSV_WALLET_1_PRIVATE_KEY (minimum).')
  }

  const p2pkh = new P2PKH()
  const bindings: WalletBinding[] = wifs.map((wif, walletIndex) => {
    const address = PrivateKey.fromWif(wif).toPublicKey().toAddress().toString()
    if (!address.startsWith('1')) {
      throw new Error(
        `Wallet index ${walletIndex} resolves to ${address}, which is not a Mainnet P2PKH address. ` +
          'Refusing to sign against a chain GaiaLog does not use.',
      )
    }
    const outputScriptHex = p2pkh.lock(address).toHex().toLowerCase()
    if (!/^76a914[0-9a-f]{40}88ac$/.test(outputScriptHex)) {
      throw new Error(`Wallet index ${walletIndex}: derived locking script is not P2PKH (${outputScriptHex})`)
    }
    return {
      walletIndex,
      label: `W${walletIndex + 1}`,
      wif,
      address,
      outputScriptHex,
      topic: getTreasuryTopicForWallet(walletIndex),
    }
  })

  const primary = bindings[0]
  const addresses = new Set(bindings.map((b) => b.address))
  if (addresses.size !== bindings.length) {
    throw new Error(
      'Two configured wallet slots resolve to the same address. De-duplicate BSV_WALLET_*_PRIVATE_KEY before migrating.',
    )
  }

  let sources = bindings.slice(1)
  if (options.from) {
    const requested = new Set(options.from)
    const known = new Set(bindings.map((b) => b.label))
    for (const label of requested) {
      if (label === primary.label) {
        throw new Error(`${label} is the destination wallet; it cannot also be a source.`)
      }
      if (!known.has(label)) {
        throw new Error(`${label} is not configured (configured: ${bindings.map((b) => b.label).join(', ')}).`)
      }
    }
    sources = bindings.filter((b) => requested.has(b.label))
  }

  if (sources.length === 0) {
    throw new Error(
      'No secondary wallets to migrate. Only one wallet is configured, so there is nothing to sweep — ' +
        'this is the intended end state after the migration is complete.',
    )
  }

  return { primary, sources }
}

// ─── Fee rate ────────────────────────────────────────────────────────────────

async function resolveFeeRate(override: number | null): Promise<number> {
  if (override !== null) return override
  const raw = process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE || process.env.BSV_TX_FEE_RATE
  const parsed = Number.parseFloat(String(raw ?? '').trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TX_FEE_RATE
}

// ─── Inventory reads ─────────────────────────────────────────────────────────

async function readWalletInventory(
  binding: WalletBinding,
  includeUnconfirmed: boolean,
): Promise<DbUtxo[]> {
  const { query } = await import('../lib/db')
  const res = await query<DbUtxo>(
    `SELECT topic, txid, vout, satoshis, output_script, confirmed, locked, locked_by
       FROM overlay_admitted_utxos
      WHERE wallet_index = $1
        AND removed = false
        AND ($2::boolean = true OR confirmed = true)
      ORDER BY satoshis DESC, admitted_at ASC, txid ASC, vout ASC`,
    [binding.walletIndex, includeUnconfirmed],
  )
  return res.rows.map((row) => ({
    ...row,
    satoshis: Number(row.satoshis),
    vout: Number(row.vout),
    confirmed: row.confirmed === true,
    locked: row.locked === true,
  }))
}

/**
 * Every live outpoint for a wallet, including unconfirmed rows.
 *
 * This is the reconciliation set, not the sweep set: an unconfirmed output that
 * the indexer also reports is expected and must not be reported as a gap.
 */
async function readLiveOutpoints(binding: WalletBinding): Promise<Set<string>> {
  const { query } = await import('../lib/db')
  const res = await query<{ txid: string; vout: number }>(
    `SELECT txid, vout
       FROM overlay_admitted_utxos
      WHERE wallet_index = $1
        AND removed = false`,
    [binding.walletIndex],
  )
  return new Set(res.rows.map((row) => `${row.txid}:${Number(row.vout)}`))
}async function countUnconfirmedLeftovers(binding: WalletBinding): Promise<number> {
  const { query } = await import('../lib/db')
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM overlay_admitted_utxos
      WHERE wallet_index = $1
        AND removed = false
        AND confirmed = false`,
    [binding.walletIndex],
  )
  return Number(res.rows[0]?.count || '0')
}

async function countLockedRows(binding: WalletBinding): Promise<number> {
  const { query } = await import('../lib/db')
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM overlay_admitted_utxos
      WHERE wallet_index = $1
        AND removed = false
        AND locked = true`,
    [binding.walletIndex],
  )
  return Number(res.rows[0]?.count || '0')
}

/**
 * Reserved outpoints from `utxo_locks`.
 *
 * The legacy/reserve path takes a row-level reservation before spending, so a
 * reserved outpoint may be about to be spent by a worker even though
 * `overlay_admitted_utxos.locked` is still false.
 */
async function findReservedOutpoints(utxos: Array<{ txid: string; vout: number }>): Promise<string[]> {
  if (utxos.length === 0) return []
  const { getReservedUtxoKeys } = await import('../lib/utxo-locks')
  const reserved: string[] = []
  const chunkSize = 1000
  for (let i = 0; i < utxos.length; i += chunkSize) {
    const chunk = utxos.slice(i, i + chunkSize).map((u) => `${u.txid}:${u.vout}`)
    const found = await getReservedUtxoKeys(chunk)
    reserved.push(...found)
  }
  return reserved
}

/**
 * Bitails-verified view of a wallet's on-chain unspent set.
 *
 * `getUnspentForAddress` is the shared provider: it refuses WhatsOnChain address
 * lookups by policy. Forcing the provider and bypassing overlay preference here
 * is deliberate — the point of this mode is an independent check.
 */
async function fetchOnChainUnspent(address: string): Promise<Array<{ txid: string; vout: number; satoshis: number }>> {
  const { getUnspentForAddress } = await import('../lib/utxo-provider')
  const previousProvider = process.env.BSV_UTXO_PROVIDER
  const previousSpendMode = process.env.BSV_SPEND_SOURCE_MODE
  process.env.BSV_UTXO_PROVIDER = 'bitails'
  process.env.BSV_SPEND_SOURCE_MODE = 'legacy'
  try {
    const utxos = await getUnspentForAddress(address, { confirmedOnly: false })
    return (utxos || []).map((u: any) => ({
      txid: String(u?.tx_hash || ''),
      vout: Number(u?.tx_pos ?? 0),
      satoshis: Number(u?.value) || 0,
    }))
  } finally {
    if (previousProvider === undefined) delete process.env.BSV_UTXO_PROVIDER
    else process.env.BSV_UTXO_PROVIDER = previousProvider
    if (previousSpendMode === undefined) delete process.env.BSV_SPEND_SOURCE_MODE
    else process.env.BSV_SPEND_SOURCE_MODE = previousSpendMode
  }
}

// ─── Planning ────────────────────────────────────────────────────────────────

interface BatchPlan {
  inputCount: number
  inputSum: number
  fee: number
  outputSats: number
  txSizeBytes: number
}

interface WalletPlan {
  binding: WalletBinding
  utxos: DbUtxo[]
  totalSats: number
  confirmedCount: number
  unconfirmedCount: number
  batches: BatchPlan[]
  totalFee: number
  netOutput: number
  excludedPhantom: number
  // Inputs so small they cost more in fee to spend than they are worth.
  excludedDustCount: number
  excludedDustSats: number
}

/**
 * Plan the batches for one wallet.
 *
 * `minInputSats` is the economic floor: an input worth less than the sats it
 * costs to include cannot add value to the sweep, so it is left out of the
 * transaction. Those rows stay live until the operator retires the wallet.
 */
function planBatches(
  binding: WalletBinding,
  utxos: DbUtxo[],
  batchSize: number,
  feeRate: number,
  minInputSats: number,
): WalletPlan {
  const spendable = utxos.filter((u) => u.satoshis >= minInputSats)
  const excludedDust = utxos.filter((u) => u.satoshis < minInputSats)

  const batches: BatchPlan[] = []
  let totalFee = 0
  let netOutput = 0

  for (let i = 0; i < spendable.length; i += batchSize) {
    const slice = spendable.slice(i, i + batchSize)
    const inputSum = slice.reduce((acc, u) => acc + u.satoshis, 0)
    const fee = estimateFee(slice.length, 1, feeRate)
    const outputSats = inputSum - fee
    if (outputSats <= DUST_LIMIT) {
      throw new Error(
        `${binding.label}: a batch of ${slice.length} input(s) totalling ${inputSum} sats cannot cover the ` +
          `${fee} sat fee. Raise --batch-size, lower --fee-rate, or raise --min-input-sats to drop more dust.`,
      )
    }
    batches.push({
      inputCount: slice.length,
      inputSum,
      fee,
      outputSats,
      txSizeBytes: estimateTxSize(slice.length, 1),
    })
    totalFee += fee
    netOutput += outputSats
  }

  return {
    binding,
    utxos: spendable,
    totalSats: spendable.reduce((acc, u) => acc + u.satoshis, 0),
    confirmedCount: spendable.filter((u) => u.confirmed).length,
    unconfirmedCount: spendable.filter((u) => !u.confirmed).length,
    batches,
    totalFee,
    netOutput,
    excludedPhantom: 0,
    excludedDustCount: excludedDust.length,
    excludedDustSats: excludedDust.reduce((acc, u) => acc + u.satoshis, 0),
  }
}

function printWalletPlan(plan: WalletPlan, feeRate: number): void {
  const { binding } = plan
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log(`  ${binding.label} → W1   (${binding.address})`)
  console.log(`  topic ${binding.topic} · wallet_index ${binding.walletIndex}`)
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log(`  UTXOs          : ${plan.utxos.length.toLocaleString('en-GB')} ` +
    `(${plan.confirmedCount.toLocaleString('en-GB')} confirmed, ${plan.unconfirmedCount.toLocaleString('en-GB')} unconfirmed)`)
  console.log(`  Total value    : ${formatSats(plan.totalSats)}  (${formatBsv(plan.totalSats)})`)
  console.log(`  Batches        : ${plan.batches.length} × ≤${plan.batches[0]?.inputCount.toLocaleString('en-GB') ?? 0} input(s)`)
  console.log(`  Estimated fee  : ${formatSats(plan.totalFee)}  (${formatBsv(plan.totalFee)} at ${feeRate} sat/byte)`)
  console.log(`  Net to W1      : ${formatSats(plan.netOutput)}  (${formatBsv(plan.netOutput)})`)
  if (plan.excludedDustCount > 0) {
    console.log(
      `  Excluded dust  : ${plan.excludedDustCount.toLocaleString('en-GB')} input(s) below the economic floor ` +
        `(${formatSats(plan.excludedDustSats)} total) — cheaper to leave than to spend`,
    )
  }

  const gbp = formatGbp(plan.netOutput)
  console.log(
    `  Approx. £      : ${gbp ?? 'not calculated — set BSV_GBP_RATE to add a sterling estimate (no live price is fetched)'}`,
  )
  if (plan.excludedPhantom > 0) {
    console.log(
      `  Excluded       : ${plan.excludedPhantom.toLocaleString('en-GB')} row(s) the indexer did not report as unspent`,
    )
  }
  if (plan.batches.length > 1) {
    console.log('  Batch detail   :')
    const shown = plan.batches.length <= 8
      ? plan.batches
      : [...plan.batches.slice(0, 4), ...plan.batches.slice(-2)]
    shown.forEach((batch, index) => {
      const label = plan.batches.length <= 8 ? `#${index + 1}` : `#${index < 4 ? index + 1 : plan.batches.length - 1 + (index - 4)}`
      console.log(
        `    ${label}: ${batch.inputCount.toLocaleString('en-GB')} input(s), ` +
          `${formatSats(batch.inputSum)} in, ${formatSats(batch.fee)} fee, ` +
          `${formatSats(batch.outputSats)} out, ≈${(batch.txSizeBytes / 1024).toFixed(1)} KB`,
      )
      if (plan.batches.length > 8 && index === 3) {
        console.log(`    … ${(plan.batches.length - 6).toLocaleString('en-GB')} more batch(es) omitted …`)
      }
    })
  }

  warnIfUneconomic(plan, feeRate)
}

/**
 * Flag a sweep whose fee eats a large share of the recovered value.
 *
 * Consolidating dust is only worth doing when the inputs are worth more than
 * the bytes it costs to spend them. At a given fee rate each P2PKH input costs
 * SIGNED_P2PKH_INPUT_BYTES × feeRate sats to include, so an inventory whose
 * average input sits near that figure recovers very little. The operator needs
 * to see that before passing --apply, not afterwards.
 */
function warnIfUneconomic(plan: WalletPlan, feeRate: number): void {
  if (plan.totalSats <= 0) return
  const feeSharePct = (plan.totalFee / plan.totalSats) * 100
  const perInputCost = SIGNED_P2PKH_INPUT_BYTES * feeRate
  const averageInput = Math.floor(plan.totalSats / Math.max(1, plan.utxos.length))

  if (feeSharePct >= 50) {
    console.warn('')
    console.warn(
      `  ⚠️  Fees are ${feeSharePct.toFixed(1)}% of the swept value: ${formatSats(plan.totalFee)} of ` +
        `${formatSats(plan.totalSats)} leaves ${formatSats(plan.netOutput)} for W1.`,
    )
    console.warn(
      `     Average input ${averageInput} sats vs ${perInputCost.toFixed(1)} sats to spend each one at ` +
        `${feeRate} sat/byte. This inventory is mostly dust; sweeping still consolidates it, but the ` +
        'recovered value is small.',
    )
    console.warn(
      '     If that is not worth the fee, leave the wallet as-is: it costs nothing to keep the rows, ' +
        'and they can be reaped by retention later.',
    )
  } else if (feeSharePct >= 20) {
    console.log(
      `  Note           : fees are ${feeSharePct.toFixed(1)}% of the swept value ` +
        `(${formatSats(plan.totalFee)} of ${formatSats(plan.totalSats)}).`,
    )
  }
}

// ─── Lock / unlock / commit ──────────────────────────────────────────────────

/**
 * Economic floor for an input, in satoshis.
 *
 * Consolidating an input in a batch changes the net result by (value − bytes ×
 * feeRate), where the bytes are that input's own 149-byte contribution. So an
 * input is worth sweeping whenever it is worth more than the bytes it adds;
 * anything below that line actively reduces what W1 receives. The default floor
 * is therefore the break-even point, not a multiple of it — being conservative
 * here would leave most of a dust-heavy inventory behind.
 */
function resolveMinInputSats(override: number | null, feeRate: number): number {
  if (override !== null) return override
  return Math.max(1, Math.ceil(SIGNED_P2PKH_INPUT_BYTES * feeRate))
}

async function lockBatch(
  binding: WalletBinding,
  batchSize: number,
  includeUnconfirmed: boolean,
  minInputSats: number,
  lockedBy: string,
): Promise<LockedInput[]> {
  const { withOverlayTransaction } = await import('../lib/overlay-repository')
  return withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = 120000`)
    const res = await client.query<{
      topic: string
      txid: string
      vout: number
      satoshis: string
      output_script: string
    }>(
      `WITH candidate AS (
         SELECT topic, txid, vout
           FROM overlay_admitted_utxos
          WHERE wallet_index = $1
            AND removed = false
            AND locked = false
            AND satoshis >= $5
            AND acquirable_at <= now()
            AND ($2::boolean = true OR confirmed = true)
          ORDER BY satoshis DESC, admitted_at ASC, txid ASC, vout ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $3
       )
       UPDATE overlay_admitted_utxos u
          SET locked = true,
              locked_by = $4,
              locked_at = now()
         FROM candidate c
        WHERE u.topic = c.topic
          AND u.txid = c.txid
          AND u.vout = c.vout
     RETURNING u.topic, u.txid, u.vout, u.satoshis, u.output_script`,
      [binding.walletIndex, includeUnconfirmed, batchSize, lockedBy, Math.max(0, Math.floor(minInputSats))],
    )
    return res.rows.map((row) => ({
      topic: row.topic,
      txid: row.txid,
      vout: Number(row.vout),
      satoshis: Number(row.satoshis),
      output_script: row.output_script,
    }))
  })
}

async function releaseBatch(inputs: LockedInput[], lockedBy: string, cooldownMs: number): Promise<void> {
  if (inputs.length === 0) return
  const { withOverlayTransaction } = await import('../lib/overlay-repository')
  await withOverlayTransaction(async (client) => {
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
      [
        inputs.map((i) => i.topic),
        inputs.map((i) => i.txid),
        inputs.map((i) => i.vout),
        lockedBy,
        Math.max(0, Math.floor(cooldownMs)),
      ],
    )
  })
}

/**
 * Mark the swept inputs spent and admit the new W1 output, atomically.
 *
 * Ordering matters: the UPDATE is guarded on `removed = false` and must affect
 * exactly the rows we locked. A mismatch means somebody else changed the
 * inventory under us, so the whole transaction rolls back and the operator is
 * told to reconcile rather than continuing from an inconsistent table.
 */
async function commitSweep(input: {
  primary: WalletBinding
  sourceTopic: string
  inputs: LockedInput[]
  spendingTxid: string
  rawTx: string
  outputSats: number
}): Promise<void> {
  const { withOverlayTransaction, refreshTopicCounts } = await import('../lib/overlay-repository')

  // Defence in depth: every input must belong to the wallet we are sweeping.
  // A mismatched topic would mark another wallet's coins spent under this
  // batch's spending_txid, which no later reconciliation could unpick.
  for (const locked of input.inputs) {
    if (locked.topic !== input.sourceTopic) {
      throw new Error(
        `commitSweep: input ${locked.txid}:${locked.vout} belongs to topic ${locked.topic}, ` +
          `expected ${input.sourceTopic}. Refusing to commit.`,
      )
    }
  }

  await withOverlayTransaction(async (client) => {
    const removed = await client.query<{ topic: string }>(
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
      [
        input.inputs.map((i) => i.topic),
        input.inputs.map((i) => i.txid),
        input.inputs.map((i) => i.vout),
        input.spendingTxid,
      ],
    )
    if ((removed.rowCount || 0) !== input.inputs.length) {
      throw new Error(
        `commitSweep: expected to mark ${input.inputs.length} input(s) spent but marked ${removed.rowCount || 0}. ` +
          'Rolling back the database transaction — the broadcast may be on-chain, so reconcile before retrying.',
      )
    }

    await client.query(
      `INSERT INTO overlay_admitted_utxos (
         topic, txid, vout, satoshis, output_script, raw_tx, beef, confirmed,
         wallet_index, utxo_role, locked, locked_by, locked_at,
         removed, removed_at, spending_txid, acquirable_at
       )
       VALUES ($1, $2, 0, $3, $4, $5, NULL, false,
               $6, 'reserve', false, NULL, NULL,
               false, NULL, NULL, now() + ($7::bigint * interval '1 millisecond'))
       ON CONFLICT (topic, txid, vout) DO UPDATE SET
         satoshis = EXCLUDED.satoshis,
         output_script = EXCLUDED.output_script,
         raw_tx = EXCLUDED.raw_tx,
         confirmed = CASE WHEN EXCLUDED.confirmed THEN true ELSE overlay_admitted_utxos.confirmed END,
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
        input.primary.topic,
        input.spendingTxid,
        input.outputSats,
        input.primary.outputScriptHex,
        input.rawTx,
        input.primary.walletIndex,
        PROPAGATION_GRACE_MS,
      ],
    )

    // Rollup deltas: the source topic loses the inputs spent from it, and W1
    // gains the one swept output. Single-row upserts are far cheaper than the
    // COUNT(*) the per-row trigger used to run.
    await refreshTopicCounts(client, input.sourceTopic, -input.inputs.length)
    await refreshTopicCounts(client, input.primary.topic, 1)
  })
}

// ─── Transaction build ───────────────────────────────────────────────────────

/**
 * Build and sign `N inputs → 1 output` paying the whole input sum (minus the
 * explicit fee) into W1.
 *
 * Each input is signed from the satoshi amount and locking script stored with
 * its overlay row, so no parent transaction has to be fetched. Anything whose
 * stored script is not the source wallet's own P2PKH script is rejected: signing
 * it would produce an invalid spend at best, and hand away a signature at worst.
 *
 * A BRC-30 EF is produced for the Broadcaster. It needs only
 * `(satoshis, lockingScript)` per input — never the full parent transaction — so
 * the builder attaches a lightweight source stand-in after signing and
 * serialises from that. The EF is a description of this transaction's inputs,
 * not a claim that we hold their ancestors.
 */
async function signSweepTx(
  binding: WalletBinding,
  primary: WalletBinding,
  inputs: LockedInput[],
  feeRate: number,
): Promise<BuiltTx> {
  const ownScript = p2pkhLockingScriptHexFromWif(binding.wif)
  if (ownScript !== binding.outputScriptHex) {
    throw new Error(`${binding.label}: derived locking script does not match the wallet binding`)
  }

  const fee = estimateFee(inputs.length, 1, feeRate)
  const inputSum = inputs.reduce((acc, i) => acc + i.satoshis, 0)
  const outputSats = inputSum - fee
  if (outputSats <= DUST_LIMIT) {
    throw new Error(
      `${binding.label}: refusing to build a sweep with ${outputSats} sat output (inputSum=${inputSum}, fee=${fee})`,
    )
  }

  const built = await buildConsolidationTx({
    wif: binding.wif,
    inputs: inputs.map((input, index) => {
      if (!Number.isInteger(input.vout) || input.vout < 0) {
        throw new Error(`${binding.label}: invalid vout for ${input.txid}`)
      }
      if (!Number.isSafeInteger(input.satoshis) || input.satoshis <= 0) {
        throw new Error(`${binding.label}: invalid satoshi amount for ${input.txid}:${input.vout}`)
      }
      const lockingScriptHex = String(input.output_script || '').trim().toLowerCase()
      if (!lockingScriptHex) {
        throw new Error(`${binding.label}: input ${input.txid}:${input.vout} has no stored locking script`)
      }
      return {
        txid: input.txid,
        vout: input.vout,
        satoshis: input.satoshis,
        lockingScriptHex,
      }
    }),
    destinationAddress: primary.address,
    explicitFeeSats: fee,
  })

  if (built.outputs.length !== 1 || built.outputs[0].satoshis !== outputSats) {
    throw new Error(
      `${binding.label}: builder produced ${built.outputs.length} output(s) totalling ` +
        `${built.outputs.reduce((sum, o) => sum + o.satoshis, 0)} sats, expected one of ${outputSats}.`,
    )
  }
  if (built.feeSats !== fee) {
    throw new Error(`${binding.label}: built fee ${built.feeSats} does not match the planned ${fee}`)
  }

  return {
    rawHex: built.rawHex,
    efBytes: built.efBytes,
    txid: built.txid,
    fee: built.feeSats,
    outputSats,
    txSizeBytes: built.sizeBytes,
  }
}

// ─── Confirmation ────────────────────────────────────────────────────────────

async function confirmApply(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      '--apply needs confirmation, but stdin is not a terminal. Re-run with --yes to confirm non-interactively.',
    )
  }
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      '\nThis will broadcast real Mainnet transactions and mutate the database.\n' +
        'Type SWEEP to continue (anything else aborts): ',
    )
    if (answer.trim() !== 'SWEEP') {
      throw new Error('Aborted: confirmation text did not match.')
    }
  } finally {
    rl.close()
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Close the Postgres pool only if something actually loaded it.
 *
 * The dry-run and `--help` paths have no reason to hold a connection, and a
 * lingering idle pool keeps the process alive after the summary prints.
 */
async function shutdownDbPool(): Promise<void> {
  try {
    const db = await import('../lib/db')
    await db.dbPool.end().catch(() => {})
  } catch {
    // lib/db was never loaded (e.g. --help), so there is nothing to close.
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }

  const { primary, sources } = await resolveBindings(options)
  const feeRate = await resolveFeeRate(options.feeRate)
  const minInputSats = resolveMinInputSats(options.minInputSats, feeRate)

  console.log('')
  console.log(`Mode   : ${options.apply ? 'APPLY (broadcast + DB mutation)' : 'DRY-RUN (read-only)'}`)
  console.log(`Source : ${options.source}${options.source === 'bitails' ? ' (verified against the Bitails indexer)' : ''}`)
  console.log(`Fee    : ${feeRate} sat/byte`)
  console.log(`Batch  : up to ${options.batchSize} input(s) per transaction`)
  console.log(
    `Dust   : inputs below ${minInputSats} sats are ${options.minInputSats === null ? 'auto-' : ''}excluded ` +
      `(${options.minInputSats === null ? 'per-input fee; ' : ''}pass --min-input-sats 0 to sweep everything)`,
  )
  console.log(`Unconf.: ${options.includeUnconfirmed ? 'included' : 'excluded (confirmed rows only)'}`)
  console.log(`Target : W1 ${primary.address}  (topic ${primary.topic})`)
  console.log(
    'Note   : stop gaialog-workers and gaialog-utxo-replenish before --apply so nothing else spends these UTXOs.',
  )

  const plans: WalletPlan[] = []
  let aborted = false

  for (const binding of sources) {
    // 1. In-flight guard.
    const lockedRows = await countLockedRows(binding)
    if (lockedRows > 0) {
      console.error(
        `\n❌ ${binding.label}: ${lockedRows} UTXO row(s) are locked (in flight). ` +
          'Stop the workers, wait for the locks to expire or release, then re-run. Nothing was changed.',
      )
      aborted = true
      continue
    }

    // 2. Inventory.
    const inventory = await readWalletInventory(binding, options.includeUnconfirmed)
    if (inventory.length === 0) {
      const unconfirmedLeft = await countUnconfirmedLeftovers(binding)
      console.log(
        `\n✅ ${binding.label}: no ${options.includeUnconfirmed ? '' : 'confirmed '}UTXOs to sweep.` +
          (unconfirmedLeft > 0
            ? ` ${unconfirmedLeft} unconfirmed row(s) remain — re-run with --include-unconfirmed once they confirm.`
            : ''),
      )
      continue
    }

    // 3. Reserved-outpoint guard.
    const reserved = await findReservedOutpoints(inventory)
    if (reserved.length > 0) {
      console.error(
        `\n❌ ${binding.label}: ${reserved.length} outpoint(s) are reserved in utxo_locks ` +
          `(e.g. ${reserved.slice(0, 3).join(', ')}). These may be mid-spend. Aborting this wallet; nothing was changed.`,
      )
      aborted = true
      continue
    }

    // 4. Optional on-chain verification.
    let spendable = inventory
    let excludedPhantom = 0
    if (options.source === 'bitails') {
      const onChain = await fetchOnChainUnspent(binding.address)
      const onChainKeys = new Set(
        onChain.filter((u) => /^[0-9a-fA-F]{64}$/.test(u.txid)).map((u) => `${u.txid}:${u.vout}`),
      )
      // Compare against ALL live rows, not just the sweep set: an unconfirmed
      // output that has not reached the indexer yet is expected, whereas a
      // confirmed row we do not hold locally means funds would be left behind.
      const liveKeys = await readLiveOutpoints(binding)
      const unrecorded = [...onChainKeys].filter((key) => !liveKeys.has(key))
      spendable = inventory.filter((u) => onChainKeys.has(`${u.txid}:${u.vout}`))
      excludedPhantom = inventory.length - spendable.length

      if (unrecorded.length > 0) {
        console.error(
          `\n❌ ${binding.label}: Bitails reports ${unrecorded.length} unspent outpoint(s) that are not in ` +
            `overlay_admitted_utxos (e.g. ${unrecorded.slice(0, 3).join(', ')}). ` +
            'Sweeping now would leave those funds behind. Reconcile the inventory first ' +
            '(scripts/recovery-import-onchain-utxos.ts) and re-run.',
        )
        aborted = true
        continue
      }
      if (excludedPhantom > 0) {
        console.warn(
          `\n⚠️  ${binding.label}: ${excludedPhantom} row(s) are marked live locally but are not unspent on chain. ` +
            'They are excluded from this sweep (broadcasting them would fail with a missing-input rejection).',
        )
      }
      if (spendable.length === 0) {
        console.log(`\n✅ ${binding.label}: nothing on chain left to sweep.`)
        continue
      }
    }

    // 5. Plan.
    const plan = planBatches(binding, spendable, options.batchSize, feeRate, minInputSats)
    plan.excludedPhantom = excludedPhantom
    if (plan.utxos.length === 0) {
      console.warn(
        `\n⚠️  ${binding.label}: every UTXO is below the ${minInputSats} sat economic floor ` +
          `(${formatSats(plan.excludedDustSats)} across ${plan.excludedDustCount.toLocaleString('en-GB')} input(s)). ` +
          'Sweeping it would cost more in fees than it recovers. Nothing to do.',
      )
      continue
    }
    printWalletPlan(plan, feeRate)
    plans.push(plan)
  }

  if (aborted) {
    console.error('\nAborted: at least one wallet failed a safety check. No transactions were sent and no rows changed.')
    process.exitCode = 1
    return
  }
  if (plans.length === 0) {
    console.log('\nNothing to sweep. Every secondary wallet is already empty.')
    return
  }

  const grandTotal = plans.reduce((acc, p) => acc + p.totalSats, 0)
  const grandFee = plans.reduce((acc, p) => acc + p.totalFee, 0)
  const grandNet = plans.reduce((acc, p) => acc + p.netOutput, 0)
  const grandBatches = plans.reduce((acc, p) => acc + p.batches.length, 0)

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('  Totals')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log(`  Source wallets : ${plans.map((p) => p.binding.label).join(', ')}`)
  console.log(`  UTXOs          : ${plans.reduce((acc, p) => acc + p.utxos.length, 0).toLocaleString('en-GB')}`)
  console.log(`  Transactions   : ${grandBatches}`)
  console.log(`  Total value    : ${formatSats(grandTotal)}  (${formatBsv(grandTotal)})`)
  console.log(`  Estimated fee  : ${formatSats(grandFee)}  (${formatBsv(grandFee)})`)
  console.log(`  Net to W1      : ${formatSats(grandNet)}  (${formatBsv(grandNet)})`)
  const grandGbp = formatGbp(grandNet)
  if (grandGbp) console.log(`  Approx. £      : ${grandGbp}`)

  if (!options.apply) {
    console.log('')
    console.log('This was a DRY-RUN. Nothing was signed, broadcast or written.')
    console.log('Re-run with `--apply` (and `--yes` when not attached to a terminal) to perform the sweep.')
    return
  }

  if (!options.yes) await confirmApply()

  const { getLockOwnerId } = await import('../lib/utxo-locks')
  const { broadcastSplitTransactionRaw } = await import('../lib/broadcast-raw-tx')
  const lockedBy = `migrate_single_wallet_${getLockOwnerId()}`

  const results: Array<{ label: string; txid: string; inputCount: number; outputSats: number; fee: number }> = []

  for (const plan of plans) {
    const { binding } = plan
    console.log('')
    console.log(`── Sweeping ${binding.label} ──────────────────────────────────────────`)

    let batchNo = 0
    while (true) {
      batchNo += 1
      const inputs = await lockBatch(binding, options.batchSize, options.includeUnconfirmed, minInputSats, lockedBy)
      if (inputs.length === 0) {
        console.log(`  ${binding.label}: no more spendable inputs — done.`)
        break
      }

      let built: BuiltTx
      try {
        built = await signSweepTx(binding, primary, inputs, feeRate)
      } catch (err) {
        await releaseBatch(inputs, lockedBy, 60_000)
        throw new Error(
          `${binding.label}: batch #${batchNo} build failed — ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      console.log(
        `  Batch #${batchNo}: ${inputs.length.toLocaleString('en-GB')} input(s) → ` +
          `${formatSats(built.outputSats)} to W1, fee ${formatSats(built.fee)}, txid ${built.txid}`,
      )

      let broadcastTxid: string
      try {
        broadcastTxid = await broadcastSplitTransactionRaw(built.rawHex, built.efBytes)
      } catch (err) {
        await releaseBatch(inputs, lockedBy, 120_000)
        throw new Error(
          `${binding.label}: batch #${batchNo} broadcast failed — ` +
            `${err instanceof Error ? err.message : String(err)}. Locks released with a 2 minute cooldown; ` +
            're-run once the upstream issue is resolved.',
        )
      }
      if (broadcastTxid.toLowerCase() !== built.txid) {
        // Locks are deliberately kept: the transaction may be on chain under an
        // id the broadcaster reported wrongly, and releasing spent outpoints
        // would let the next batch build a double spend against them.
        throw new Error(
          `${binding.label}: broadcaster returned ${broadcastTxid} but the signed txid is ${built.txid}. ` +
            'Locks held. Treat the sweep as unknown: verify on chain before re-running.',
        )
      }

      try {
        await commitSweep({
          primary,
          sourceTopic: binding.topic,
          inputs,
          spendingTxid: built.txid,
          rawTx: built.rawHex,
          outputSats: built.outputSats,
        })
      } catch (err) {
        console.error(
          `  ⚠️  ${binding.label}: transaction ${built.txid} BROADCAST OK but the database commit failed — ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            'The inputs are still marked live locally. Do not re-broadcast blindly: reconcile the inventory ' +
            'against the chain, then re-run.',
        )
        throw err
      }

      results.push({
        label: binding.label,
        txid: built.txid,
        inputCount: inputs.length,
        outputSats: built.outputSats,
        fee: built.fee,
      })
      console.log(`  ✅ Batch #${batchNo} committed: inputs marked spent, output admitted to W1 as reserve.`)

      if (inputs.length < options.batchSize) {
        console.log(`  ${binding.label}: partial batch — wallet drained.`)
        break
      }
    }
  }

  // ─── Post-sweep verification ───────────────────────────────────────────────
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('  Post-sweep summary')
  console.log('═══════════════════════════════════════════════════════════════════')
  let sentNet = 0
  let sentFee = 0
  for (const result of results) {
    sentNet += result.outputSats
    sentFee += result.fee
    console.log(
      `  ${result.label}: ${result.inputCount.toLocaleString('en-GB')} input(s) → ` +
        `${formatSats(result.outputSats)} to W1, fee ${formatSats(result.fee)}, txid ${result.txid}`,
    )
  }
  console.log(`  ${'─'.repeat(63)}`)
  console.log(`  Net to W1: ${formatSats(sentNet)}  (${formatBsv(sentNet)})   Fees: ${formatSats(sentFee)}`)

  console.log('')
  console.log('Verify before removing any key from .env:')
  console.log('  1. Confirm zero live rows remain on every source wallet:')
  for (const plan of plans) {
    try {
      const { query } = await import('../lib/db')
      const res = await query<{ live: string; live_sats: string; unconfirmed: string }>(
        `SELECT COUNT(*)::text AS live,
                COALESCE(SUM(satoshis), 0)::text AS live_sats,
                COUNT(*) FILTER (WHERE confirmed = false)::text AS unconfirmed
           FROM overlay_admitted_utxos
          WHERE wallet_index = $1
            AND removed = false`,
        [plan.binding.walletIndex],
      )
      const row = res.rows[0]
      const live = Number(row?.live || '0')
      console.log(
        `     ${plan.binding.label}: ${live} live row(s), ${formatSats(Number(row?.live_sats || '0'))}` +
          `${Number(row?.unconfirmed || '0') > 0 ? ` (${row?.unconfirmed} unconfirmed)` : ''}` +
          (live === 0 ? '  ✅ drained' : '  ⚠️  re-run or reconcile'),
      )
    } catch (err) {
      console.warn(
        `     ${plan.binding.label}: verification query failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  console.log('  2. Confirm each sweep transaction is mined (Bitails output lookup):')
  for (const result of results) {
    console.log(`     https://api.bitails.io/tx/${result.txid}`)
  }
  console.log('  3. Only then remove BSV_WALLET_2_PRIVATE_KEY / BSV_WALLET_3_PRIVATE_KEY (and their')
  console.log('     _ADDRESS entries) from .env.')
  console.log('  4. Restart the workers: pm2 start gaialog-workers gaialog-utxo-replenish --update-env')
}

main()
  .then(async () => {
    const code = process.exitCode ?? 0
    await shutdownDbPool()
    if (code !== 0) process.exit(code)
  })
  .catch(async (err) => {
    console.error('\n❌ migrate-to-single-wallet failed:', err instanceof Error ? err.message : err)
    await shutdownDbPool()
    process.exit(1)
  })
