import { config } from 'dotenv'
config({ path: '.env.local' })
config()

// Use CommonJS-style require to avoid type/esm issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bsv = require('bsv')

async function fetchJson(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`)
  return res.json()
}

async function broadcastWoc(network: 'main' | 'test', txhex: string): Promise<string> {
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex })
  })
  if (!res.ok) throw new Error(`WOC broadcast failed: ${res.status} ${await res.text()}`)
  const text = await res.text()
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'string') return parsed
    if (parsed && typeof parsed.txid === 'string') return parsed.txid
  } catch {}
  return text.replace(/"/g, '').trim()
}

async function broadcastArc(arcUrl: string, apiKey: string, txhex: string): Promise<string> {
  const url = `${arcUrl.replace(/\/$/, '')}/v1/tx`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ rawTx: txhex })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ARC broadcast failed: ${res.status} ${text}`)
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.txid === 'string') return parsed.txid
  } catch {}
  return text.replace(/"/g, '').trim()
}

async function main() {
  const isMain = (process.env.BSV_NETWORK || 'testnet') === 'mainnet'
  const net: 'main' | 'test' = isMain ? 'main' : 'test'
  const wif = process.env.BSV_PRIVATE_KEY || process.env.BSV_WALLET_1_PRIVATE_KEY
  if (!wif) throw new Error('WIF not found in env')

  const priv = bsv.PrivateKey.fromWIF(wif)
  const address = priv.toAddress().toString()

  // Get UTXOs
  const utxos = await fetchJson(`https://api.whatsonchain.com/v1/bsv/${net}/address/${address}/unspent`)
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error('No UTXOs available')

  const u = utxos.sort((a: any, b: any) => (b.value || 0) - (a.value || 0))[0]

  const scriptPubKey = bsv.Script.fromAddress(address).toHex()

  const tx = new bsv.Transaction()
    .from([
      {
        txId: u.tx_hash,
        outputIndex: u.tx_pos,
        script: scriptPubKey,
        satoshis: u.value,
      },
    ])
    .to(address, 1000)
    .change(address)
    .feePerKb(1000)
    .sign(priv)

  const txhex = tx.serialize()
  const arcEndpoint = process.env.BSV_API_ENDPOINT || 'https://arc.taal.com'
  const arcKey = process.env.BSV_ARC_API_KEY
  if (!arcKey) throw new Error('BSV_ARC_API_KEY missing')
  const txid = await broadcastArc(arcEndpoint, arcKey, txhex)
  console.log(JSON.stringify({ success: true, txid, address }))
}

main().catch((e) => {
  console.error(JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e) }))
  process.exit(1)
})


