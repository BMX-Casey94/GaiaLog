import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import * as bsv from 'bsv'
// BSV has no protocol-enforced dust limit — override the BTC-inherited default
;(bsv.Transaction as any).DUST_AMOUNT = 1
import { bsvConfig } from './bsv-config'

const NET = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY || ''
// Broadcasting endpoints: GorillaPool ARC (primary) → TAAL ARC (fallback) → WoC (final)
const GORILLAPOOL_ARC_ENDPOINT = (process.env.BSV_GORILLAPOOL_ARC_ENDPOINT || 'https://arc.gorillapool.io').replace(/\/$/, '')
const TAAL_ARC_ENDPOINT = (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/$/, '')
const ARC_KEY = process.env.BSV_ARC_API_KEY || ''

// ─── Auto-sizing from expected throughput ───────────────────────────────────
// 150,000 TX/day across 3 wallets ≈ 50,000 TX/wallet/day.
// With 2-confirmation policy (~20 min), each wallet needs inventory for ~700 TXs + headroom.
// Users can override via env vars; otherwise we auto-calculate from BSV_EXPECTED_TX_PER_DAY.
const EXPECTED_TX_PER_DAY = Number(process.env.BSV_EXPECTED_TX_PER_DAY || 150000)
const WALLET_COUNT = Math.max(1, (bsvConfig?.wallets?.privateKeys || []).filter(k => !!k).length)
const CONFIRMATION_WINDOW_SECS = Number(process.env.BSV_CONFIRMATION_WINDOW_SECS || 1200) // ~20 min (2 blocks)
const AUTO_TARGET = Math.ceil((EXPECTED_TX_PER_DAY / WALLET_COUNT / 86400) * CONFIRMATION_WINDOW_SECS * 1.5) // 1.5x headroom

const TARGET = Number(process.env.BSV_UTXO_TARGET_PER_WALLET || Math.max(200, AUTO_TARGET))
const LOW_WATER = Number(process.env.BSV_UTXO_LOW_WATERMARK || Math.max(150, Math.floor(TARGET * 0.75)))
const SPLIT_BATCH = Number(process.env.BSV_UTXO_SPLIT_BATCH || Math.min(600, Math.max(50, Math.ceil(TARGET * 0.4))))
const SPLIT_OUTPUT_SATS = Number(process.env.BSV_UTXO_SPLIT_OUTPUT_SATS || 2000)
const MIN_CONF = Number(process.env.BSV_UTXO_MIN_CONFIRMATIONS || 1)
const INTERVAL_MS = Number(process.env.BSV_UTXO_MAINTAINER_INTERVAL_MS || 30000) // 30s for high-throughput
// GorillaPool/TAAL ARC minimum: 100 sat/kB. Default 0.15 sat/byte (150 sat/kB) for safety margin.
const FEE_RATE = Number((process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE) || 0.15)
const SPLIT_FEE_RATE = Number(process.env.BSV_UTXO_SPLIT_FEE_RATE_SAT_PER_BYTE || FEE_RATE)
// BSV has no protocol-enforced dust limit (unlike BTC). 1 sat is the minimum viable output.
const DUST_LIMIT = 1
const SPLIT_COOLDOWN_MS = Number(process.env.BSV_UTXO_SPLIT_COOLDOWN_MS || 5 * 60 * 1000) // 5 min default

// Validate SPLIT_OUTPUT_SATS is above dust limit
if (SPLIT_OUTPUT_SATS < DUST_LIMIT) {
  console.error(`⚠️  WARNING: BSV_UTXO_SPLIT_OUTPUT_SATS (${SPLIT_OUTPUT_SATS}) is below the minimum (${DUST_LIMIT} sat). This will cause transaction failures.`)
  console.error(`   Recommended minimum: 100 sats (minimum + buffer for fees)`)
}

// ─── Per-wallet state (globalThis-safe for dev mode) ────────────────────────
const _g = globalThis as any
if (!_g.__GAIALOG_UTXO_MAINT_STATE__) {
  _g.__GAIALOG_UTXO_MAINT_STATE__ = {
    pendingSplitUntilByAddress: new Map<string, number>(),
    mempoolBackoffUntil: new Map<string, number>(), // wallet → timestamp until which to skip
  }
}
const maintState: {
  pendingSplitUntilByAddress: Map<string, number>
  mempoolBackoffUntil: Map<string, number>
} = _g.__GAIALOG_UTXO_MAINT_STATE__

