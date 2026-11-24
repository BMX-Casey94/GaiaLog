/**
 * UTXO Auto-Replenisher — long-running process that monitors the emergency
 * UTXO pool and automatically splits large UTXOs when spendable counts
 * drop below a threshold.
 *
 * Managed by PM2 via ecosystem.config.cjs, which supplies the environment.
 * This process deliberately does not load `.env` itself: PM2's `--update-env`
 * is the operator's authority over a running worker, and a stray `.env.local`
 * silently overriding it would be a surprise.
 *
 * Signing: `@bsv/sdk@2.8.11`. Every split is built with an explicit fee
 * computed from the signed transaction size; the SDK's fee models are never
 * used because they size the pre-sign transaction and under-pay by a wide
 * margin, which ARC rejects.
 */

import { P2PKH } from '@bsv/sdk'
import { DEFAULT_TX_FEE_RATE, bsvConfig } from '../lib/bsv-config'
import { broadcastSplitTransactionRaw } from '../lib/broadcast-raw-tx'
import { buildSplitTx } from '../lib/broadcast/tx-builder'

/**
 * Effective fee rate in satoshis per byte.
 *
 * The split-specific override is honoured first so this process can be tuned
 * independently, then the shared operator standard, then the single default
 * from `lib/bsv-config.ts`.
 */
