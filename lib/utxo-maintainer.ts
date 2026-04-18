import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import * as bsv from 'bsv'
// BSV has no protocol-enforced dust limit — override the BTC-inherited default
;(bsv.Transaction as any).DUST_AMOUNT = 1
import { bsvConfig } from './bsv-config'
import { getMutatorControlState, logMutatorSkip } from './mutator-control'
import { getSpendSourceForWallet, getTreasuryTopicForWallet, getWalletIndexForAddress } from './spend-source'
import { acquireReserveUtxo, admitSplitOutputs, releaseUtxo, type InventoryUtxo } from './utxo-inventory'
import { getMaintainerMinConfirmations } from './utxo-spend-policy'
import { fetchTreasuryOverlayInventorySnapshot, logTreasuryOverlayInventorySummary } from './utxo-overlay-monitor'
import { broadcastSplitTransactionRaw } from './broadcast-raw-tx'

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
const MIN_CONF = getMaintainerMinConfirmations()
const INTERVAL_MS = Number(process.env.BSV_UTXO_MAINTAINER_INTERVAL_MS || 30000) // 30s for high-throughput
// GorillaPool/TAAL ARC policy floor: ~100 sat/kB. Operator standard 0.1025 sat/byte (102.5 sat/kB).
// Margin is thin (2.5%); reliability requires deterministic explicit-fee builds — never tx.feePerKb().
const FEE_RATE = Number((process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE) || 0.1025)
const SPLIT_FEE_RATE = Number(process.env.BSV_UTXO_SPLIT_FEE_RATE_SAT_PER_BYTE || FEE_RATE)
// BSV has no protocol-enforced dust limit (unlike BTC's 546). 1 sat is the minimum viable output.
const DUST_LIMIT = 1
// Conservative size constants (must match data-write path in lib/blockchain.ts):
//   signed P2PKH input = 149 bytes (worst-case; absorbs high-S signature variance)
//   P2PKH output       = 34 bytes (8 value + 1 scriptLen + 25 script)
//   tx envelope        = 12 bytes (4 version + 4 locktime + ≤3 in-count varint + ≤3 out-count varint)
const SPLIT_INPUT_BYTES = 149
const SPLIT_P2PKH_OUTPUT_BYTES = 34
const SPLIT_BASE_BYTES = 12
function estimateSplitBytes(outputCount: number): number {
  // outputs (split) + 1 change output = (outputCount + 1) × 34
  return SPLIT_BASE_BYTES + SPLIT_INPUT_BYTES + (outputCount + 1) * SPLIT_P2PKH_OUTPUT_BYTES
}
function estimateSplitFee(outputCount: number): number {
  return Math.ceil(estimateSplitBytes(outputCount) * SPLIT_FEE_RATE)
}
// Dynamic split cooldown:
// ensure split production can keep pace with expected per-wallet TX throughput.
const PER_WALLET_EXPECTED_TPS = EXPECTED_TX_PER_DAY / WALLET_COUNT / 86400
const MIN_SPLIT_COOLDOWN_MS = Number(process.env.BSV_UTXO_SPLIT_MIN_COOLDOWN_MS || 30000) // 30s floor
const AUTO_SPLIT_COOLDOWN_MS = Math.max(
  MIN_SPLIT_COOLDOWN_MS,
  Math.floor((SPLIT_BATCH / Math.max(0.1, PER_WALLET_EXPECTED_TPS * 1.25)) * 1000)
)
const SPLIT_COOLDOWN_MS = Number(process.env.BSV_UTXO_SPLIT_COOLDOWN_MS || Math.min(5 * 60 * 1000, AUTO_SPLIT_COOLDOWN_MS))
const SPLIT_RESERVE_MIN_SATS = Math.max(
  SPLIT_OUTPUT_SATS * 2,
  Number(process.env.BSV_UTXO_RESERVE_MIN_SATS || 0),
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
  }
}
const maintState: {
  pendingSplitUntilByAddress: Map<string, number>
  mempoolBackoffUntil: Map<string, number>
} = _g.__GAIALOG_UTXO_MAINT_STATE__

// ─── UTXO fetch ─────────────────────────────────────────────────────────────
async function getUnspent(address: string): Promise<any[]> {
  const { getUnspentForAddress } = await import('./utxo-provider')
  return getUnspentForAddress(address, {
    confirmedOnly: process.env.BSV_UTXO_BOOTSTRAP_FROM_UNCONFIRMED !== 'true',
  })
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
      // Align with BSV_UTXO_MIN_CONFIRMATIONS / maintainer: 0 = count unconfirmed overlay rows too.
      confirmedOnly: MIN_CONF > 0,
      allowDegradedStale: true,
    })
  } catch {
    return legacyConfirmedCount
  }
}

