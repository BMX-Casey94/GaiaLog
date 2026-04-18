// Safe UTXO splitter (dry-run by default)
// Usage examples:
//   npm run split:utxos -- --wallet 0 --outputs 200 --amount 2000 --dry-run
//   npm run split:utxos -- --wallet 0 --outputs 200 --amount 2000
//
// Env: loads `.env` then `.env.local` (local overrides). Set BSV_* keys on the VPS `.env`.
// UTXO source: shared `getUnspentForAddress` (overlay when BSV_SPEND_SOURCE_MODE=overlay, else WoC).
// Broadcast: GorillaPool ARC → TAAL ARC → WoC (`lib/broadcast-raw-tx.ts`).

import './load-env-for-tools'

import * as bsv from 'bsv'
// BSV has no protocol-enforced dust limit — override the BTC-inherited default
;(bsv.Transaction as any).DUST_AMOUNT = 1
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import { getUnspentForAddress } from '../lib/utxo-provider'
import { broadcastSplitTransactionRaw } from '../lib/broadcast-raw-tx'

/** Operator standard 0.1025 sat/byte (102.5 sat/kB). Override via BSV_TX_FEE_RATE_SAT_PER_BYTE or BSV_TX_FEE_RATE. */
const FEE_RATE_SAT_PER_BYTE = Number(
  process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE ?? '0.1025',
)
// BSV has no protocol-enforced dust limit (unlike BTC's 546). 1 sat is the minimum viable output.
const DUST_LIMIT = 1
// Conservative size constants — must match lib/blockchain.ts and lib/utxo-maintainer.ts.
const SPLIT_INPUT_BYTES = 149
const SPLIT_P2PKH_OUTPUT_BYTES = 34
const SPLIT_BASE_BYTES = 12
function estimateSplitBytes(outputCount: number): number {
  return SPLIT_BASE_BYTES + SPLIT_INPUT_BYTES + (outputCount + 1) * SPLIT_P2PKH_OUTPUT_BYTES
}

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

  if (outputs <= 0 || outputs > 1000) throw new Error('outputs must be 1..1000')
  if (amount < DUST_LIMIT + 50) throw new Error(`amount must be >= ${DUST_LIMIT + 50} sats`)

  // Resolve WIFs in the same order as `lib/bsv-config.ts` / wallet manager
  const wifs: string[] = []
  const primary = process.env.BSV_PRIVATE_KEY
  if (primary) wifs.push(primary)
  ;['BSV_WALLET_1_PRIVATE_KEY', 'BSV_WALLET_2_PRIVATE_KEY', 'BSV_WALLET_3_PRIVATE_KEY'].forEach(k => {
    const v = process.env[k]
    if (v && !wifs.includes(v)) wifs.push(v)
  })
  if (wifs.length === 0) throw new Error('No wallet WIFs configured')
  if (wallet < 0 || wallet >= wifs.length) {
    throw new Error(`wallet index ${wallet} out of range (0..${wifs.length - 1})`)
  }

  const wif = wifs[wallet]
  const sdkKey = SDKPrivateKey.fromWif(wif)
  const address = sdkKey.toPublicKey().toAddress().toString()

  const detected = address.startsWith('1') ? 'mainnet' : 'testnet'
  const configured = process.env.BSV_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  if (detected !== configured) {
    console.warn(
      `⚠️ WIF network (${detected}) differs from BSV_NETWORK (${configured}). Proceeding with configured network.`,
    )
  }

  console.log(`Splitting wallet ${wallet} (${address}) → ${outputs} outputs x ${amount} sats [dryRun=${dryRun}]`)

  // Include mempool + confirmed (matches prior unspent/all behaviour)
  const utxos = await getUnspentForAddress(address, { confirmedOnly: false })
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error(
      'No UTXOs returned from provider (check WoC/overlay, BSV_SPEND_SOURCE_MODE, and BSV_OVERLAY_LOOKUP_URL for treasury wallets)',
    )
  }
  const largest = utxos.slice().sort((a: any, b: any) => (b.value || 0) - (a.value || 0))[0]

  const targetTotal = outputs * amount
  const estimatedBytes = estimateSplitBytes(outputs)
  const estimatedFee = Math.ceil(estimatedBytes * FEE_RATE_SAT_PER_BYTE)
  const required = targetTotal + estimatedFee + DUST_LIMIT
  if (largest.value < required) {
    throw new Error(
      `Largest UTXO ${largest.value} sats insufficient for ${required} sats (outputs+fee+change)`,
    )
  }

  const scriptHex = (bsv.Script as any).fromAddress
    ? (bsv.Script as any).fromAddress(address).toHex()
    : (() => {
        const key = SDKPrivateKey.fromWif(wif)
        const pubKeyHash = Buffer.from(key.toPublicKey().toHash()).toString('hex')
        return '76a914' + pubKeyHash + '88ac'
      })()

  const input = {
    txId: largest.tx_hash,
    outputIndex: largest.tx_pos,
    address,
    script: scriptHex,
    satoshis: largest.value,
  }

  const tx = new (bsv as any).Transaction().from([input])
  for (let i = 0; i < outputs; i++) {
    tx.to(address, amount)
  }
  // Explicit fee — never tx.feePerKb(), which under-estimates pre-sign size by ~5x.
  tx.fee(estimatedFee).change(address)
  const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
  tx.sign(signingKey)

  const raw = tx.serialize()
  const fee = tx.getFee()
  const change = largest.value - targetTotal - fee
  console.log(
    JSON.stringify(
      {
        address,
        selectedUtxo: { txid: largest.tx_hash, vout: largest.tx_pos, value: largest.value },
        outputs,
        amountPerOutput: amount,
        fee,
        change,
        sizeBytes: raw.length / 2,
        feeRateSatPerByte: FEE_RATE_SAT_PER_BYTE,
      },
      null,
      2,
    ),
  )

  if (dryRun) {
    console.log('Dry-run only. Not broadcasting.')
    return
  }

  const txid = await broadcastSplitTransactionRaw(raw)
  console.log(`✅ Split broadcasted: ${txid}`)
}

main().catch((e) => {
  console.error('split-utxos error:', e)
  process.exit(1)
})