// ─── ARC response validation (mirrors blockchain.ts logic) ──────────────────
const ARC_OK_STATUSES = new Set([
  'SEEN_ON_NETWORK', 'MINED', 'ACCEPTED', 'STORED',
  'ANNOUNCED_TO_NETWORK', 'SEEN_IN_ORPHAN_MEMPOOL',
])
const ARC_REJECT_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED', 'REJECTED', 'INVALID', 'EVICTED',
])

function parseArcResponse(responseText: string, providerLabel: string): string | null {
  try {
    const parsed = JSON.parse(responseText || '{}')
    const txid = typeof parsed.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(parsed.txid)
      ? parsed.txid : null
    const status = typeof parsed.txStatus === 'string' ? parsed.txStatus : ''

    if (txid && ARC_REJECT_STATUSES.has(status)) {
      const extra = parsed.extraInfo ? ` (${String(parsed.extraInfo).substring(0, 80)})` : ''
      console.warn(`⚠️  UTXO-Split ARC (${providerLabel}): TX rejected — txStatus=${status}${extra}`)
      return null
    }
    if (txid && (ARC_OK_STATUSES.has(status) || !status)) return txid
    if (txid) {
      console.warn(`⚠️  UTXO-Split ARC (${providerLabel}): Unknown txStatus="${status}" — accepting cautiously`)
      return txid
    }
  } catch {}
  const plain = (responseText || '').replace(/"/g, '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(plain)) return plain
  return null
}

// ─── UTXO fetch ─────────────────────────────────────────────────────────────
async function getUnspent(address: string): Promise<any[]> {
  const { getUnspentForAddress } = await import('./utxo-provider')
  return getUnspentForAddress(address)
}

// ─── Broadcast with proper ARC + WoC fallback ──────────────────────────────
async function broadcastWithFallbacks(rawHex: string): Promise<string> {
  const errors: string[] = []

  // 1. GorillaPool ARC
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const gpApiKey = process.env.BSV_GORILLAPOOL_API_KEY
    if (gpApiKey) headers['Authorization'] = `Bearer ${gpApiKey}`
    const res = await fetch(`${GORILLAPOOL_ARC_ENDPOINT}/v1/tx`, {
      method: 'POST', headers,
      body: JSON.stringify({ rawTx: rawHex })
    })
    const text = await res.text().catch(() => '')
    if (res.ok) {
      const txid = parseArcResponse(text, 'GorillaPool')
      if (txid) return txid
      errors.push(`GorillaPool ARC: rejected — ${text.substring(0, 200)}`)
    } else {
      errors.push(`GorillaPool ARC ${res.status}: ${text.substring(0, 200)}`)
    }
  } catch (e) { errors.push(`GorillaPool ARC error: ${e instanceof Error ? e.message : String(e)}`) }

  // 2. TAAL ARC
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ARC_KEY) headers['Authorization'] = `Bearer ${ARC_KEY}`
    const res = await fetch(`${TAAL_ARC_ENDPOINT}/v1/tx`, {
      method: 'POST', headers,
      body: JSON.stringify({ rawTx: rawHex })
    })
    const text = await res.text().catch(() => '')
    if (res.ok) {
      const txid = parseArcResponse(text, 'TAAL')
      if (txid) return txid
      errors.push(`TAAL ARC: rejected — ${text.substring(0, 200)}`)
    } else {
      errors.push(`TAAL ARC ${res.status}: ${text.substring(0, 200)}`)
    }
  } catch (e) { errors.push(`TAAL ARC error: ${e instanceof Error ? e.message : String(e)}`) }

  // 3. WhatsOnChain broadcast (bypasses ARC entirely)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (WHATSONCHAIN_API_KEY) headers['woc-api-key'] = WHATSONCHAIN_API_KEY
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${NET}/tx/raw`, {
      method: 'POST', headers,
      body: JSON.stringify({ txhex: rawHex })
    })
    const text = await res.text().catch(() => '')
    if (res.ok) {
      const txid = text.replace(/"/g, '').trim()
      if (/^[0-9a-fA-F]{64}$/.test(txid)) return txid
      errors.push(`WoC returned unexpected body: ${text.substring(0, 200)}`)
    } else {
      errors.push(`WoC broadcast ${res.status}: ${text.substring(0, 200)}`)
    }
  } catch (e) { errors.push(`WoC broadcast error: ${e instanceof Error ? e.message : String(e)}`) }

  // Detect mempool-chain-limit (transient, will self-heal after next block)
  const allErrors = errors.join('\n')
  if (allErrors.includes('too-long-mempool-chain')) {
    throw new Error('MEMPOOL_CHAIN_LIMIT')
  }
  throw new Error(`All split broadcast methods failed:\n${allErrors}`)
}

function p2pkhScriptHexFromWif(wif: string): string {
  const key = SDKPrivateKey.fromWif(wif)
  const pubKeyHash = Buffer.from(key.toPublicKey().toHash()).toString('hex')
  return '76a914' + pubKeyHash + '88ac'
}

// ─── Core split logic ───────────────────────────────────────────────────────
async function topUpWallet(wif: string): Promise<{ txid: string; address: string; outputs: number } | null> {
  const sdk = SDKPrivateKey.fromWif(wif)
  const address = sdk.toPublicKey().toAddress().toString()

  // Respect mempool backoff
  const backoffUntil = maintState.mempoolBackoffUntil.get(address) || 0
  if (backoffUntil > Date.now()) return null

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
  const pendingUntil = maintState.pendingSplitUntilByAddress.get(address) || 0
  if (pendingUntil > Date.now()) {
    // Clear pending early if confirmation arrived and we're above low-water
    if (count >= LOW_WATER) maintState.pendingSplitUntilByAddress.delete(address)
    return null
  }

  if (count >= LOW_WATER) return null
  const need = Math.min(SPLIT_BATCH, Math.max(0, TARGET - count))
  if (need <= 0) return null

  // Choose largest confirmed UTXO for splitting
  let inputSource = confirmed.slice().sort((a: any, b: any) => (b.value || 0) - (a.value || 0))[0]
  // Bootstrap option: if no confirmed inputs exist, allow a one-time split from unconfirmed
  if (!inputSource && process.env.BSV_UTXO_BOOTSTRAP_FROM_UNCONFIRMED === 'true') {
    inputSource = unconfirmed.slice().sort((a: any, b: any) => (b.value || 0) - (a.value || 0))[0]
  }
  if (!inputSource) return null

  const totalOut = need * SPLIT_OUTPUT_SATS
  const estBytes = 300 + need * 40
  const fee = Math.ceil(estBytes * SPLIT_FEE_RATE)
  const required = totalOut + fee + DUST_LIMIT

  if (SPLIT_OUTPUT_SATS < DUST_LIMIT) {
    console.error(`❌ Cannot split: BSV_UTXO_SPLIT_OUTPUT_SATS (${SPLIT_OUTPUT_SATS}) is below dust limit (${DUST_LIMIT} sats)`)
    return null
  }
  if (inputSource.value < required) {
    // If the UTXO isn't large enough, try fewer outputs
    const maxOutputs = Math.floor((inputSource.value - 300 * SPLIT_FEE_RATE - DUST_LIMIT) / (SPLIT_OUTPUT_SATS + 40 * SPLIT_FEE_RATE))
    if (maxOutputs < 2) return null // not worth splitting
    const adjustedNeed = Math.min(need, maxOutputs)
    return doSplit(wif, address, inputSource, adjustedNeed)
  }

  return doSplit(wif, address, inputSource, need)
}

async function doSplit(
  wif: string, address: string, inputSource: any, outputCount: number
): Promise<{ txid: string; address: string; outputs: number } | null> {
  const scriptHex = (bsv.Script as any).fromAddress
    ? (bsv.Script as any).fromAddress(address).toHex()
    : p2pkhScriptHexFromWif(wif)

  const input = {
    txId: inputSource.tx_hash,
    outputIndex: inputSource.tx_pos,
    address,
    script: scriptHex,
    satoshis: inputSource.value,
  }
  const tx = new (bsv as any).Transaction().from([input])
  for (let i = 0; i < outputCount; i++) tx.to(address, SPLIT_OUTPUT_SATS)
  tx.change(address).feePerKb(SPLIT_FEE_RATE * 1000)
  const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
  tx.sign(signingKey)
  const raw = tx.serialize()

  try {
    const txid = await broadcastWithFallbacks(raw)
    maintState.pendingSplitUntilByAddress.set(address, Date.now() + SPLIT_COOLDOWN_MS)
    return { txid, address, outputs: outputCount }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('MEMPOOL_CHAIN_LIMIT')) {
      // Backoff this wallet for 10 minutes (wait for block)
      maintState.mempoolBackoffUntil.set(address, Date.now() + 10 * 60 * 1000)
      console.warn(`⏳ UTXO-Split: Mempool chain limit for ${address.substring(0, 10)}... — backing off 10 min`)
      return null
    }
    throw e
  }
}

// ─── UTXO Health Diagnostics ────────────────────────────────────────────────
export async function logUtxoHealthDiagnostics(): Promise<void> {
  const keys = (bsvConfig?.wallets?.privateKeys || []).filter(k => !!k)
  if (keys.length === 0) return

  console.log(`\n📊 UTXO Pool Health Report (target: ${TARGET}/wallet, low-water: ${LOW_WATER}, split-batch: ${SPLIT_BATCH})`)
  console.log(`   Auto-calculated from ${EXPECTED_TX_PER_DAY.toLocaleString()} TX/day across ${WALLET_COUNT} wallet(s)`)

  for (let i = 0; i < keys.length; i++) {
    try {
      const sdk = SDKPrivateKey.fromWif(keys[i])
      const address = sdk.toPublicKey().toAddress().toString()
      const utxos = await getUnspent(address)
      const confirmed = utxos.filter((u: any) => {
        const conf = (u.confirmations || 0) >= MIN_CONF
        const byHeight = typeof u.height === 'number' ? u.height > 0 : true
        return conf || byHeight
      })
      const unconfirmed = utxos.filter((u: any) => {
        return (typeof u.height === 'number' ? u.height === 0 : false) || (u.confirmations || 0) === 0
      })
      const totalSats = utxos.reduce((s: number, u: any) => s + (u.value || 0), 0)
      const confirmedSats = confirmed.reduce((s: number, u: any) => s + (u.value || 0), 0)

      const hasAny = confirmed.length + unconfirmed.length > 0
      const status = confirmed.length >= LOW_WATER ? '✅' :
        hasAny ? '⚠️' : '❌'
      console.log(`   Wallet ${i + 1} (${address}):`)
      console.log(`     ${status} ${confirmed.length} confirmed UTXO(s) (${(confirmedSats / 1e8).toFixed(6)} BSV) | ${unconfirmed.length} unconfirmed (${((totalSats - confirmedSats) / 1e8).toFixed(6)} BSV)`)

      if (confirmed.length === 0 && unconfirmed.length > 0) {
        console.log(`     ℹ️  All ${unconfirmed.length} UTXO(s) unconfirmed — will be usable once mined (spending proceeds normally)`)
      } else if (confirmed.length > 0 && confirmed.length < LOW_WATER) {
        console.log(`     ⚠️  Below low-water mark (${LOW_WATER}) — UTXO maintainer will auto-split`)
      }
    } catch (e) {
      console.log(`   Wallet ${i + 1}: ❌ Error — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log('')
}

