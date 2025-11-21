import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import * as bsv from 'bsv'
import { bsvConfig } from './bsv-config'

const NET = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
const ARC_ENDPOINT = (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/$/, '')
const ARC_KEY = process.env.BSV_ARC_API_KEY || ''
const WOC_KEY = process.env.WHATSONCHAIN_API_KEY

const TARGET = Number(process.env.BSV_UTXO_TARGET_PER_WALLET || 200)
const LOW_WATER = Number(process.env.BSV_UTXO_LOW_WATERMARK || 150)
const SPLIT_BATCH = Number(process.env.BSV_UTXO_SPLIT_BATCH || 50)
const SPLIT_OUTPUT_SATS = Number(process.env.BSV_UTXO_SPLIT_OUTPUT_SATS || 2000)
const MIN_CONF = Number(process.env.BSV_UTXO_MIN_CONFIRMATIONS || 1)
const INTERVAL_MS = Number(process.env.BSV_UTXO_MAINTAINER_INTERVAL_MS || 60000)
const FEE_RATE = Number((process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE) || 0.001)
const SPLIT_FEE_RATE = Number(process.env.BSV_UTXO_SPLIT_FEE_RATE_SAT_PER_BYTE || FEE_RATE)
const DUST_LIMIT = 546
const SPLIT_COOLDOWN_MS = Number(process.env.BSV_UTXO_SPLIT_COOLDOWN_MS || 10 * 60 * 1000)

// Validate SPLIT_OUTPUT_SATS is above dust limit
if (SPLIT_OUTPUT_SATS < DUST_LIMIT) {
  console.error(`⚠️  WARNING: BSV_UTXO_SPLIT_OUTPUT_SATS (${SPLIT_OUTPUT_SATS}) is below dust limit (${DUST_LIMIT} sats). This will cause transaction failures.`)
  console.error(`   Recommended minimum: ${DUST_LIMIT + 100} sats (dust limit + buffer for fees)`)
}

// Track per-wallet pending split to avoid multiple unconfirmed splits
const pendingSplitUntilByAddress: Map<string, number> = new Map()

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`)
  return res.json()
}

async function getUnspent(address: string): Promise<any[]> {
  const { getUnspentForAddress } = await import('./utxo-provider')
  return getUnspentForAddress(address)
}

async function broadcastViaArc(rawHex: string): Promise<string> {
  if (!ARC_KEY) throw new Error('BSV_ARC_API_KEY not configured')
  const res = await fetch(`${ARC_ENDPOINT}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARC_KEY}` },
    body: JSON.stringify({ rawTx: rawHex })
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new Error(`ARC ${res.status} ${text}`)
  try { const p = JSON.parse(text || '{}'); if (p?.txid && /^[0-9a-fA-F]{64}$/.test(p.txid)) return p.txid } catch {}
  const txid = (text || '').replace(/"/g, '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(txid)) return txid
  throw new Error(`ARC returned invalid txid: ${text}`)
}

async function broadcastViaGorillaPool(rawHex: string): Promise<string> {
  const endpoint = (process.env.BSV_GORILLAPOOL_MAPI_ENDPOINT || 'https://mapi.gorillapool.io').replace(/\/$/, '')
  const res = await fetch(`${endpoint}/mapi/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: rawHex })
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new Error(`GorillaPool ${res.status}`)
  // Try signed envelope
  try {
    const data = JSON.parse(text || '{}')
    if (data?.payload) {
      const payload = JSON.parse(data.payload)
      if (payload?.returnResult === 'success' && typeof payload.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(payload.txid)) {
        return payload.txid
      }
      if (payload?.returnResult === 'failure') {
        throw new Error(`GorillaPool rejected: ${payload?.resultDescription || 'Unknown'}`)
      }
    }
  } catch {}
  const txid = (text || '').replace(/"/g, '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(txid)) return txid
  throw new Error(`GorillaPool returned invalid response: ${text}`)
}

async function broadcastViaWoc(rawHex: string): Promise<string> {
  const wocNet = NET
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${wocNet}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: rawHex })
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new Error(`WOC ${res.status}`)
  const txid = (text || '').replace(/"/g, '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(txid)) return txid
  throw new Error(`WOC returned invalid txid: ${text}`)
}

async function broadcastWithFallbacks(rawHex: string): Promise<string> {
  const errors: string[] = []
  try { return await broadcastViaArc(rawHex) } catch (e) { errors.push(e instanceof Error ? e.message : String(e)) }
  try { return await broadcastViaGorillaPool(rawHex) } catch (e) { errors.push(e instanceof Error ? e.message : String(e)) }
  try { return await broadcastViaWoc(rawHex) } catch (e) { errors.push(e instanceof Error ? e.message : String(e)) }
  throw new Error(`All broadcast methods failed:\n${errors.join('\n')}`)
}

