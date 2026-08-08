/**
 * Auto-Consolidate (dust starvation guard)
 *
 * The splitter mints thousands of small pool outputs per wallet. Every write
 * spends one, but any output that fails to be spent (rejected broadcast,
 * reorg-orphaned parent, worker restart mid-flight) stays in inventory as
 * dust. Over weeks that dust becomes the *only* inventory: the wallet still
 * holds real BSV, yet no single output is large enough to fund a split, so
 * the maintainer reports STARVED, write-dry-mode engages, and chain writes
 * stop until an operator runs `scripts/consolidate-wallet-utxos.ts` by hand.
 *
 * This scheduler removes the manual step. Each cycle it checks every wallet's
 * largest usable output against the split floor; when a wallet cannot fund a
 * split it sweeps its stranded dust into one large `reserve` output that the
 * maintainer immediately splits again.
 *
 * Safety properties (this runs unattended alongside live workers):
 *   - Only ever selects rows with satoshis BELOW the split floor, so it can
 *     never consume an output the splitter could have used.
 *   - Confirmed-only by default: no unconfirmed ancestor chains, no ARC
 *     mempool-chain-limit storms.
 *   - Locks inputs with this process' owner id before signing; a failed
 *     broadcast releases them with a cooldown rather than leaving them stuck.
 *   - ARC 460 / missing-inputs archives the batch as phantom instead of
 *     retrying dead inventory forever.
 *   - Inputs are marked spent and the new output admitted in ONE database
 *     transaction, so inventory can never double-count the consolidation.
 *   - Bounded work per cycle (batch size × batches) so consolidation cannot
 *     monopolise the database or the ARC quota.
 *
 * Env:
 *   BSV_AUTO_CONSOLIDATE_DISABLED=true       - opt out
 *   BSV_AUTO_CONSOLIDATE_INTERVAL_MS         - default 300_000 (5 min)
 *   BSV_AUTO_CONSOLIDATE_TRIGGER_SATS        - default 3 × split floor
 *   BSV_AUTO_CONSOLIDATE_BATCH_SIZE          - default 500 inputs per TX
 *   BSV_AUTO_CONSOLIDATE_MAX_BATCHES         - default 4 per wallet per cycle
 *   BSV_AUTO_CONSOLIDATE_MIN_INPUT_SATS      - default 3 × per-input fee
 *   BSV_AUTO_CONSOLIDATE_MAX_INPUT_SATS      - default split floor − 1
 *   BSV_AUTO_CONSOLIDATE_INCLUDE_UNCONFIRMED - default false
 */

import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import * as bsv from 'bsv'
// BSV has no protocol-enforced dust limit — override the BTC-inherited default
;(bsv.Transaction as any).DUST_AMOUNT = 1
import { bsvConfig } from './bsv-config'
import { getMutatorControlState, logMutatorSkip } from './mutator-control'
import { getTreasuryTopicForWallet } from './treasury-topics'
import { withOverlayTransaction, refreshTopicCounts } from './overlay-repository'
import { getInventoryDiagnostic } from './utxo-inventory'
import { getMinSpendConfirmations } from './utxo-spend-policy'
import { broadcastSplitTransactionRaw } from './broadcast-raw-tx'
import { getLockOwnerId } from './utxo-locks'

// Size constants must mirror lib/utxo-maintainer.ts and the manual
// consolidation script, otherwise the fee we pay diverges from the fee the
// rest of the system assumes and ARC starts rejecting at the policy floor.
const SIGNED_P2PKH_INPUT_BYTES = 149
const P2PKH_OUTPUT_BYTES = 34
const TX_BASE_BYTES = 12
const DUST_LIMIT = 1

const FEE_RATE = Number(
  (process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE) || 0.1025,
)
const SPLIT_OUTPUT_SATS = Math.max(1, Number(process.env.BSV_UTXO_SPLIT_OUTPUT_SATS || 2000))

function txBytes(numInputs: number, numOutputs: number): number {
  const inVarBytes = numInputs > 65535 ? 5 : numInputs > 252 ? 3 : 1
  const outVarBytes = numOutputs > 65535 ? 5 : numOutputs > 252 ? 3 : 1
  return (
    4 + inVarBytes + outVarBytes + 4 +
    numInputs * SIGNED_P2PKH_INPUT_BYTES +
    numOutputs * P2PKH_OUTPUT_BYTES
  )
}

