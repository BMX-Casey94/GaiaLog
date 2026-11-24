#!/usr/bin/env npx tsx
/**
 * Sweep all UTXOs from a recovery/disposable WIF into the configured GaiaLog
 * treasury wallets (BSV_WALLET_1, BSV_WALLET_2, BSV_WALLET_3), split as evenly
 * as the configured wallet count allows.
 *
 * Wallet count
 * ------------
 * One, two or three treasury destinations are supported. The script uses
 * whichever of BSV_WALLET_1/2/3 have a private key (or an `_ADDRESS` override)
 * and splits the sweepable balance evenly across them, so a deployment that has
 * consolidated onto a single unified treasury wallet still works — it simply
 * produces one output.
 *
 * Security: never commit WIFs. Pass via env or a gitignored candidates file.
 *
 * Broadcast: `broadcastSplitTransactionRaw(rawHex, efBytes)` — the BSV
 * Broadcaster (Arcade) is tried first with the sweep's BRC-30 EF bytes, so the
 * transaction gets synchronous policy/script validation and a lifecycle to
 * follow. The legacy TAAL → GorillaPool → WoC chain is the fallback when the
 * Broadcaster cannot be reached.
 *
 * Usage:
 *   # Probe which candidate WIF has funds (one WIF per line in file):
 *   npx tsx scripts/sweep-to-treasury-wallets.ts --probe --candidates-file scripts/.recovery-wifs.local
 *
 *   # Dry-run sweep for a known WIF:
 *   BSV_RECOVERY_SOURCE_WIF=<wif> npx tsx scripts/sweep-to-treasury-wallets.ts
 *
 *   # Broadcast:
 *   BSV_RECOVERY_SOURCE_WIF=<wif> npx tsx scripts/sweep-to-treasury-wallets.ts --apply
 */

import './load-env-for-tools'

import fs from 'node:fs'
import path from 'node:path'
import { P2PKH, PrivateKey } from '@bsv/sdk'
import { DEFAULT_TX_FEE_RATE, bsvConfig } from '../lib/bsv-config'
import { getUnspentForAddress } from '../lib/utxo-provider'
import { broadcastSplitTransactionRaw } from '../lib/broadcast-raw-tx'
import { buildPaymentTx } from '../lib/broadcast/tx-builder'

/**
 * Effective fee rate in satoshis per byte.
 *
 * `BSV_TX_FEE_RATE_SAT_PER_BYTE` is the explicit name, `BSV_TX_FEE_RATE` the
 * historical alias, and `DEFAULT_TX_FEE_RATE` the single shared fallback, so the
 * sweep cannot drift from the rest of the spend path.
 */
function resolveFeeRateSatPerByte(): number {
  const raw = process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE || process.env.BSV_TX_FEE_RATE
  const parsed = Number.parseFloat(String(raw ?? '').trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TX_FEE_RATE
}

const FEE_RATE_SAT_PER_BYTE = resolveFeeRateSatPerByte()
const SIGNED_P2PKH_INPUT_BYTES = 149 // worst-case signed P2PKH input
const P2PKH_OUTPUT_BYTES = 34 // 8 value + 1 scriptLen + 25 script
const MAX_TREASURY_WALLETS = 3

function txOverheadBytes(numInputs: number, numOutputs: number): number {
  const inputVarint = numInputs <= 252 ? 1 : numInputs <= 65535 ? 3 : 5
  const outputVarint = numOutputs <= 252 ? 1 : numOutputs <= 65535 ? 3 : 5
  return 8 + inputVarint + outputVarint
}

function estimateTxSize(numInputs: number, numOutputs: number): number {
  return (
    txOverheadBytes(numInputs, numOutputs) +
    numInputs * SIGNED_P2PKH_INPUT_BYTES +
    numOutputs * P2PKH_OUTPUT_BYTES
  )
}

function parseArgs(argv: string[]) {
  let apply = false
  let probe = false
  let candidatesFile: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--probe') probe = true
    else if (a === '--candidates-file' && argv[i + 1]) candidatesFile = argv[++i]
  }
  return { apply, probe, candidatesFile }
}

function loadCandidateWifs(candidatesFile: string | null): string[] {
  const fromEnv = (process.env.BSV_RECOVERY_SOURCE_WIF || '').trim()
  const listEnv = (process.env.BSV_RECOVERY_SOURCE_WIF_CANDIDATES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const fromFile: string[] = []
  if (candidatesFile) {
    const resolved = path.isAbsolute(candidatesFile)
      ? candidatesFile
      : path.join(process.cwd(), candidatesFile)
    if (!fs.existsSync(resolved)) {
      throw new Error(`Candidates file not found: ${resolved}`)
    }
    const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const w = line.trim()
      if (!w || w.startsWith('#')) continue
      fromFile.push(w)
    }
  }

  const merged = [...(fromEnv ? [fromEnv] : []), ...listEnv, ...fromFile]
  const unique: string[] = []
  for (const w of merged) {
    if (!unique.includes(w)) unique.push(w)
  }
  return unique
}

interface TreasuryDestination {
  label: string
  address: string
  lockingScriptHex: string
}

