#!/usr/bin/env npx tsx
/**
 * UTXO splitter (Mainnet).
 *
 * Usage:
 *   npm run split:utxos -- --wallet 0 --outputs 200 --amount 2000 --dry-run
 *   npm run split:utxos -- --wallet 0 --outputs 200 --amount 2000
 *
 * `--dry-run` prints the built transaction summary without broadcasting.
 * Without the flag the transaction is broadcast.
 *
 * Env: loads `.env` then `.env.local` (local overrides). Set BSV_* keys on the VPS `.env`.
 * Fee: resolved inside `lib/broadcast/tx-builder.ts`
 * (BSV_TX_FEE_RATE_SAT_PER_BYTE → BSV_TX_FEE_RATE → DEFAULT_TX_FEE_RATE) and applied
 * to the *signed* size, so a signature-length change cannot leave the transaction
 * a satoshi under the policy floor.
 * UTXO source: shared `getUnspentForAddress` (overlay when BSV_SPEND_SOURCE_MODE=overlay,
 * otherwise the Bitails indexer). WhatsOnChain address lookups are refused by policy.
 * Broadcast: BSV Broadcaster (Arcade) first, using the transaction's BRC-30 EF
 * bytes, then the legacy TAAL ARC → GorillaPool ARC → WoC chain
 * (`lib/broadcast-raw-tx.ts`).
 *
 * Signing: `@bsv/sdk@2.8.11` only, via `buildSplitTx`. Each input is signed with an
 * explicit (satoshis, lockingScript) source descriptor, which is what lets us spend
 * a UTXO without fetching its full parent transaction. A lightweight source
 * stand-in is attached after signing purely so the same signed transaction can be
 * serialised as BRC-30 EF: EF embeds only `(satoshis, lockingScript)` per input and
 * never the parent body, so the stand-in produces a spec-compliant payload.
 */

import './load-env-for-tools'

import { bsvConfig } from '../lib/bsv-config'
import { getUnspentForAddress } from '../lib/utxo-provider'
import { broadcastSplitTransactionRaw } from '../lib/broadcast-raw-tx'
import {
  InsufficientFundsError,
  addressFromWif,
  buildSplitTx,
  p2pkhLockingScriptHexFromWif,
} from '../lib/broadcast/tx-builder'

// BSV has no protocol-enforced dust limit (unlike BTC's 546). 1 sat is the minimum viable output.
const DUST_LIMIT = 1

type Args = {
  wallet: number
  outputs: number
  amount: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { wallet: 0, outputs: 100, amount: 2000, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--wallet' && argv[i + 1]) args.wallet = Number(argv[++i])
    else if (a === '--outputs' && argv[i + 1]) args.outputs = Number(argv[++i])
    else if (a === '--amount' && argv[i + 1]) args.amount = Number(argv[++i])
    else if (a === '--dry-run') args.dryRun = true
  }
  return args
}