function feeFor(numInputs: number, numOutputs: number): number {
  return Math.ceil(txBytes(numInputs, numOutputs) * FEE_RATE)
}

/**
 * Smallest input the splitter can actually use: two split outputs plus the
 * fee for a 1-in/3-out split. Mirrors estimateSplitRequirement(2) in
 * lib/utxo-maintainer.ts.
 */
function splitFloorSats(): number {
  const fee = Math.ceil((TX_BASE_BYTES + SIGNED_P2PKH_INPUT_BYTES + 3 * P2PKH_OUTPUT_BYTES) * FEE_RATE)
  return 2 * SPLIT_OUTPUT_SATS + fee + DUST_LIMIT
}

const ENABLED = process.env.BSV_AUTO_CONSOLIDATE_DISABLED !== 'true'
const INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.BSV_AUTO_CONSOLIDATE_INTERVAL_MS || 300_000),
)
const BATCH_SIZE = Math.min(
  1000,
  Math.max(10, Number(process.env.BSV_AUTO_CONSOLIDATE_BATCH_SIZE || 500)),
)
const MAX_BATCHES_PER_WALLET = Math.max(
  1,
  Number(process.env.BSV_AUTO_CONSOLIDATE_MAX_BATCHES || 4),
)
const MIN_INPUT_SATS = Math.max(
  1,
  Number(
    process.env.BSV_AUTO_CONSOLIDATE_MIN_INPUT_SATS ||
      Math.ceil(SIGNED_P2PKH_INPUT_BYTES * FEE_RATE * 3),
  ),
)
const INCLUDE_UNCONFIRMED = process.env.BSV_AUTO_CONSOLIDATE_INCLUDE_UNCONFIRMED === 'true'
const UNCONFIRMED_MIN_AGE_SECONDS = Math.max(
  60,
  Number(process.env.BSV_AUTO_CONSOLIDATE_UNCONFIRMED_MIN_AGE_SECONDS || 300),
)
const STATEMENT_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.BSV_AUTO_CONSOLIDATE_STATEMENT_TIMEOUT_MS || 120_000),
)
// A freshly consolidated output is unconfirmed, so when the spend policy
// requires confirmations the wallet still looks starved on the next cycle.
// Without a cooldown we would keep sweeping dust the wallet no longer needs.
const COOLDOWN_MS = Math.max(
  INTERVAL_MS,
  Number(process.env.BSV_AUTO_CONSOLIDATE_COOLDOWN_MS || 20 * 60_000),
)
const cooldownUntilByWallet = new Map<number, number>()

function triggerSats(): number {
  const override = Number(process.env.BSV_AUTO_CONSOLIDATE_TRIGGER_SATS || 0)
  if (Number.isFinite(override) && override > 0) return Math.floor(override)
  return splitFloorSats() * 3
}

function maxInputSats(): number {
  const override = Number(process.env.BSV_AUTO_CONSOLIDATE_MAX_INPUT_SATS || 0)
  if (Number.isFinite(override) && override > 0) return Math.floor(override)
  // Never eat an output the splitter could have used as its input.
  return Math.max(MIN_INPUT_SATS, splitFloorSats() - 1)
}

interface WalletBinding {
  walletIndex: number
  label: string
  wif: string
  address: string
  outputScriptHex: string
  topic: string
}

function deriveBindings(): WalletBinding[] {
  const wifs = (bsvConfig?.wallets?.privateKeys || []).filter((k): k is string => !!k)
  return wifs.map((wif, walletIndex) => {
    const key = SDKPrivateKey.fromWif(wif)
    const address = key.toPublicKey().toAddress().toString()
    const pubKeyHash = Buffer.from(key.toPublicKey().toHash()).toString('hex')
    return {
      walletIndex,
      label: `W${walletIndex + 1}`,
      wif,
      address,
      outputScriptHex: `76a914${pubKeyHash}88ac`,
      topic: getTreasuryTopicForWallet(walletIndex),
    }
  })
}

interface LockedInput {
  topic: string
  txid: string
  vout: number
  satoshis: number
  outputScript: string
}