/**
 * Resolve the configured treasury destinations.
 *
 * Each slot contributes at most one destination: a private key wins over an
 * `_ADDRESS` override because the key is what the wallet manager derives from.
 * Slots are evaluated in order and empty slots are skipped, so a single-wallet
 * deployment (only BSV_WALLET_1_PRIVATE_KEY set) yields one destination while a
 * three-wallet deployment yields three.
 */
function resolveTreasuryDestinations(): TreasuryDestination[] {
  const destinations: TreasuryDestination[] = []
  const seen = new Set<string>()
  const p2pkh = new P2PKH()

  for (let i = 1; i <= MAX_TREASURY_WALLETS; i++) {
    const label = `W${i}`
    const wif = String(process.env[`BSV_WALLET_${i}_PRIVATE_KEY`] || '').trim()
    const envAddr = String(process.env[`BSV_WALLET_${i}_ADDRESS`] || '').trim()

    let address: string | null = null
    if (wif && wif.length > 10 && !wif.includes('your_private_key')) {
      try {
        address = PrivateKey.fromWif(wif).toPublicKey().toAddress().toString()
      } catch (err) {
        throw new Error(
          `BSV_WALLET_${i}_PRIVATE_KEY is not a valid WIF: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else if (envAddr.length > 20) {
      address = envAddr
    }

    if (!address) continue
    if (!address.startsWith('1')) {
      throw new Error(`${label}: treasury destination ${address} is not a Mainnet P2PKH address.`)
    }
    if (seen.has(address)) {
      // Two slots pointing at one address is a configuration mistake: the
      // "split evenly across wallets" maths would send two separate outputs
      // to the same place while reporting two destinations.
      throw new Error(`${label}: treasury destination ${address} is already used by another wallet slot.`)
    }
    seen.add(address)

    const lockingScriptHex = p2pkh.lock(address).toHex().toLowerCase()
    if (!/^76a914[0-9a-f]{40}88ac$/.test(lockingScriptHex)) {
      throw new Error(`${label}: derived locking script for ${address} is not P2PKH: ${lockingScriptHex}`)
    }
    destinations.push({ label, address, lockingScriptHex })
  }

  if (destinations.length === 0) {
    throw new Error(
      'No treasury destinations configured. Set BSV_WALLET_1_PRIVATE_KEY (or BSV_WALLET_1_ADDRESS) ' +
        'and optionally BSV_WALLET_2_* / BSV_WALLET_3_*.',
    )
  }
  return destinations
}

async function probeWif(
  wif: string,
): Promise<
  | { ok: true; address: string; totalSats: number; utxoCount: number }
  | { ok: false; reason: string }
> {
  let address: string
  try {
    address = PrivateKey.fromWif(wif).toPublicKey().toAddress().toString()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, reason }
  }
  const utxos = await getUnspentForAddress(address, { confirmedOnly: false })
  const totalSats = utxos.reduce((acc: number, u: any) => acc + (Number(u.value) || 0), 0)
  return { ok: true, address, totalSats, utxoCount: utxos.length }
}

async function sweep(wif: string, apply: boolean): Promise<void> {
  if (bsvConfig.network !== 'mainnet') {
    throw new Error(`Refusing to sweep on ${bsvConfig.network}: GaiaLog is mainnet only.`)
  }

  const sourceAddress = PrivateKey.fromWif(wif).toPublicKey().toAddress().toString()
  if (!sourceAddress.startsWith('1')) {
    throw new Error(`Source WIF resolves to ${sourceAddress}, which is not a Mainnet P2PKH address.`)
  }
  const destinations = resolveTreasuryDestinations()
  if (destinations.some((d) => d.address === sourceAddress)) {
    throw new Error(`Source address ${sourceAddress} is also a treasury destination — refusing to sweep to itself.`)
  }

  const p2pkh = new P2PKH()
  const sourceScriptHex = p2pkh.lock(sourceAddress).toHex().toLowerCase()

  const utxos = await getUnspentForAddress(sourceAddress, { confirmedOnly: false })
  if (!utxos.length) {
    throw new Error(`No UTXOs for ${sourceAddress}`)
  }

  const inputs = utxos.map((u: any) => {
    const txid = String(u?.tx_hash || '')
    const vout = Number(u?.tx_pos ?? 0)
    const satoshis = Number(u?.value) || 0
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new Error(`Provider returned a malformed UTXO txid "${txid}" for ${sourceAddress}`)
    }
    if (!Number.isInteger(vout) || vout < 0) {
      throw new Error(`Provider returned a malformed vout ${vout} for ${txid}`)
    }
    if (!Number.isSafeInteger(satoshis) || satoshis <= 0) {
      throw new Error(`Provider returned an invalid value ${satoshis} for ${txid}:${vout}`)
    }
    return { txid, vout, satoshis }
  })

  const inputSum = inputs.reduce((acc, i) => acc + i.satoshis, 0)
  const numOutputs = destinations.length
  const fee = Math.max(1, Math.ceil(estimateTxSize(inputs.length, numOutputs) * FEE_RATE_SAT_PER_BYTE))
  const distributable = inputSum - fee
  if (distributable < numOutputs) {
    throw new Error(
      `Insufficient funds after fee: inputSum=${inputSum} sats, fee=${fee} sats, ${numOutputs} destination(s) need at least 1 sat each.`,
    )
  }

  // Even split with the remainder spread one satoshi at a time from the first
  // destination onwards, so no satoshi is silently dropped.
  const perWallet = Math.floor(distributable / numOutputs)
  let remainder = distributable - perWallet * numOutputs
  const outputAmounts = destinations.map(() => perWallet)
  for (let i = 0; i < outputAmounts.length && remainder > 0; i++) {
    outputAmounts[i] += 1
    remainder -= 1
  }

  // The explicit fee and the exactly-distributed outputs leave a zero
  // remainder, so the builder emits no change output — a sweep that left change
  // behind would not be a sweep. `changeFloorSats: 2` makes that a rule rather
  // than an arithmetic coincidence: a stray 1-sat remainder goes to the miner
  // instead of becoming an unspendable output back at the source address.
  const built = await buildPaymentTx({
    wif,
    inputs: inputs.map((input) => ({
      txid: input.txid,
      vout: input.vout,
      satoshis: input.satoshis,
      lockingScriptHex: sourceScriptHex,
    })),
    outputs: destinations.map((destination, index) => ({
      address: destination.address,
      satoshis: outputAmounts[index],
    })),
    changeAddress: sourceAddress,
    explicitFeeSats: fee,
    changeFloorSats: 2,
  })

  const changeOutputs = built.outputs.filter((output) => output.isChange)
  if (changeOutputs.length > 0) {
    throw new Error(
      `Built sweep emitted ${changeOutputs.length} change output(s) back to ${sourceAddress}; ` +
        'a sweep must move the whole spendable balance out of the source wallet. Refusing to broadcast.',
    )
  }
  if (built.outputs.length !== destinations.length) {
    throw new Error(
      `Built sweep has ${built.outputs.length} output(s) but ${destinations.length} treasury destination(s) were requested.`,
    )
  }

  const rawHex = built.rawHex
  const efBytes = built.efBytes
  const txid = built.txid
  const outputSum = outputAmounts.reduce((acc, s) => acc + s, 0)
  const actualFee = inputSum - outputSum
  if (actualFee < fee) {
    throw new Error(`Built sweep pays ${actualFee} sats, below the ${fee} sat target — refusing to broadcast`)
  }

  console.log(
    JSON.stringify(
      {
        sourceAddress,
        inputCount: inputs.length,
        inputSum,
        fee: actualFee,
        feeRateSatPerByte: FEE_RATE_SAT_PER_BYTE,
        destinations: destinations.map((d, i) => ({
          wallet: d.label,
          address: d.address,
          sats: outputAmounts[i],
          bsv: (outputAmounts[i] / 1e8).toFixed(8),
        })),
        txSizeBytes: built.sizeBytes,
        efBytes: efBytes.length,
        txid,
        apply,
      },
      null,
      2,
    ),
  )

  if (!apply) {
    console.log('Dry-run only. Pass --apply to broadcast.')
    return
  }

  const broadcastTxid = await broadcastSplitTransactionRaw(rawHex, efBytes)
  if (broadcastTxid.toLowerCase() !== txid) {
    throw new Error(
      `Broadcaster returned ${broadcastTxid} but the signed sweep hashes to ${txid}. ` +
        'Treat the sweep as unknown: verify on chain before re-running.',
    )
  }
  console.log(`✅ Sweep broadcast: ${broadcastTxid}`)
}

async function main() {
  const { apply, probe, candidatesFile } = parseArgs(process.argv.slice(2))
  const wifs = loadCandidateWifs(candidatesFile)

  if (wifs.length === 0) {
    throw new Error(
      'No source WIF. Set BSV_RECOVERY_SOURCE_WIF, BSV_RECOVERY_SOURCE_WIF_CANDIDATES, or --candidates-file.',
    )
  }

  if (probe) {
    console.log(`Probing ${wifs.length} candidate WIF(s)…`)
    let best: { wif: string; address: string; totalSats: number; utxoCount: number } | null = null
    for (const wif of wifs) {
      const result = await probeWif(wif)
      if (!result.ok) {
        console.log(`  WIF …${wif.slice(-6)} invalid: ${result.reason}`)
        continue
      }
      console.log(
        `  ${result.address} → ${result.utxoCount} UTXO(s), ${(result.totalSats / 1e8).toFixed(8)} BSV`,
      )
      if (!best || result.totalSats > best.totalSats) {
        best = { wif, address: result.address, totalSats: result.totalSats, utxoCount: result.utxoCount }
      }
    }
    if (!best || best.totalSats === 0) {
      console.log('No funded address found among candidates.')
      process.exit(1)
    }
    console.log(`\nSelected funded source: ${best.address}`)
    await sweep(best.wif, false)
    return
  }

  if (wifs.length > 1) {
    console.warn('Multiple WIFs supplied; using the first. Use --probe to auto-select.')
  }
  await sweep(wifs[0], apply)
}

main().catch((err) => {
  console.error('sweep-to-treasury-wallets error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