// ─── Mempool backoff management (exported for blockchain.ts) ────────────────
/**
 * Signal that a wallet hit the mempool-chain limit during a broadcast.
 * The UTXO maintainer will pause splits for this wallet and blockchain.ts
 * can use this to skip the wallet in round-robin for a period.
 */
export function signalMempoolChainLimit(address: string): void {
  const BACKOFF_MS = 10 * 60 * 1000 // 10 minutes (~1 block)
  maintState.mempoolBackoffUntil.set(address, Date.now() + BACKOFF_MS)
}

/**
 * Check whether a wallet is currently in mempool-chain backoff.
 */
export function isWalletBackedOff(address: string): boolean {
  const until = maintState.mempoolBackoffUntil.get(address) || 0
  if (until <= Date.now()) {
    maintState.mempoolBackoffUntil.delete(address)
    return false
  }
  return true
}

/**
 * Clear backoff for a wallet (e.g. when a new block confirms parents).
 */
export function clearWalletBackoff(address: string): void {
  maintState.mempoolBackoffUntil.delete(address)
}

// ─── Main maintainer loop ───────────────────────────────────────────────────
const UTXO_MAINTAINER_KEY = '__GAIALOG_UTXO_MAINTAINER_STARTED__' as const

export function startUtxoMaintainer(): void {
  const disabled = process.env.BSV_UTXO_MAINTAINER_DISABLED === 'true'
  if (disabled) return

  // Prevent stacking duplicate intervals across module re-evaluations
  if ((globalThis as any)[UTXO_MAINTAINER_KEY]) return
  ;(globalThis as any)[UTXO_MAINTAINER_KEY] = true

  let running = false
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
            console.log(`🔧 UTXO split broadcasted for ${split.address.substring(0, 10)}...: ${split.outputs} outputs → ${split.txid.substring(0, 12)}...`)
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
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

  // Log health diagnostics at startup, then start the maintenance loop
  logUtxoHealthDiagnostics()
    .catch(() => {})
    .finally(() => {
      cycle().catch(() => {})
    })
  setInterval(() => { cycle().catch(() => {}) }, INTERVAL_MS)
  console.log(`🔧 UTXO Maintainer started (interval ${INTERVAL_MS / 1000}s, target ${TARGET}/wallet, low-water ${LOW_WATER})`)
}