/**
 * Two-phase select-then-update (rather than FOR UPDATE SKIP LOCKED) so the
 * planner can use overlay_admitted_utxos_acquire_ready_idx — a single-phase
 * ordered lock scan times out on a large heap.
 *
 * Largest-first: starvation is cleared fastest by the highest-value dust, and
 * every candidate is already below the split floor.
 */
async function lockDustBatch(binding: WalletBinding, lockedBy: string): Promise<LockedInput[]> {
  return withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)

    const pick = await client.query<{ topic: string; txid: string; vout: number }>(
      `SELECT topic, txid, vout
         FROM overlay_admitted_utxos
        WHERE wallet_index = $1
          AND removed = false
          AND locked = false
          AND satoshis >= $2
          AND satoshis <= $3
          AND acquirable_at <= now()
          AND ($4::boolean = true OR confirmed = true)
          AND (confirmed = true OR admitted_at <= now() - ($5::bigint * interval '1 second'))
        ORDER BY satoshis DESC, admitted_at ASC
        LIMIT $6`,
      [
        binding.walletIndex,
        MIN_INPUT_SATS,
        maxInputSats(),
        INCLUDE_UNCONFIRMED,
        UNCONFIRMED_MIN_AGE_SECONDS,
        BATCH_SIZE,
      ],
    )
    if (pick.rows.length === 0) return []

    const res = await client.query<{
      topic: string
      txid: string
      vout: number
      satoshis: string
      output_script: string
    }>(
      `UPDATE overlay_admitted_utxos u
          SET locked = true,
              locked_by = $4,
              locked_at = now()
         FROM unnest($1::text[], $2::text[], $3::int[]) AS t(topic, txid, vout)
        WHERE u.topic = t.topic
          AND u.txid = t.txid
          AND u.vout = t.vout
          AND u.removed = false
          AND u.locked = false
       RETURNING u.topic, u.txid, u.vout, u.satoshis, u.output_script`,
      [
        pick.rows.map((r) => r.topic),
        pick.rows.map((r) => r.txid),
        pick.rows.map((r) => r.vout),
        lockedBy,
      ],
    )

    return res.rows.map((row) => ({
      topic: row.topic,
      txid: row.txid,
      vout: row.vout,
      satoshis: Number(row.satoshis),
      outputScript: row.output_script,
    }))
  })
}

