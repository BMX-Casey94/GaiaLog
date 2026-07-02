#!/usr/bin/env npx tsx
/**
 * Sweep all UTXOs from a recovery/disposable WIF into the three GaiaLog treasury wallets
 * (BSV_WALLET_1/2/3), split as evenly as possible.
 *
 * Security: never commit WIFs. Pass via env or a gitignored candidates file.
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
import * as bsv from 'bsv'
;(bsv.Transaction as any).DUST_AMOUNT = 1

import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import { getUnspentForAddress } from '../lib/utxo-provider'
import { broadcastSplitTransactionRaw } from '../lib/broadcast-raw-tx'

const FEE_RATE_SAT_PER_BYTE = Number(
  process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE ?? '0.1025',
)
const SIGNED_P2PKH_INPUT_BYTES = 149
const P2PKH_OUTPUT_BYTES = 34

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

function resolveTreasuryAddresses(): string[] {
  const keys = [
    process.env.BSV_WALLET_1_PRIVATE_KEY,
    process.env.BSV_WALLET_2_PRIVATE_KEY,
    process.env.BSV_WALLET_3_PRIVATE_KEY,
  ]
  const addresses: string[] = []
  for (let i = 0; i < keys.length; i++) {
    const wif = keys[i]
    const envAddr = process.env[`BSV_WALLET_${i + 1}_ADDRESS` as keyof NodeJS.ProcessEnv]
    if (wif && wif.length > 10 && !wif.includes('your_private_key')) {
      const addr = SDKPrivateKey.fromWif(wif).toPublicKey().toAddress().toString()
      addresses.push(addr)
    } else if (envAddr && envAddr.length > 20) {
      addresses.push(envAddr)
    }
  }
  if (addresses.length !== 3) {
    throw new Error(
      `Need 3 treasury destinations (BSV_WALLET_1/2/3_PRIVATE_KEY or _ADDRESS). Found ${addresses.length}.`,
    )
  }
  return addresses
}

function p2pkhScriptHexForAddress(address: string, wif: string): string {
  if ((bsv.Script as any).fromAddress) {
    return (bsv.Script as any).fromAddress(address).toHex()
  }
  const key = SDKPrivateKey.fromWif(wif)
  const pubKeyHash = Buffer.from(key.toPublicKey().toHash()).toString('hex')
  return '76a914' + pubKeyHash + '88ac'
}

async function probeWif(
  wif: string,
): Promise<
  | { ok: true; address: string; totalSats: number; utxoCount: number }
  | { ok: false; reason: string }
> {
  let address: string
  try {
    address = SDKPrivateKey.fromWif(wif).toPublicKey().toAddress().toString()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, reason }
  }
  const utxos = await getUnspentForAddress(address, { confirmedOnly: false })
  const totalSats = utxos.reduce((acc: number, u: any) => acc + (Number(u.value) || 0), 0)
  return { ok: true, address, totalSats, utxoCount: utxos.length }
}

async function sweep(wif: string, apply: boolean): Promise<void> {
  const sdkKey = SDKPrivateKey.fromWif(wif)
  const sourceAddress = sdkKey.toPublicKey().toAddress().toString()
  const destinations = resolveTreasuryAddresses()

  if (process.env.BSV_NETWORK !== 'mainnet') {
    console.warn('⚠️ BSV_NETWORK is not mainnet; ensure this is intentional.')
  }

  const utxos = await getUnspentForAddress(sourceAddress, { confirmedOnly: false })
  if (!utxos.length) {
    throw new Error(`No UTXOs for ${sourceAddress}`)
  }

  const scriptHex = p2pkhScriptHexForAddress(sourceAddress, wif)
  const inputs = utxos.map((u: any) => ({
    txId: u.tx_hash,
    outputIndex: u.tx_pos,
    address: sourceAddress,
    script: scriptHex,
    satoshis: Number(u.value) || 0,
  }))

  const inputSum = inputs.reduce((acc, i) => acc + i.satoshis, 0)
  const numOutputs = 3
  const fee = Math.ceil(estimateTxSize(inputs.length, numOutputs) * FEE_RATE_SAT_PER_BYTE)
  const distributable = inputSum - fee
  if (distributable < 3) {
    throw new Error(`Insufficient funds after fee: inputSum=${inputSum} fee=${fee}`)
  }

  const perWallet = Math.floor(distributable / 3)
  let remainder = distributable - perWallet * 3
  const outputAmounts = [perWallet, perWallet, perWallet]
  for (let i = 0; outputAmounts[i] !== undefined && remainder > 0; i++) {
    outputAmounts[i] += 1
    remainder -= 1
  }

  const tx = new (bsv as any).Transaction().from(inputs)
  for (let i = 0; i < destinations.length; i++) {
    tx.to(destinations[i], outputAmounts[i])
  }
  tx.fee(fee)
  const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
  tx.sign(signingKey)
  const rawHex = tx.serialize()

  console.log(
    JSON.stringify(
      {
        sourceAddress,
        inputCount: inputs.length,
        inputSum,
        fee,
        feeRateSatPerByte: FEE_RATE_SAT_PER_BYTE,
        outputs: destinations.map((addr, i) => ({
          address: addr,
          sats: outputAmounts[i],
          bsv: (outputAmounts[i] / 1e8).toFixed(8),
        })),
        txSizeBytes: rawHex.length / 2,
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

  const txid = await broadcastSplitTransactionRaw(rawHex)
  console.log(`✅ Sweep broadcast: ${txid}`)
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

  const sourceWif = wifs.length === 1 ? wifs[0] : wifs[0]
  if (wifs.length > 1) {
    console.warn('Multiple WIFs supplied; using the first. Use --probe to auto-select.')
  }
  await sweep(sourceWif, apply)
}

main().catch((err) => {
  console.error('sweep-to-treasury-wallets error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
