// Safe UTXO splitter (dry-run by default)
// Usage examples:
//   pnpm split:utxos -- --wallet 0 --outputs 200 --amount 2000 --dry-run
//   pnpm split:utxos -- --wallet 0 --outputs 200 --amount 2000

// Loads .env.local early
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
{
  const envLocal = path.resolve(process.cwd(), '.env.local')
  if (fs.existsSync(envLocal)) {
    dotenv.config({ path: envLocal, override: false })
  } else {
    dotenv.config({ override: false })
  }
}

import * as bsv from 'bsv'
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'

const ARC_ENDPOINT = (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/$/, '')
const ARC_KEY = process.env.BSV_ARC_API_KEY || ''
const NETWORK = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY
const FEE_RATE_SAT_PER_BYTE = Number((process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE) || 0.001)
const DUST_LIMIT = 546

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

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env: ${name}`)
  return val
}

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`)
  }
  return res.json()
}

async function getUnspent(address: string): Promise<any[]> {
  const h: Record<string, string> = {}
  if (WHATSONCHAIN_API_KEY) h['woc-api-key'] = WHATSONCHAIN_API_KEY
  const url = `https://api.whatsonchain.com/v1/bsv/${NETWORK}/address/${address}/unspent`
  return await fetchJson(url, h)
}

async function broadcastViaArc(rawHex: string): Promise<string> {
  if (!ARC_KEY) throw new Error('BSV_ARC_API_KEY not configured')
  const res = await fetch(`${ARC_ENDPOINT}/v1/tx`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ARC_KEY}`,
    },
    body: JSON.stringify({ rawTx: rawHex })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ARC ${res.status} ${text}`)
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.txid === 'string') return parsed.txid
  } catch {}
  return text.replace(/"/g, '').trim()
}

async function main() {
  const { wallet, outputs, amount, dryRun } = parseArgs(process.argv.slice(2))

  if (outputs <= 0 || outputs > 1000) throw new Error('outputs must be 1..1000')
  if (amount < DUST_LIMIT + 50) throw new Error(`amount must be >= ${DUST_LIMIT + 50} sats`)

  // Resolve WIFs from envs
  const wifs: string[] = []
  const primary = process.env.BSV_PRIVATE_KEY
  if (primary) wifs.push(primary)
  ;['BSV_WALLET_1_PRIVATE_KEY','BSV_WALLET_2_PRIVATE_KEY','BSV_WALLET_3_PRIVATE_KEY'].forEach(k => {
    const v = process.env[k]
    if (v && !wifs.includes(v)) wifs.push(v)
  })
  if (wifs.length === 0) throw new Error('No wallet WIFs configured')
  if (wallet < 0 || wallet >= wifs.length) throw new Error(`wallet index ${wallet} out of range (0..${wifs.length-1})`)

  const wif = wifs[wallet]
  const sdkKey = SDKPrivateKey.fromWif(wif)
  const address = sdkKey.toPublicKey().toAddress().toString()

  const detected = address.startsWith('1') ? 'mainnet' : 'testnet'
  const configured = process.env.BSV_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  if (detected !== configured) {
    console.warn(`⚠️ WIF network (${detected}) differs from BSV_NETWORK (${configured}). Proceeding with configured network.`)
  }

  console.log(`Splitting wallet ${wallet} (${address}) → ${outputs} outputs x ${amount} sats [dryRun=${dryRun}]`)

  const utxos = await getUnspent(address)
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error('No confirmed UTXOs found')
  // choose largest
  const largest = utxos.slice().sort((a: any, b: any) => (b.value||0)-(a.value||0))[0]

  const targetTotal = outputs * amount
  // Estimate rough fee ~ 300 bytes + per-output ~ 34 bytes, generous multiplier
  const estimatedBytes = 300 + outputs * 40
  const estimatedFee = Math.ceil(estimatedBytes * FEE_RATE_SAT_PER_BYTE)
  const required = targetTotal + estimatedFee + DUST_LIMIT
  if (largest.value < required) {
    throw new Error(`Largest UTXO ${largest.value} sats insufficient for ${required} sats (outputs+fee+change)`) 
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
  tx.change(address).feePerKb(FEE_RATE_SAT_PER_BYTE * 1000)
  const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
  tx.sign(signingKey)

  const raw = tx.serialize()
  const fee = tx.getFee()
  const change = largest.value - targetTotal - fee
  console.log(JSON.stringify({
    address,
    selectedUtxo: { txid: largest.tx_hash, vout: largest.tx_pos, value: largest.value },
    outputs,
    amountPerOutput: amount,
    fee,
    change,
    sizeBytes: raw.length/2,
  }, null, 2))

  if (dryRun) {
    console.log('Dry-run only. Not broadcasting.')
    return
  }

  const txid = await broadcastViaArc(raw)
  console.log(`✅ Split broadcasted: ${txid}`)
}

main().catch((e) => {
  console.error('split-utxos error:', e)
  process.exit(1)
})


