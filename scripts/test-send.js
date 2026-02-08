const dotenv = require('dotenv')
dotenv.config({ path: '.env.local' })
dotenv.config()
const fetch = global.fetch || require('node-fetch')
const bsv = require('bsv')
if (!bsv || !bsv.PrivateKey || !bsv.Script || !bsv.Transaction) {
  console.error(JSON.stringify({ success: false, error: 'bsv module missing expected exports', keys: Object.keys(bsv || {}) }))
  process.exit(1)
}

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`)
  return res.json()
}

async function broadcastArc(arcUrl, apiKey, txhex) {
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
  const isMain = (process.env.BSV_NETWORK || 'mainnet') === 'mainnet'
  const net = isMain ? 'main' : 'test'
  const wif = process.env.BSV_PRIVATE_KEY || process.env.BSV_WALLET_1_PRIVATE_KEY
  if (!wif) throw new Error('WIF not found in env')

  const priv = bsv.PrivateKey.fromWIF(wif)
  const address = priv.toAddress().toString()

  const utxos = await getJson(`https://api.whatsonchain.com/v1/bsv/${net}/address/${address}/unspent`)
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error('No UTXOs available')
  const u = utxos.sort((a, b) => (b.value || 0) - (a.value || 0))[0]

  const scriptPubKey = bsv.Script.fromAddress(address).toHex()

  const tx = new bsv.Transaction()
    .from([
      {
        txId: u.tx_hash,
        outputIndex: u.tx_pos,
        script: scriptPubKey,
        satoshis: u.value,
      }
    ])
    .to(address, 1000)
    .change(address)
    .feePerKb(Number(process.env.BSV_TX_FEE_RATE || 1000))
    .sign(priv)

  const txhex = tx.serialize()

  const arcEndpoint = process.env.BSV_API_ENDPOINT || 'https://arc.taal.com'
  const apiKey = process.env.BSV_ARC_API_KEY
  if (!apiKey) throw new Error('BSV_ARC_API_KEY missing')

  const txid = await broadcastArc(arcEndpoint, apiKey, txhex)
  console.log(JSON.stringify({ success: true, txid, address }))
}

main().catch(e => {
  console.error(JSON.stringify({ success: false, error: e.message || String(e) }))
  process.exit(1)
})