async function releaseBatch(inputs: LockedInput[], lockedBy: string, cooldownMs: number): Promise<void> {
  if (inputs.length === 0) return
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
          AND u.locked_by = $4`,
      [
        inputs.map((i) => i.topic),
        inputs.map((i) => i.txid),
        inputs.map((i) => i.vout),
        lockedBy,
        cooldownMs,
      ],
    )
  })
}

async function archivePhantomBatch(inputs: LockedInput[], reason: string): Promise<number> {
  if (inputs.length === 0) return 0
  return withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    const res = await client.query<{ topic: string }>(
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
        inputs.map((i) => i.topic),
        inputs.map((i) => i.txid),
        inputs.map((i) => i.vout),
        reason.substring(0, 64),
      ],
    )
    const byTopic = new Map<string, number>()
    for (const row of res.rows) byTopic.set(row.topic, (byTopic.get(row.topic) || 0) + 1)
    for (const [topic, delta] of byTopic) await refreshTopicCounts(client, topic, -delta)
    return res.rowCount ?? 0
  })
}

/** Mark every input spent and admit the consolidated output atomically. */
async function commitConsolidation(input: {
  binding: WalletBinding
  inputs: LockedInput[]
  spendingTxid: string
  rawTx: string
  outputSats: number
}): Promise<void> {
  await withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
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
      [
        input.inputs.map((i) => i.topic),
        input.inputs.map((i) => i.txid),
        input.inputs.map((i) => i.vout),
        input.spendingTxid,
      ],
    )
    if ((removed.rowCount || 0) !== input.inputs.length) {
      throw new Error(
        `expected to mark ${input.inputs.length} inputs spent, marked ${removed.rowCount || 0}`,
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
        input.binding.topic,
        input.spendingTxid,
        input.outputSats,
        input.binding.outputScriptHex,
        input.rawTx,
        input.binding.walletIndex,
      ],
    )

    await refreshTopicCounts(client, input.binding.topic, 1 - input.inputs.length)
  })
}

function buildConsolidationTx(
  binding: WalletBinding,
  inputs: LockedInput[],
): { rawHex: string; fee: number; outputSats: number } {
  const fee = feeFor(inputs.length, 1)
  const inputSum = inputs.reduce((acc, i) => acc + i.satoshis, 0)
  const outputSats = inputSum - fee
  if (outputSats <= DUST_LIMIT) {
    throw new Error(`outputSats=${outputSats} (inputSum=${inputSum} fee=${fee})`)
  }

  const tx = new (bsv as any).Transaction()
  tx.from(
    inputs.map((i) => ({
      txId: i.txid,
      outputIndex: i.vout,
      address: binding.address,
      script: i.outputScript,
      satoshis: i.satoshis,
    })),
  )
  tx.to(binding.address, outputSats)
  // Explicit fee, no change output: the entire input sum minus fee is the output.
  tx.fee(fee)
  tx.sign((bsv as any).PrivateKey.fromWIF(binding.wif))
  return { rawHex: tx.serialize(), fee, outputSats }
}

function isMissingInputsError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('missing inputs') ||
    lower.includes('missing-inputs') ||
    lower.includes('parent transaction not found') ||
    /\b460\b/.test(lower)
  )
}

interface WalletResult {
  batches: number
  inputsSpent: number
  satsRecovered: number
  archived: number
}

async function consolidateWallet(binding: WalletBinding, lockedBy: string): Promise<WalletResult> {
  const result: WalletResult = { batches: 0, inputsSpent: 0, satsRecovered: 0, archived: 0 }
  const floor = splitFloorSats()

  for (let batch = 0; batch < MAX_BATCHES_PER_WALLET; batch++) {
    const inputs = await lockDustBatch(binding, lockedBy)
    if (inputs.length === 0) break

    const inputSum = inputs.reduce((acc, i) => acc + i.satoshis, 0)
    const projectedOutput = inputSum - feeFor(inputs.length, 1)
    if (projectedOutput < floor) {
      // Sweeping this dust would not even produce a splittable output; paying
      // the fee would burn value for nothing. Back the rows off for an hour.
      await releaseBatch(inputs, lockedBy, 60 * 60_000)
      console.warn(
        `⚠️  [auto-consolidate] ${binding.label}: ${inputs.length} dust input(s) worth ` +
          `${inputSum.toLocaleString()} sats would yield ${projectedOutput.toLocaleString()} sats ` +
          `(< floor ${floor.toLocaleString()}) — skipping, wallet needs external funding.`,
      )
      break
    }

    let built: { rawHex: string; fee: number; outputSats: number }
    try {
      built = buildConsolidationTx(binding, inputs)
    } catch (err) {
      await releaseBatch(inputs, lockedBy, 10 * 60_000)
      console.error(
        `❌ [auto-consolidate] ${binding.label}: build failed — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      break
    }

    let txid: string
    try {
      txid = await broadcastSplitTransactionRaw(built.rawHex)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isMissingInputsError(message)) {
        const archived = await archivePhantomBatch(inputs, 'auto-consolidate-missing-inputs')
        result.archived += archived
        console.warn(
          `🗑️  [auto-consolidate] ${binding.label}: ARC missing-inputs — archived ${archived} ` +
            `phantom row(s) and continuing.`,
        )
        continue
      }
      await releaseBatch(inputs, lockedBy, 10 * 60_000)
      console.error(
        `❌ [auto-consolidate] ${binding.label}: broadcast failed — ` +
          `${message.split('\n')[0].substring(0, 200)}. Released ${inputs.length} lock(s).`,
      )
      break
    }

    try {
      await commitConsolidation({
        binding,
        inputs,
        spendingTxid: txid,
        rawTx: built.rawHex,
        outputSats: built.outputSats,
      })
    } catch (err) {
      // The TX is on-chain but inventory did not record it. Stop immediately:
      // continuing risks selecting the same inputs again and double-spending.
      console.error(
        `🚨 [auto-consolidate] ${binding.label}: TX ${txid} BROADCAST OK but inventory commit ` +
          `FAILED — ${err instanceof Error ? err.message : String(err)}. Halting this wallet; ` +
          `reconcile with \`npx tsx scripts/recovery-import-onchain-utxos.ts --apply\`.`,
      )
      await releaseBatch(inputs, lockedBy, 30 * 60_000)
      break
    }

    result.batches += 1
    result.inputsSpent += inputs.length
    result.satsRecovered += built.outputSats
    console.log(
      `♻️  [auto-consolidate] ${binding.label}: swept ${inputs.length.toLocaleString()} dust input(s) ` +
        `into ${built.outputSats.toLocaleString()} sats reserve (fee=${built.fee.toLocaleString()}) txid=${txid}`,
    )

    // Partial batch means the eligible dust is exhausted.
    if (inputs.length < BATCH_SIZE) break
  }

  return result
}

