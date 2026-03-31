/**
 * Emergency UTXO splitter — takes large UTXOs from the emergency manager,
 * splits them into many 2000-sat outputs on-chain, and seeds the results back.
 *
 * Usage (on VPS):
 *   node --import tsx scripts/split-utxos-emergency.ts
 */

import * as bsv from 'bsv'
;(bsv.Transaction as any).DUST_AMOUNT = 1

import { broadcastSplitTransactionRaw } from '../lib/broadcast-raw-tx'

const SPLIT_OUTPUT_SATS = Number(process.env.BSV_UTXO_SPLIT_OUTPUT_SATS || 500)
const FEE_RATE = Number(process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE || 0.105)
const MAX_OUTPUTS_PER_TX = 2500
const MANAGER_URL = process.env.GAIALOG_EMERGENCY_UTXO_MANAGER_URL || 'http://127.0.0.1:8787'
const MANAGER_SECRET = process.env.GAIALOG_EMERGENCY_UTXO_MANAGER_SECRET || ''

const WALLETS = [
  { wif: process.env.BSV_WALLET_1_PRIVATE_KEY!, address: process.env.BSV_WALLET_1_ADDRESS! },
  { wif: process.env.BSV_WALLET_2_PRIVATE_KEY!, address: process.env.BSV_WALLET_2_ADDRESS! },
  { wif: process.env.BSV_WALLET_3_PRIVATE_KEY!, address: process.env.BSV_WALLET_3_ADDRESS! },
].filter(w => w.wif && w.address)

async function managerGet(path: string): Promise<any> {
  const resp = await fetch(`${MANAGER_URL}${path}`)
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
  })
  return resp.json()
}

async function splitForWallet(wif: string, address: string): Promise<void> {
  const utxos = await managerGet(`/utxos/${address}?minSatoshis=100000`)
  if (!Array.isArray(utxos) || utxos.length === 0) {
    console.log(`  ${address.substring(0, 10)}...: no large UTXOs (>= 100k sats) to split`)
    return
  }

  utxos.sort((a: any, b: any) => b.value - a.value)
  const utxo = utxos[0]
  const inputSats = utxo.value
  console.log(`  ${address.substring(0, 10)}...: splitting ${utxo.tx_hash}:${utxo.tx_pos} (${inputSats} sats)`)

  const outputCount = Math.min(MAX_OUTPUTS_PER_TX, Math.floor(inputSats / (SPLIT_OUTPUT_SATS + 10)))
  if (outputCount < 2) {
    console.log(`  UTXO too small to split meaningfully`)
    return
  }

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

  console.log(`  TX: ${txSizeBytes} bytes, ${tx.outputs.length} outputs, fee=${actualFee} sats (${(actualFee / txSizeBytes).toFixed(3)} sat/byte)`)

  const txid = await broadcastSplitTransactionRaw(raw)
  console.log(`  Broadcast OK: ${txid}`)

  const newUtxos: any[] = []
  for (let i = 0; i < tx.outputs.length; i++) {
    const satoshis = Number(tx.outputs[i].satoshis || tx.outputs[i]._satoshis || 0)
    newUtxos.push({
      txid,
      vout: i,
      satoshis,
      confirmed: false,
    })
  }

  const seedResult = await managerPost('/admin/seed', {
    address,
    replace: false,
    utxos: newUtxos,
  })
  console.log(`  Seeded ${seedResult.utxos || 0} new UTXOs into manager`)

  await managerPost('/consume-admit', {
    address,
    spentTxid: utxo.tx_hash,
    spentVout: utxo.tx_pos,
    spendingTxid: txid,
  })
  console.log(`  Consumed spent input`)
}

async function main() {
  console.log(`Emergency UTXO splitter — ${WALLETS.length} wallets, ${SPLIT_OUTPUT_SATS} sats/output, fee rate ${FEE_RATE} sat/byte`)
  console.log()

  const health = await managerGet('/health')
  console.log(`Manager health: ${JSON.stringify(health)}`)
  console.log()

  for (const { wif, address } of WALLETS) {
    try {
      await splitForWallet(wif, address)
    } catch (err: any) {
      console.error(`  ERROR for ${address.substring(0, 10)}...: ${err.message}`)
    }
    console.log()
  }

  const finalHealth = await managerGet('/health')
  console.log(`Final health: ${JSON.stringify(finalHealth)}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