function p2pkhScriptHexFromWif(wif: string): string {
  const key = SDKPrivateKey.fromWif(wif)
  const pubKeyHash = Buffer.from(key.toPublicKey().toHash()).toString('hex')
  return '76a914' + pubKeyHash + '88ac'
}

async function topUpWallet(wif: string): Promise<{ txid: string, address: string } | null> {
  const sdk = SDKPrivateKey.fromWif(wif)
  const address = sdk.toPublicKey().toAddress().toString()
  const utxos = await getUnspent(address)
  const confirmed = utxos.filter((u: any) => {
    const conf = (u.confirmations || 0) >= MIN_CONF
    const byHeight = typeof u.height === 'number' ? u.height > 0 : true
    return conf || byHeight
  })
  const unconfirmed = utxos.filter((u: any) => {
    const byHeight = typeof u.height === 'number' ? u.height === 0 : false
    const conf = (u.confirmations || 0) === 0
    return byHeight || conf
  })
  const count = confirmed.length

  // If a split was recently broadcast for this address, wait for cooldown or confirmation
  const pendingUntil = pendingSplitUntilByAddress.get(address) || 0
  if (pendingUntil > Date.now()) {
    // Clear pending if we already crossed low-water (confirmation arrived)
    if (count >= LOW_WATER) pendingSplitUntilByAddress.delete(address)
    return null
  }

  if (count >= LOW_WATER) return null
  const need = Math.min(SPLIT_BATCH, Math.max(0, TARGET - count))
  if (need <= 0) return null

  // Choose largest confirmed UTXO
  // Reserve the largest confirmed UTXO for splitting by default
  let inputSource = confirmed.slice().sort((a: any, b: any) => (b.value||0)-(a.value||0))[0]
  // Bootstrap option: if no confirmed inputs exist, allow a one-time split from unconfirmed
  if (!inputSource && process.env.BSV_UTXO_BOOTSTRAP_FROM_UNCONFIRMED === 'true') {
    inputSource = unconfirmed.slice().sort((a: any, b: any) => (b.value||0)-(a.value||0))[0]
  }
  if (!inputSource) return null

  const totalOut = need * SPLIT_OUTPUT_SATS
  const estBytes = 300 + need * 40
  const fee = Math.ceil(estBytes * SPLIT_FEE_RATE)
  const required = totalOut + fee + DUST_LIMIT
  
  // Additional validation: ensure each split output is above dust limit
  if (SPLIT_OUTPUT_SATS < DUST_LIMIT) {
    console.error(`❌ Cannot split: BSV_UTXO_SPLIT_OUTPUT_SATS (${SPLIT_OUTPUT_SATS}) is below dust limit (${DUST_LIMIT} sats)`)
    return null
  }
  
  if (inputSource.value < required) return null

  const scriptHex = (bsv.Script as any).fromAddress
    ? (bsv.Script as any).fromAddress(address).toHex()
    : p2pkhScriptHexFromWif(wif)

  const input = { txId: inputSource.tx_hash, outputIndex: inputSource.tx_pos, address, script: scriptHex, satoshis: inputSource.value }
  const tx = new (bsv as any).Transaction().from([input])
  for (let i = 0; i < need; i++) tx.to(address, SPLIT_OUTPUT_SATS)
  tx.change(address).feePerKb(SPLIT_FEE_RATE * 1000)
  const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
  tx.sign(signingKey)
  const raw = tx.serialize()
  const txid = await broadcastWithFallbacks(raw)
  // Set cooldown lock to prevent multiple unconfirmed splits per wallet
  pendingSplitUntilByAddress.set(address, Date.now() + SPLIT_COOLDOWN_MS)
  return { txid, address }
}

export function startUtxoMaintainer(): void {
  const disabled = process.env.BSV_UTXO_MAINTAINER_DISABLED === 'true'
  if (disabled) return
  let running = false
  let lastSplitAt: number | null = null
  let lastErrorLoggedAt: number | null = null
  
  const cycle = async () => {
    if (running) return
    running = true
    try {
      const keys = (bsvConfig?.wallets?.privateKeys || []).filter(k => !!k)
      for (const wif of keys) {
        try {
          const split = await topUpWallet(wif)
          if (split) {
            lastSplitAt = Date.now()
            console.log(`🔧 UTXO split broadcasted for ${split.address}: ${split.txid}`)
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // Only log errors every 5 minutes to avoid spam
          const now = Date.now()
          if (!lastErrorLoggedAt || (now - lastErrorLoggedAt) > 300000) {
            console.error('UTXO maintainer error:', msg)
            lastErrorLoggedAt = now
          }
        }
      }
    } finally {
      running = false
    }
  }
  // Immediate first run to avoid waiting a full interval at boot
  cycle().catch(() => {})
  setInterval(() => { cycle().catch(() => {}) }, INTERVAL_MS)
  console.log(`🔧 UTXO Maintainer started (interval ${INTERVAL_MS}ms)`)
}