async function runCycle(): Promise<void> {
  const bindings = deriveBindings()
  if (bindings.length === 0) return

  const lockedBy = `auto-consolidate:${getLockOwnerId()}`
  const trigger = triggerSats()
  const confirmedOnly = getMinSpendConfirmations() > 0

  for (const binding of bindings) {
    try {
      if ((cooldownUntilByWallet.get(binding.walletIndex) || 0) > Date.now()) continue

      const diag = await getInventoryDiagnostic(binding.walletIndex)
      const largestUsable = confirmedOnly ? diag.largestConfirmedSats : diag.largestSats
      if (largestUsable >= trigger) continue

      console.warn(
        `♻️  [auto-consolidate] ${binding.label} below split capital: largest usable ` +
          `${largestUsable.toLocaleString()} sats < trigger ${trigger.toLocaleString()} ` +
          `(live=${diag.totalLiveUtxos.toLocaleString()} utxos / ${diag.totalLiveSats.toLocaleString()} sats). ` +
          `Sweeping dust below ${maxInputSats().toLocaleString()} sats.`,
      )

      const res = await consolidateWallet(binding, lockedBy)
      if (res.batches === 0 && res.archived === 0) {
        console.warn(
          `♻️  [auto-consolidate] ${binding.label}: no eligible dust to sweep — ` +
            `wallet requires external funding.`,
        )
      } else {
        if (res.batches > 0) {
          cooldownUntilByWallet.set(binding.walletIndex, Date.now() + COOLDOWN_MS)
        }
        console.log(
          `♻️  [auto-consolidate] ${binding.label} done: ${res.batches} batch(es), ` +
            `${res.inputsSpent.toLocaleString()} inputs → ${res.satsRecovered.toLocaleString()} sats` +
            `${res.archived > 0 ? `, ${res.archived.toLocaleString()} phantom(s) archived` : ''}.`,
        )
      }
    } catch (err) {
      console.warn(
        `⚠️  [auto-consolidate] ${binding.label} cycle failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

let timer: NodeJS.Timeout | null = null
let running = false

async function guardedCycle(): Promise<void> {
  if (running) return
  running = true
  try {
    await runCycle()
  } catch (err) {
    console.warn(
      `⚠️  [auto-consolidate] cycle failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    running = false
  }
}

export function startUtxoAutoConsolidate(): void {
  if (!ENABLED) {
    console.log('[auto-consolidate] disabled via BSV_AUTO_CONSOLIDATE_DISABLED')
    return
  }
  const mutatorControl = getMutatorControlState()
  if (!mutatorControl.mutatorsEnabled) {
    logMutatorSkip('utxo-auto-consolidate')
    return
  }
  if (timer) return

  // Start after the maintainer and funding-admit have had a cycle: a wallet
  // that is merely awaiting an inbound top-up should be fixed by admission,
  // not by burning fees on dust.
  setTimeout(() => {
    void guardedCycle()
    timer = setInterval(() => {
      void guardedCycle()
    }, INTERVAL_MS)
  }, 120_000)

  console.log(
    `♻️  [auto-consolidate] started: intervalMs=${INTERVAL_MS} trigger=${triggerSats()} sats ` +
      `batch=${BATCH_SIZE}×${MAX_BATCHES_PER_WALLET} inputRange=${MIN_INPUT_SATS}..${maxInputSats()} sats ` +
      `includeUnconfirmed=${INCLUDE_UNCONFIRMED}`,
  )
}

export function stopUtxoAutoConsolidate(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