async function submitSplitToSpendSource(
  walletIndex: number,
  txid: string,
  rawTx: string,
  scriptHex: string,
  inputSatoshis: number,
): Promise<void> {
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
        satoshis: Number(inputSatoshis || 0),
      }],
    },
  })
}

function estimateSplitRequirement(outputCount: number): number {
  const safeOutputs = Math.max(2, outputCount)
  const totalOut = safeOutputs * SPLIT_OUTPUT_SATS
  const fee = estimateSplitFee(safeOutputs)
  return totalOut + fee + DUST_LIMIT
}

function maxSplitOutputsForInput(inputSatoshis: number): number {
  // Solve: input ≥ N × SPLIT_OUTPUT_SATS + ceil((SPLIT_BASE + INPUT + (N+1) × OUTPUT) × FEE_RATE) + DUST_LIMIT
  // Without ceiling: input ≥ N × (SPLIT_OUTPUT_SATS + OUTPUT × FEE_RATE) + (BASE + INPUT + OUTPUT) × FEE_RATE + DUST_LIMIT
  const fixedOverhead = (SPLIT_BASE_BYTES + SPLIT_INPUT_BYTES + SPLIT_P2PKH_OUTPUT_BYTES) * SPLIT_FEE_RATE
  const perOutputCost = SPLIT_OUTPUT_SATS + SPLIT_P2PKH_OUTPUT_BYTES * SPLIT_FEE_RATE
  return Math.floor((inputSatoshis - fixedOverhead - DUST_LIMIT) / perOutputCost)
}

// ─── Core split logic ───────────────────────────────────────────────────────
async function topUpWallet(wif: string): Promise<{ txid: string; address: string; outputs: number } | null> {
  const sdk = SDKPrivateKey.fromWif(wif)
  const address = sdk.toPublicKey().toAddress().toString()
  const walletIndex = (bsvConfig?.wallets?.privateKeys || []).filter(k => !!k).findIndex(candidate => candidate === wif)
  if (walletIndex < 0) return null

  // Respect mempool backoff
  const backoffUntil = maintState.mempoolBackoffUntil.get(address) || 0
  if (backoffUntil > Date.now()) return null

  const count = await getSpendableInventoryCount(address, 0)

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

  const minUsefulInput = estimateSplitRequirement(2)
  let inputSource = await acquireReserveUtxo({
    walletIndex,
    minSatoshis: minUsefulInput,
    confirmedOnly: MIN_CONF > 0,
  })

  if (!inputSource && process.env.BSV_UTXO_BOOTSTRAP_FROM_UNCONFIRMED === 'true') {
    inputSource = await acquireReserveUtxo({
      walletIndex,
      minSatoshis: minUsefulInput,
      confirmedOnly: false,
    })
  }

  if (!inputSource) return null

  const maxOutputs = maxSplitOutputsForInput(Number(inputSource.satoshis))
  if (maxOutputs < 2) {
    await releaseUtxo(inputSource.topic, inputSource.txid, inputSource.vout)
    return null
  }

  const outputCount = Math.min(need, maxOutputs)
  return doSplit(wif, walletIndex, address, inputSource, outputCount)
}

