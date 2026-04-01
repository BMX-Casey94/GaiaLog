/**
 * UTXO Auto-Replenisher — long-running process that monitors the emergency
 * UTXO pool and automatically splits large UTXOs when spendable counts
 * drop below a threshold.
 *
 * Managed by PM2 via ecosystem.config.cjs.
 */

import * as bsv from 'bsv'
;(bsv.Transaction as any).DUST_AMOUNT = 1

import { broadcastSplitTransactionRaw } from '../lib/broadcast-raw-tx'

const SPLIT_OUTPUT_SATS = Number(process.env.BSV_UTXO_SPLIT_OUTPUT_SATS || 130)
const FEE_RATE = Number(process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE || 0.105)
const MAX_OUTPUTS_PER_TX = 2500
const LARGE_UTXO_THRESHOLD = 100_000
const MANAGER_URL = process.env.GAIALOG_EMERGENCY_UTXO_MANAGER_URL || 'http://127.0.0.1:8787'
const MANAGER_SECRET = process.env.GAIALOG_EMERGENCY_UTXO_MANAGER_SECRET || ''

const MIN_SPENDABLE_THRESHOLD = Number(process.env.BSV_UTXO_REPLENISH_THRESHOLD || 500)
const CHECK_INTERVAL_MS = Number(process.env.BSV_UTXO_REPLENISH_INTERVAL_MS || 60_000)

const WALLETS = [
  { wif: process.env.BSV_WALLET_1_PRIVATE_KEY!, address: process.env.BSV_WALLET_1_ADDRESS! },
  { wif: process.env.BSV_WALLET_2_PRIVATE_KEY!, address: process.env.BSV_WALLET_2_ADDRESS! },
  { wif: process.env.BSV_WALLET_3_PRIVATE_KEY!, address: process.env.BSV_WALLET_3_ADDRESS! },
].filter(w => w.wif && w.address)

let running = true

process.on('SIGINT', () => { running = false })
process.on('SIGTERM', () => { running = false })

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

  utxos.sort((a: any, b: any) => b.value - a.value)
  const utxo = utxos[0]
  const inputSats = utxo.value

  const outputCount = Math.min(MAX_OUTPUTS_PER_TX, Math.floor(inputSats / (SPLIT_OUTPUT_SATS + 10)))
  if (outputCount < 2) {
    console.log(`  [${address.substring(0, 10)}] Largest UTXO (${inputSats} sats) too small to split`)
    return false
  }

  console.log(`  [${address.substring(0, 10)}] Splitting ${utxo.tx_hash.substring(0, 12)}...:${utxo.tx_pos} (${inputSats} sats) into ${outputCount} x ${SPLIT_OUTPUT_SATS} sats`)

  const scriptHex = (bsv.Script as any).fromAddress
    ? (bsv.Script as any).fromAddress(address).toHex()
    : ''

  const input = {
    txId: utxo.tx_hash,
    outputIndex: utxo.tx_pos,
    address,
    script: scriptHex,
    satoshis: inputSats,
  }

  const tx = new (bsv as any).Transaction().from([input])
  for (let i = 0; i < outputCount; i++) {
    tx.to(address, SPLIT_OUTPUT_SATS)
  }
  tx.feePerKb(Math.ceil(FEE_RATE * 1000)).change(address)

  const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
  tx.sign(signingKey)
  const raw: string = tx.serialize()
  const txSizeBytes = raw.length / 2
  const totalOutputSats = tx.outputs.reduce((s: number, o: any) => s + (o.satoshis || o._satoshis || 0), 0)
  const actualFee = inputSats - totalOutputSats

  console.log(`  [${address.substring(0, 10)}] TX: ${txSizeBytes} bytes, ${tx.outputs.length} outputs, fee=${actualFee} sats (${(actualFee / txSizeBytes).toFixed(3)} sat/byte)`)

  const txid = await broadcastSplitTransactionRaw(raw)
  console.log(`  [${address.substring(0, 10)}] Broadcast OK: ${txid}`)

  const newUtxos: any[] = []
  for (let i = 0; i < tx.outputs.length; i++) {
    const satoshis = Number(tx.outputs[i].satoshis || tx.outputs[i]._satoshis || 0)
    newUtxos.push({ txid, vout: i, satoshis, confirmed: false })
  }

  const seedResult = await managerPost('/admin/seed', {
    address,
    replace: false,
    utxos: newUtxos,
  })
  console.log(`  [${address.substring(0, 10)}] Seeded ${seedResult.utxos || 0} UTXOs into manager`)

  await managerPost('/consume-admit', {
    address,
    spentTxid: utxo.tx_hash,
    spentVout: utxo.tx_pos,
    spendingTxid: txid,
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
        console.log(`⚡ [${address.substring(0, 10)}] Spendable=${spendable} < threshold=${MIN_SPENDABLE_THRESHOLD} — splitting`)
        await splitForWallet(wif, address)
      }
    } catch (err: any) {
      console.error(`❌ [${address.substring(0, 10)}] Error: ${err.message}`)
    }
  }
}

async function main(): Promise<void> {
  console.log(`🔄 UTXO Auto-Replenisher started`)
  console.log(`   Split size: ${SPLIT_OUTPUT_SATS} sats | Max outputs/tx: ${MAX_OUTPUTS_PER_TX}`)
  console.log(`   Threshold: ${MIN_SPENDABLE_THRESHOLD} spendable | Check interval: ${CHECK_INTERVAL_MS / 1000}s`)
  console.log(`   Wallets: ${WALLETS.length}`)
  console.log()

  while (running) {
    try {
      const health = await managerGet('/health')
      console.log(`📊 Pool: ${health.utxos} total UTXOs across ${health.wallets} wallets`)
      await checkAndReplenish()
    } catch (err: any) {
      console.error(`❌ Health check failed: ${err.message}`)
    }

    for (let waited = 0; waited < CHECK_INTERVAL_MS && running; waited += 1000) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  console.log('🛑 UTXO Auto-Replenisher shutting down')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
