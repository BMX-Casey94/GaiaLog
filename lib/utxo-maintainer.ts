import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import * as bsv from 'bsv'
// BSV has no protocol-enforced dust limit — override the BTC-inherited default
;(bsv.Transaction as any).DUST_AMOUNT = 1
import { bsvConfig } from './bsv-config'
import { getMutatorControlState, logMutatorSkip } from './mutator-control'
import { getSpendSourceForWallet, getTreasuryTopicForWallet, getWalletIndexForAddress } from './spend-source'

const NET = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY || ''
// Broadcasting endpoints: GorillaPool ARC (primary) → TAAL ARC (fallback) → WoC (final)
const GORILLAPOOL_ARC_ENDPOINT = (process.env.BSV_GORILLAPOOL_ARC_ENDPOINT || 'https://arc.gorillapool.io').replace(/\/$/, '')
const TAAL_ARC_ENDPOINT = (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/$/, '')
const ARC_KEY = process.env.BSV_ARC_API_KEY || ''

// ─── Auto-sizing from expected throughput ───────────────────────────────────
// 2,000,000 TX/day across 3 wallets ≈ 666,667 TX/wallet/day.
// With a ~20 minute confirmation window, each wallet needs materially higher
// inventory until the admission-driven splitter replaces this legacy auto-sizing.
// Users can override via env vars; otherwise we auto-calculate from BSV_EXPECTED_TX_PER_DAY.
const EXPECTED_TX_PER_DAY = Number(process.env.BSV_EXPECTED_TX_PER_DAY || 2000000)
const WALLET_COUNT = Math.max(1, (bsvConfig?.wallets?.privateKeys || []).filter(k => !!k).length)
const CONFIRMATION_WINDOW_SECS = Number(process.env.BSV_CONFIRMATION_WINDOW_SECS || 1200) // ~20 min (2 blocks)
const AUTO_TARGET = Math.ceil((EXPECTED_TX_PER_DAY / WALLET_COUNT / 86400) * CONFIRMATION_WINDOW_SECS * 1.5) // 1.5x headroom

const TARGET = Number(process.env.BSV_UTXO_TARGET_PER_WALLET || Math.max(200, AUTO_TARGET))
const LOW_WATER = Number(process.env.BSV_UTXO_LOW_WATERMARK || Math.max(150, Math.floor(TARGET * 0.75)))
const SPLIT_BATCH_MAX = Number(process.env.BSV_UTXO_SPLIT_BATCH_MAX || 1200)
const SPLIT_BATCH = Number(process.env.BSV_UTXO_SPLIT_BATCH || Math.min(SPLIT_BATCH_MAX, Math.max(100, Math.ceil(TARGET * 0.4))))
const SPLIT_OUTPUT_SATS = Number(process.env.BSV_UTXO_SPLIT_OUTPUT_SATS || 2000)
const MIN_CONF = Number(process.env.BSV_UTXO_MIN_CONFIRMATIONS || 1)
const INTERVAL_MS = Number(process.env.BSV_UTXO_MAINTAINER_INTERVAL_MS || 30000) // 30s for high-throughput
// GorillaPool/TAAL ARC minimum: 100 sat/kB. Default 0.105 sat/byte (105 sat/kB) for 5% margin.
const FEE_RATE = Number((process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE) || 0.105)
const SPLIT_FEE_RATE = Number(process.env.BSV_UTXO_SPLIT_FEE_RATE_SAT_PER_BYTE || FEE_RATE)
// BSV has no protocol-enforced dust limit (unlike BTC). 1 sat is the minimum viable output.
const DUST_LIMIT = 1
const ENABLE_UTXO_DB_LOCKS = process.env.BSV_ENABLE_UTXO_DB_LOCKS === 'true'
// Dynamic split cooldown:
// ensure split production can keep pace with expected per-wallet TX throughput.
const PER_WALLET_EXPECTED_TPS = EXPECTED_TX_PER_DAY / WALLET_COUNT / 86400
const MIN_SPLIT_COOLDOWN_MS = Number(process.env.BSV_UTXO_SPLIT_MIN_COOLDOWN_MS || 30000) // 30s floor
const AUTO_SPLIT_COOLDOWN_MS = Math.max(
  MIN_SPLIT_COOLDOWN_MS,
  Math.floor((SPLIT_BATCH / Math.max(0.1, PER_WALLET_EXPECTED_TPS * 1.25)) * 1000)
)
const SPLIT_COOLDOWN_MS = Number(process.env.BSV_UTXO_SPLIT_COOLDOWN_MS || Math.min(5 * 60 * 1000, AUTO_SPLIT_COOLDOWN_MS))
const SPLIT_INPUT_HOLD_MS = Number(
  process.env.BSV_UTXO_SPLIT_INPUT_HOLD_MS ||
  process.env.BSV_UTXO_LOCK_TTL_MS ||
  10 * 60 * 1000
)

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
    heldSplitInputs: new Map<string, number>(), // `${address}:${txid:vout}` -> expiry
  }
}
const maintState: {
  pendingSplitUntilByAddress: Map<string, number>
  mempoolBackoffUntil: Map<string, number>
  heldSplitInputs: Map<string, number>
} = _g.__GAIALOG_UTXO_MAINT_STATE__
if (!maintState.heldSplitInputs) {
  maintState.heldSplitInputs = new Map<string, number>()
}