async function main() {
  const { wallet, outputs, amount, dryRun } = parseArgs(process.argv.slice(2))

  if (bsvConfig.network !== 'mainnet') {
    throw new Error(`Refusing to split on ${bsvConfig.network}: GaiaLog is mainnet only.`)
  }
  if (!Number.isInteger(outputs) || outputs <= 0 || outputs > 1000) {
    throw new Error('outputs must be an integer 1..1000')
  }
  if (!Number.isInteger(amount) || amount < DUST_LIMIT + 50) {
    throw new Error(`amount must be an integer >= ${DUST_LIMIT + 50} sats`)
  }

  // Resolve WIFs in the same order as `lib/bsv-config.ts` / wallet manager
  const wifs: string[] = []
  const primary = process.env.BSV_PRIVATE_KEY
  if (primary) wifs.push(primary)
  ;['BSV_WALLET_1_PRIVATE_KEY', 'BSV_WALLET_2_PRIVATE_KEY', 'BSV_WALLET_3_PRIVATE_KEY'].forEach((k) => {
    const v = process.env[k]
    if (v && !wifs.includes(v)) wifs.push(v)
  })
  if (wifs.length === 0) throw new Error('No wallet WIFs configured')
  if (!Number.isInteger(wallet) || wallet < 0 || wallet >= wifs.length) {
    throw new Error(`wallet index ${wallet} out of range (0..${wifs.length - 1})`)
  }

  const wif = wifs[wallet]
  const address = addressFromWif(wif)
  if (!address.startsWith('1')) {
    // A testnet key would sign a transaction for a chain GaiaLog does not use.
    throw new Error(`Wallet ${wallet} resolves to ${address}, which is not a Mainnet P2PKH address.`)
  }
  const lockingScriptHex = p2pkhLockingScriptHexFromWif(wif)
  if (!/^76a914[0-9a-f]{40}88ac$/.test(lockingScriptHex)) {
    throw new Error(`Derived locking script for ${address} is not P2PKH: ${lockingScriptHex}`)
  }

  console.log(`Splitting wallet ${wallet} (${address}) → ${outputs} outputs x ${amount} sats [dryRun=${dryRun}]`)

  // Include mempool + confirmed (matches the previous unspent/all behaviour).
  const utxos = await getUnspentForAddress(address, { confirmedOnly: false })
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error(
      'No UTXOs returned from the provider (check BSV_UTXO_PROVIDER / Bitails, BSV_SPEND_SOURCE_MODE, and BSV_OVERLAY_LOOKUP_URL for treasury wallets)',
    )
  }
  const largest = utxos.slice().sort((a: any, b: any) => (Number(b?.value) || 0) - (Number(a?.value) || 0))[0]
  const inputSats = Number(largest?.value) || 0
  const inputTxid = String(largest?.tx_hash || '')
  const inputVout = Number(largest?.tx_pos ?? 0)
  if (!/^[0-9a-fA-F]{64}$/.test(inputTxid) || !Number.isInteger(inputVout) || inputVout < 0) {
    throw new Error(`Provider returned a malformed UTXO (txid=${inputTxid}, vout=${inputVout})`)
  }

  // The builder owns fee sizing (from the signed size), change handling, and the
  // EF round-trip check. Its `emitChange`/`changeFloorSats` defaults are exactly
  // the previous behaviour: any remainder of 1 sat or more returns as change, and
  // anything smaller is left to the miner rather than emitted as dust.
  let built
  try {
    built = await buildSplitTx({
      wif,
      input: { txid: inputTxid, vout: inputVout, satoshis: inputSats, lockingScriptHex },
      destinationAddress: address,
      outputCount: outputs,
      outputSats: amount,
    })
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw new Error(
        `Largest UTXO ${inputSats.toLocaleString()} sats cannot fund ${outputs} × ${amount} ` +
          `(${(outputs * amount).toLocaleString()} sats of outputs) plus the fee. ${error.message}`,
      )
    }
    throw error
  }

  const changeSats = built.outputs
    .filter((output) => output.isChange)
    .reduce((sum, output) => sum + output.satoshis, 0)

  console.log(
    JSON.stringify(
      {
        address,
        selectedUtxo: { txid: inputTxid, vout: inputVout, value: inputSats },
        outputs,
        amountPerOutput: amount,
        changeOutput: changeSats,
        fee: built.feeSats,
        feeSatPerByte: Number((built.feeSats / Math.max(1, built.sizeBytes)).toFixed(4)),
        sizeBytes: built.sizeBytes,
        efBytes: built.efBytes.length,
        txid: built.txid,
        dryRun,
      },
      null,
      2,
    ),
  )

  if (dryRun) {
    console.log('Dry-run only. Not broadcasting.')
    return
  }

  const broadcastTxid = await broadcastSplitTransactionRaw(built.rawHex, built.efBytes)
  if (broadcastTxid.toLowerCase() !== built.txid) {
    throw new Error(
      `Broadcaster returned ${broadcastTxid} but the signed transaction hashes to ${built.txid}. ` +
        'Treat the broadcast as unknown and verify on chain before re-running.',
    )
  }
  console.log(`✅ Split broadcasted: ${broadcastTxid}`)
}

main().catch((e) => {
  console.error('split-utxos error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
