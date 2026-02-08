import { config } from 'dotenv'
// Load .env.local first (Next-style), then fallback to .env
config({ path: '.env.local' })
config()
import { PrivateKey, P2PKH, Transaction, ARC, UnlockingScript } from '@bsv/sdk'

async function getWocUtxos(address: string, network: 'main' | 'test') {
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/address/${address}/unspent`)
  if (!res.ok) throw new Error(`WOC utxo fetch failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as Array<{ tx_hash: string; tx_pos: number; value: number }>
}

async function getWocRawTxHex(txid: string, network: 'main' | 'test'): Promise<string> {
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}/hex`)
  if (!res.ok) throw new Error(`WOC raw fetch failed: ${res.status} ${await res.text()}`)
  const hex = await res.text()
  return hex.replace(/"/g, '').trim()
}

async function main() {
  const arcKey = process.env.BSV_ARC_API_KEY || ''
  const forceTest = arcKey.startsWith('testnet_')
  const net = forceTest ? 'test' : (process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test')
  const arcEndpoint = process.env.BSV_NETWORK === 'mainnet'
    ? (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com')
    : (process.env.BSV_TESTNET_API_ENDPOINT || 'https://arc-test.taal.com')
  const wif = process.env.BSV_PRIVATE_KEY || process.env.BSV_WALLET_1_PRIVATE_KEY || ''
  if (!wif) throw new Error('No WIF found in env')

  const key = PrivateKey.fromWif(wif)
  const pub = key.toPublicKey()
  const fromAddress = pub.toAddress().toString()

  const utxos = await getWocUtxos(fromAddress, net)
  if (!utxos.length) throw new Error('No UTXOs')

  // pick largest utxo
  const u = utxos.sort((a, b) => b.value - a.value)[0]

  // Build simple tx: 1 input, 1 output (to self) with 1000 sats, change back
  const selfLock = new P2PKH().lock(pub.toHash())

  // Fetch and include the source transaction so signing is deterministic per SDK guide
  const prevHex = await getWocRawTxHex(u.tx_hash, net)
  const prevTx = Transaction.fromHex(prevHex)
  const prevRawOut: any = (prevTx as any).outputs?.[u.tx_pos]
  const sourceOutput = {
    satoshis: Number(prevRawOut?.satoshis),
    lockingScript: typeof prevRawOut?.lockingScript?.toHex === 'function'
      ? prevRawOut.lockingScript.toHex()
      : prevRawOut?.lockingScript,
  }
  if (!sourceOutput.satoshis || !sourceOutput.lockingScript) {
    throw new Error('Could not resolve previous output details for signing')
  }

  const version = 1
  const inputs: any[] = [
    {
      outpoint: { txid: u.tx_hash, vout: u.tx_pos },
      sequence: 0xffffffff,
      unlockingScript: new UnlockingScript(),
    },
  ]
  const fee = 300
  const change = u.value - 1000 - fee
  if (change <= 546) throw new Error(`Selected UTXO too small after fee: change=${change}`)
  const outputs: any[] = [
    { lockingScript: selfLock, satoshis: 1000 },
    { lockingScript: selfLock, satoshis: change },
  ]

  const tx = new Transaction(version, inputs as any, outputs as any)

  // Sign input 0 with explicit P2PKH and source output context
  await tx.sign(0, key, new P2PKH(), { sourceOutputs: [(prevTx as any).outputs?.[u.tx_pos]] })

  const arc = new ARC(arcEndpoint, arcKey)
  const result = await tx.broadcast(arc)
  if (!(result as any).success) {
    console.error('Broadcast failed:', result)
    process.exit(1)
  }
  const txid = (result as any).txid
  console.log(JSON.stringify({ success: true, txid, address: fromAddress }))
}

main().catch((e) => {
  console.error(JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e) }))
  process.exit(1)
})