function holdKey(address: string, utxoKey: string): string {
  return `${address}:${utxoKey}`
}

function isSplitInputHeld(address: string, utxoKey: string): boolean {
  const key = holdKey(address, utxoKey)
  const until = maintState.heldSplitInputs.get(key) || 0
  if (until <= Date.now()) {
    maintState.heldSplitInputs.delete(key)
    return false
  }
  return true
}

export function isWalletSplitInputHeld(address: string, utxoKey: string): boolean {
  return isSplitInputHeld(address, utxoKey)
}

function reserveSplitInputHold(address: string, utxoKey: string): void {
  maintState.heldSplitInputs.set(holdKey(address, utxoKey), Date.now() + Math.max(30000, SPLIT_INPUT_HOLD_MS))
}

function releaseSplitInputHold(address: string, utxoKey: string): void {
  maintState.heldSplitInputs.delete(holdKey(address, utxoKey))
}

// ─── ARC response validation (mirrors blockchain.ts logic) ──────────────────
const ARC_OK_STATUSES = new Set([
  'SEEN_ON_NETWORK', 'MINED', 'ACCEPTED', 'STORED', 'RECEIVED',
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
  return getUnspentForAddress(address, {
    confirmedOnly: process.env.BSV_UTXO_BOOTSTRAP_FROM_UNCONFIRMED !== 'true',
  })
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

async function getSpendableInventoryCount(address: string, legacyConfirmedCount: number): Promise<number> {
  const walletIndex = getWalletIndexForAddress(address)
  if (walletIndex == null) return legacyConfirmedCount

  try {
    return await getSpendSourceForWallet(walletIndex).countSpendable({
      topic: getTreasuryTopicForWallet(walletIndex),
      minSatoshis: 0,
      excludeReserved: false,
      confirmedOnly: true,
      allowDegradedStale: true,
    })
  } catch {
    return legacyConfirmedCount
  }
}

async function submitSplitToSpendSource(
  address: string,
  txid: string,
  rawTx: string,
  scriptHex: string,
  inputSource: any,
): Promise<void> {
  const walletIndex = getWalletIndexForAddress(address)
  if (walletIndex == null) return

  await getSpendSourceForWallet(walletIndex).submitAcceptedTx({
    clientRequestId: txid,
    topics: [getTreasuryTopicForWallet(walletIndex)],
    requireAllHostAcks: true,
    rawTxEnvelope: {
      txid,
      rawTx,
      acceptedVia: 'splitter',
      broadcastedAt: new Date().toISOString(),
      prevouts: [{
        lockingScript: scriptHex,
        satoshis: Number(inputSource?.value || 0),
      }],
    },
  })
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
  const count = await getSpendableInventoryCount(address, confirmed.length)

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

  if (SPLIT_OUTPUT_SATS < DUST_LIMIT) {
    console.error(`❌ Cannot split: BSV_UTXO_SPLIT_OUTPUT_SATS (${SPLIT_OUTPUT_SATS}) is below dust limit (${DUST_LIMIT} sats)`)
    return null
  }

  // Choose the largest viable candidate and reserve it before split, so the
  // broadcaster and splitter don't select the same UTXO under concurrency.
  const candidates = confirmed.slice().sort((a: any, b: any) => (b.value || 0) - (a.value || 0))
  if (candidates.length === 0 && process.env.BSV_UTXO_BOOTSTRAP_FROM_UNCONFIRMED === 'true') {
    candidates.push(...unconfirmed.slice().sort((a: any, b: any) => (b.value || 0) - (a.value || 0)))
  }
  for (const inputSource of candidates) {
    const inputKey = `${inputSource.tx_hash}:${inputSource.tx_pos}`
    if (isSplitInputHeld(address, inputKey)) continue

    let dbReserved = false
    if (ENABLE_UTXO_DB_LOCKS) {
      try {
        const { reserveUtxoKeys } = await import('./utxo-locks')
        const reserved = await reserveUtxoKeys([inputKey], undefined, Math.max(60000, SPLIT_INPUT_HOLD_MS))
        if (!reserved.includes(inputKey)) continue
        dbReserved = true
      } catch {
        // If lock infra is unavailable, continue with local hold.
      }
    }

    reserveSplitInputHold(address, inputKey)

    const totalOut = need * SPLIT_OUTPUT_SATS
    const estBytes = 300 + need * 40
    const fee = Math.ceil(estBytes * SPLIT_FEE_RATE)
    const required = totalOut + fee + DUST_LIMIT

    if (inputSource.value < required) {
      // If the UTXO isn't large enough, try fewer outputs
      const maxOutputs = Math.floor((inputSource.value - 300 * SPLIT_FEE_RATE - DUST_LIMIT) / (SPLIT_OUTPUT_SATS + 40 * SPLIT_FEE_RATE))
      if (maxOutputs < 2) {
        if (dbReserved) {
          try { const { releaseUtxoKeys } = await import('./utxo-locks'); await releaseUtxoKeys([inputKey]) } catch {}
        }
        releaseSplitInputHold(address, inputKey)
        continue
      }
      const adjustedNeed = Math.min(need, maxOutputs)
      return doSplit(wif, address, inputSource, adjustedNeed, inputKey, dbReserved)
    }

    return doSplit(wif, address, inputSource, need, inputKey, dbReserved)
  }

  return null
}

async function doSplit(
  wif: string,
  address: string,
  inputSource: any,
  outputCount: number,
  inputKey: string,
  dbReserved: boolean
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
  tx.feePerKb(Math.ceil(SPLIT_FEE_RATE * 1000)).change(address)
  const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
  tx.sign(signingKey)
  const raw = tx.serialize()

  try {
    const txid = await broadcastWithFallbacks(raw)
    maintState.pendingSplitUntilByAddress.set(address, Date.now() + SPLIT_COOLDOWN_MS)
    try {
      await submitSplitToSpendSource(address, txid, raw, scriptHex, inputSource)
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError)
      console.warn(`⚠️ Split overlay submit failed for ${txid.substring(0, 12)}...: ${message}`)
    }
    // Keep reservations on success for a short hold period; indexers may still
    // report the spent UTXO for a while, and immediate reuse causes doublespends.
    return { txid, address, outputs: outputCount }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (dbReserved) {
      try { const { releaseUtxoKeys } = await import('./utxo-locks'); await releaseUtxoKeys([inputKey]) } catch {}
    }
    releaseSplitInputHold(address, inputKey)
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
  const mutatorControl = getMutatorControlState()
  if (!mutatorControl.mutatorsEnabled) {
    logMutatorSkip('utxo-maintainer')
    return
  }
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
  console.log(
    `🔧 UTXO Maintainer started (interval ${INTERVAL_MS / 1000}s, target ${TARGET}/wallet, low-water ${LOW_WATER}, split-batch ${SPLIT_BATCH}, split-cooldown ${Math.round(SPLIT_COOLDOWN_MS / 1000)}s, expectedTPS/wallet ${PER_WALLET_EXPECTED_TPS.toFixed(2)})`
  )
}