function resolveFeeRateSatPerByte(): number {
  const raw =
    process.env.BSV_UTXO_SPLIT_FEE_RATE_SAT_PER_BYTE ||
    process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ||
    process.env.BSV_TX_FEE_RATE
  const parsed = Number.parseFloat(String(raw ?? '').trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TX_FEE_RATE
}

/**
 * Size of each split output, in satoshis.
 *
 * Default 2000, matching `lib/utxo-maintainer.ts` and `lib/utxo-auto-consolidate.ts`.
 * The two libraries compute the smallest input the splitter can use as
 * `2 × SPLIT_OUTPUT_SATS + splitFee + 1`; a replenisher defaulting to a much
 * smaller figure produced outputs that were individually spendable but could
 * never fund a split, so every split left the next cycle one step closer to
 * sub-fee dust. At 2000 sats a 1-input/3-output split costs roughly 5,700 sats
 * at 0.1 sat/byte, which keeps a two-output split comfortably above its own fee.
 * Override with BSV_UTXO_SPLIT_OUTPUT_SATS, but keep it in step with the
 * maintainer or the replenisher will build inventory the maintainer cannot use.
 */
const SPLIT_OUTPUT_SATS = Number(process.env.BSV_UTXO_SPLIT_OUTPUT_SATS || 2000)
const FEE_RATE = resolveFeeRateSatPerByte()
const MAX_OUTPUTS_PER_TX = 2500
const LARGE_UTXO_THRESHOLD = Number(process.env.BSV_UTXO_SPLIT_MIN_INPUT_SATS || 5000)
const MANAGER_URL = process.env.GAIALOG_EMERGENCY_UTXO_MANAGER_URL || 'http://127.0.0.1:8787'
const MANAGER_SECRET = process.env.GAIALOG_EMERGENCY_UTXO_MANAGER_SECRET || ''

const MIN_SPENDABLE_THRESHOLD = Number(process.env.BSV_UTXO_REPLENISH_THRESHOLD || 500)
const CHECK_INTERVAL_MS = Number(process.env.BSV_UTXO_REPLENISH_INTERVAL_MS || 60_000)

// BSV has no protocol-enforced dust limit (unlike BTC's 546). 1 sat is the minimum viable output.
const DUST_LIMIT = 1
// Conservative size constants — must match lib/utxo-maintainer.ts.
const SPLIT_INPUT_BYTES = 149
const SPLIT_P2PKH_OUTPUT_BYTES = 34
const SPLIT_BASE_BYTES = 12

function estimateSplitBytes(outputCount: number): number {
  // Split outputs plus one change output.
  return SPLIT_BASE_BYTES + SPLIT_INPUT_BYTES + (outputCount + 1) * SPLIT_P2PKH_OUTPUT_BYTES
}

function estimateSplitFee(outputCount: number): number {
  return Math.max(1, Math.ceil(estimateSplitBytes(outputCount) * FEE_RATE))
}

const WALLETS = [
  { wif: process.env.BSV_WALLET_1_PRIVATE_KEY!, address: process.env.BSV_WALLET_1_ADDRESS! },
  { wif: process.env.BSV_WALLET_2_PRIVATE_KEY!, address: process.env.BSV_WALLET_2_ADDRESS! },
  { wif: process.env.BSV_WALLET_3_PRIVATE_KEY!, address: process.env.BSV_WALLET_3_ADDRESS! },
].filter((w) => w.wif && w.address)

let running = true

process.on('SIGINT', () => {
  running = false
})
process.on('SIGTERM', () => {
  running = false
})

async function managerGet(path: string): Promise<any> {
  const resp = await fetch(`${MANAGER_URL}${path}`, { signal: AbortSignal.timeout(15_000) })
  return resp.json()
}

async function managerPost(path: string, body: any): Promise<any> {
  const resp = await fetch(`${MANAGER_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(MANAGER_SECRET ? { 'x-gaialog-utxo-manager-secret': MANAGER_SECRET } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return resp.json()
}

async function getSpendableCount(address: string): Promise<number> {
  const utxos = await managerGet(`/utxos/${address}?minSatoshis=${SPLIT_OUTPUT_SATS}`)
  return Array.isArray(utxos) ? utxos.length : 0
}

async function splitForWallet(wif: string, address: string): Promise<boolean> {
  const utxos = await managerGet(`/utxos/${address}?minSatoshis=${LARGE_UTXO_THRESHOLD}`)
  if (!Array.isArray(utxos) || utxos.length === 0) {
    console.log(`  [${address.substring(0, 10)}] No large UTXOs (>= ${LARGE_UTXO_THRESHOLD} sats) available to split`)
    return false
  }

  utxos.sort((a: any, b: any) => Number(b?.value) - Number(a?.value))
  const utxo = utxos[0]
  const inputSats = Number(utxo?.value) || 0
  const inputTxid = String(utxo?.tx_hash || '')
  const inputVout = Number(utxo?.tx_pos ?? 0)

  if (!Number.isSafeInteger(inputSats) || inputSats <= 0) {
    console.log(`  [${address.substring(0, 10)}] Manager returned an invalid UTXO value (${utxo?.value}) — skipping`)
    return false
  }
  if (!/^[0-9a-fA-F]{64}$/.test(inputTxid) || !Number.isInteger(inputVout) || inputVout < 0) {
    console.log(
      `  [${address.substring(0, 10)}] Manager returned a malformed outpoint (${inputTxid}:${inputVout}) — skipping`,
    )
    return false
  }

  // Target as many outputs as the input can carry, then shrink until the
  // explicit fee and the change output still fit. The old `inputSats /
  // (SPLIT_OUTPUT_SATS + 10)` guess ignored the real per-output fee.
  let outputCount = Math.min(
    MAX_OUTPUTS_PER_TX,
    Math.floor((inputSats - DUST_LIMIT) / (SPLIT_OUTPUT_SATS + SPLIT_P2PKH_OUTPUT_BYTES * FEE_RATE)),
  )
  while (
    outputCount >= 2 &&
    inputSats < outputCount * SPLIT_OUTPUT_SATS + estimateSplitFee(outputCount) + DUST_LIMIT
  ) {
    outputCount -= 1
  }
  if (outputCount < 2) {
    console.log(`  [${address.substring(0, 10)}] Largest UTXO (${inputSats} sats) too small to split`)
    return false
  }

  const fee = estimateSplitFee(outputCount)
  const change = inputSats - outputCount * SPLIT_OUTPUT_SATS - fee
  if (change < DUST_LIMIT) {
    console.log(
      `  [${address.substring(0, 10)}] Split would leave change=${change} sats below dust — skipping`,
    )
    return false
  }

  console.log(
    `  [${address.substring(0, 10)}] Splitting ${inputTxid.substring(0, 12)}...:${inputVout} (${inputSats} sats) into ${outputCount} x ${SPLIT_OUTPUT_SATS} sats`,
  )

  const p2pkh = new P2PKH()
  const lockingScriptHex = p2pkh.lock(address).toHex().toLowerCase()
  if (!/^76a914[0-9a-f]{40}88ac$/.test(lockingScriptHex)) {
    console.log(`  [${address.substring(0, 10)}] Derived locking script is not P2PKH (${lockingScriptHex}) — skipping`)
    return false
  }

  // Build through the shared builder so the same signed transaction yields both
  // the classic serialisation and the BRC-30 EF bytes the Broadcaster requires.
  // The fee is passed explicitly: it was sized above from the conservative
  // 149-byte-input estimate, which is marginally larger than the builder's own
  // estimate, so the transaction over-pays by at most a couple of satoshis
  // rather than risking a policy-floor rejection. Over-paying only shrinks the
  // change output.
  const built = await buildSplitTx({
    wif,
    input: { txid: inputTxid, vout: inputVout, satoshis: inputSats, lockingScriptHex },
    destinationAddress: address,
    outputCount,
    outputSats: SPLIT_OUTPUT_SATS,
    explicitFeeSats: fee,
  })
  const raw = built.rawHex
  const txid = built.txid
  const txSizeBytes = built.sizeBytes

  // The builder emits change only when the remainder reaches its 1-sat floor, so
  // a transaction sized for `outputCount` outputs normally produces
  // `outputCount + 1`. Verify the output set rather than assuming it, because
  // the overlay seeding below walks `built.outputs`.
  const splitOutputs = built.outputs.filter((output) => !output.isChange)
  if (splitOutputs.length !== outputCount) {
    console.log(
      `  [${address.substring(0, 10)}] Builder produced ${splitOutputs.length} split output(s), expected ${outputCount} — skipping`,
    )
    return false
  }
  if (splitOutputs.some((output) => output.satoshis !== SPLIT_OUTPUT_SATS)) {
    console.log(
      `  [${address.substring(0, 10)}] Builder produced a split output of the wrong value — skipping`,
    )
    return false
  }

  const builtChange = built.outputs
    .filter((output) => output.isChange)
    .reduce((sum, output) => sum + output.satoshis, 0)
  if (builtChange !== change) {
    console.log(
      `  [${address.substring(0, 10)}] Builder change ${builtChange} sats does not match the planned ${change} — skipping`,
    )
    return false
  }

  const totalOutputSats = built.outputs.reduce((sum, output) => sum + output.satoshis, 0)
  const actualFee = inputSats - totalOutputSats
  if (actualFee < fee) {
    console.log(
      `  [${address.substring(0, 10)}] Built TX pays ${actualFee} sats, below the ${fee} sat target — skipping`,
    )
    return false
  }

  console.log(
    `  [${address.substring(0, 10)}] TX: ${txSizeBytes} bytes, ${built.outputs.length} outputs, fee=${actualFee} sats (${(actualFee / txSizeBytes).toFixed(3)} sat/byte)`,
  )

  const broadcastTxid = await broadcastSplitTransactionRaw(raw, built.efBytes)
  if (broadcastTxid.toLowerCase() !== txid) {
    console.log(
      `  [${address.substring(0, 10)}] Broadcaster returned ${broadcastTxid} but the signed TX hashes to ${txid} — not seeding inventory`,
    )
    return false
  }
  console.log(`  [${address.substring(0, 10)}] Broadcast OK: ${broadcastTxid}`)

  const newUtxos: any[] = built.outputs.map((output) => ({
    txid: broadcastTxid,
    vout: output.vout,
    satoshis: output.satoshis,
    confirmed: false,
  }))

  const seedResult = await managerPost('/admin/seed', {
    address,
    replace: false,
    utxos: newUtxos,
  })
  console.log(`  [${address.substring(0, 10)}] Seeded ${seedResult.utxos || 0} UTXOs into manager`)

  await managerPost('/consume-admit', {
    address,
    spentTxid: inputTxid,
    spentVout: inputVout,
    spendingTxid: broadcastTxid,
  })
  console.log(`  [${address.substring(0, 10)}] Consumed spent input`)
  return true
}

async function checkAndReplenish(): Promise<void> {
  for (const { wif, address } of WALLETS) {
    if (!running) break
    try {
      const spendable = await getSpendableCount(address)
      if (spendable < MIN_SPENDABLE_THRESHOLD) {
        console.log(
          `⚡ [${address.substring(0, 10)}] Spendable=${spendable} < threshold=${MIN_SPENDABLE_THRESHOLD} — splitting`,
        )
        await splitForWallet(wif, address)
      }
    } catch (err: any) {
      console.error(`❌ [${address.substring(0, 10)}] Error: ${err?.message || err}`)
    }
  }
}

async function main(): Promise<void> {
  if (bsvConfig.network !== 'mainnet') {
    throw new Error(`Refusing to run on ${bsvConfig.network}: GaiaLog is mainnet only.`)
  }
  if (WALLETS.length === 0) {
    throw new Error(
      'No wallets configured. Set BSV_WALLET_1_PRIVATE_KEY + BSV_WALLET_1_ADDRESS (and optionally W2 / W3).',
    )
  }
  if (SPLIT_OUTPUT_SATS < DUST_LIMIT + 50) {
    throw new Error(`BSV_UTXO_SPLIT_OUTPUT_SATS (${SPLIT_OUTPUT_SATS}) is too small to be spendable`)
  }

  console.log(`🔄 UTXO Auto-Replenisher started`)
  console.log(
    `   Split size: ${SPLIT_OUTPUT_SATS} sats | Min input: ${LARGE_UTXO_THRESHOLD} sats | Max outputs/tx: ${MAX_OUTPUTS_PER_TX}`,
  )
  console.log(
    `   Threshold: ${MIN_SPENDABLE_THRESHOLD} spendable | Check interval: ${CHECK_INTERVAL_MS / 1000}s | Fee: ${FEE_RATE} sat/byte`,
  )
  console.log(`   Wallets: ${WALLETS.length}`)
  console.log()

  while (running) {
    try {
      const health = await managerGet('/health')
      console.log(`📊 Pool: ${health.utxos} total UTXOs across ${health.wallets} wallets`)
      await checkAndReplenish()
    } catch (err: any) {
      console.error(`❌ Health check failed: ${err?.message || err}`)
    }

    for (let waited = 0; waited < CHECK_INTERVAL_MS && running; waited += 1000) {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  console.log('🛑 UTXO Auto-Replenisher shutting down')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