async function doSplit(
  wif: string,
  walletIndex: number,
  address: string,
  inputSource: InventoryUtxo,
  outputCount: number,
): Promise<{ txid: string; address: string; outputs: number } | null> {
  const scriptHex = inputSource.output_script || (
    (bsv.Script as any).fromAddress
      ? (bsv.Script as any).fromAddress(address).toHex()
      : p2pkhScriptHexFromWif(wif)
  )

  const input = {
    txId: inputSource.txid,
    outputIndex: inputSource.vout,
    address,
    script: scriptHex,
    satoshis: Number(inputSource.satoshis),
  }
  const inputSats = Number(inputSource.satoshis)
  const explicitFee = estimateSplitFee(outputCount)
  // Sanity: maxSplitOutputsForInput should already guarantee this; double-check defensively.
  const minRequired = outputCount * SPLIT_OUTPUT_SATS + explicitFee + DUST_LIMIT
  if (inputSats < minRequired) {
    await releaseUtxo(inputSource.topic, inputSource.txid, inputSource.vout)
    console.warn(`⚠️ UTXO-Split: input ${inputSats} sats < required ${minRequired} (outputs=${outputCount}, fee=${explicitFee}); releasing`)
    return null
  }
  const tx = new (bsv as any).Transaction().from([input])
  for (let i = 0; i < outputCount; i++) tx.to(address, SPLIT_OUTPUT_SATS)
  // Explicit fee — never tx.feePerKb(), which under-estimates pre-sign size by ~5x
  // and produces ~22 sat/kB actual rate (cause of historical splitter ARC rejections).
  tx.fee(explicitFee).change(address)
  const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
  tx.sign(signingKey)
  const raw = tx.serialize()

  try {
    const txid = await broadcastSplitTransactionRaw(raw)
    maintState.pendingSplitUntilByAddress.set(address, Date.now() + SPLIT_COOLDOWN_MS)
    try {
      const outputs = tx.outputs.map((output: any, vout: number) => {
        let outputScript = ''
        try {
          outputScript = typeof output?.script?.toHex === 'function'
            ? output.script.toHex()
            : String(output?.script || '')
        } catch {}
        const satoshis = Number(output?.satoshis || output?._satoshis || 0)
        const isChange = vout >= outputCount
        return {
          vout,
          satoshis,
          outputScript,
          utxoRole: isChange && satoshis >= Math.max(SPLIT_RESERVE_MIN_SATS, estimateSplitRequirement(Math.min(outputCount, SPLIT_BATCH)))
            ? 'reserve' as const
            : 'pool' as const,
        }
      })
      await admitSplitOutputs({
        topic: inputSource.topic,
        walletIndex,
        spentTxid: inputSource.txid,
        spentVout: inputSource.vout,
        spendingTxid: txid,
        rawTx: raw,
        outputs,
      })
    } catch (inventoryError) {
      const message = inventoryError instanceof Error ? inventoryError.message : String(inventoryError)
      console.error(`❌ Split inventory admit failed for ${txid.substring(0, 12)}...: ${message}`)
    }
    try {
      await submitSplitToSpendSource(walletIndex, txid, raw, scriptHex, Number(inputSource.satoshis))
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError)
      console.warn(`⚠️ Split overlay submit failed for ${txid.substring(0, 12)}...: ${message}`)
    }
    return { txid, address, outputs: outputCount }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await releaseUtxo(inputSource.topic, inputSource.txid, inputSource.vout)
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

  const spendMode = String(process.env.BSV_SPEND_SOURCE_MODE || '').toLowerCase()

  console.log(`\n📊 UTXO Pool Health Report (target: ${TARGET}/wallet, low-water: ${LOW_WATER}, split-batch: ${SPLIT_BATCH})`)
  console.log(`   Auto-calculated from ${EXPECTED_TX_PER_DAY.toLocaleString()} TX/day across ${WALLET_COUNT} wallet(s)`)
  console.log(`   Maintainer min confirmations (BSV_UTXO_MIN_CONFIRMATIONS): ${MIN_CONF}`)

  if (spendMode === 'overlay') {
    try {
      const snap = await fetchTreasuryOverlayInventorySnapshot()
      for (const row of snap) {
        if (row.error) {
          console.log(`   Overlay ${row.walletLabel} (${row.topic}): ❌ ${row.error}`)
        } else {
          console.log(
            `   Overlay ${row.walletLabel}: pool=${row.totalSpendable} (${row.confirmedSpendable} confirmed, ${row.lockedPool} locked), reserve=${row.totalReserve} (${row.confirmedReserve} confirmed, ${row.lockedReserve} locked)`,
          )
        }
      }
    } catch (e) {
      console.log(`   Overlay inventory snapshot: ❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

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
      console.log(`   Wallet ${i + 1} (${address}) — legacy/WoC view:`)
      console.log(`     ${status} ${confirmed.length} UTXO(s) meeting minConf=${MIN_CONF} (${(confirmedSats / 1e8).toFixed(6)} BSV) | ${unconfirmed.length} other (${((totalSats - confirmedSats) / 1e8).toFixed(6)} BSV)`)

      if (confirmed.length === 0 && unconfirmed.length > 0) {
        console.log(`     ℹ️  Legacy path shows unconfirmed-only — overlay spend-source may still list admitted rows (see above).`)
      } else if (confirmed.length > 0 && confirmed.length < LOW_WATER) {
        console.log(`     ⚠️  Below low-water mark (${LOW_WATER}) — UTXO maintainer will auto-split when a large enough input exists`)
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
const UTXO_INV_LOG_KEY = '__GAIALOG_UTXO_INV_LOG_AT__' as const

function getLastInventoryLogAt(): number {
  return Number((globalThis as any)[UTXO_INV_LOG_KEY] || 0)
}

function setLastInventoryLogAt(ts: number): void {
  ;(globalThis as any)[UTXO_INV_LOG_KEY] = ts
}

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

    const invInterval = Math.max(60_000, Number(process.env.BSV_UTXO_MAINTAINER_INVENTORY_LOG_INTERVAL_MS || 300_000))
    const now = Date.now()
    if (now - getLastInventoryLogAt() >= invInterval) {
      setLastInventoryLogAt(now)
      logTreasuryOverlayInventorySummary().catch(() => {})
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
