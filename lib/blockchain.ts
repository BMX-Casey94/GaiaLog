import * as bsv from 'bsv'
import * as v8 from 'v8'
// BSV has no protocol-enforced dust limit (unlike BTC's 546 sat).
// Override the library's inherited BTC default so change outputs of any
// value (≥1 sat) are kept instead of being silently absorbed into fees.
;(bsv.Transaction as any).DUST_AMOUNT = 1
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
// DB write via repositories (Postgres)
import { upsertTxLog } from './repositories'
import { bsvConfig } from './bsv-config'
import { APP_NAME, SCHEMA_VERSION } from './constants'
// Data credibility features
import { dataValidator, qualityScorer } from './validation'
import { createCredibilityBuilder } from './pipeline-integrity'
import type { CredibilityMetadata } from './types/credibility'
// Explorer store – routed through the read-source switcher (legacy / dual / overlay)
import { addReading, canAttemptExplorerWrite, type StoredReading } from './explorer-read-source'
import { removeUnconfirmedReading } from './overlay-explorer-repository'
import { getSpendSourceForWallet, getTreasuryTopicForWallet, getWalletIndexForAddress, type SpendableOutput } from './spend-source'
import { acquirePoolUtxo, consumeAndAdmitChange, releaseUtxo, type InventoryUtxo } from './utxo-inventory'
import { getMinSpendConfirmations } from './utxo-spend-policy'
import {
  logOverlayEmptyListDrift,
  logOverlayUnconfirmedOnlyBlocked,
} from './utxo-overlay-monitor'
import { QueueLane, resolveProviderIdFromSource, resolveSourceLabel } from './stream-registry'
import { throughputObservability } from './throughput-observability'

// Types
export interface BlockchainData {
  stream: string
  timestamp: number
  payload: any
  family?: string
  providerId?: string
  datasetId?: string
  queueLane?: QueueLane
  traceId?: string
}

export interface TransactionLog {
  txid: string
  stream: string
  timestamp: number
  payload: any
  status: 'pending' | 'confirmed' | 'failed'
  error?: string
}

type ConfirmationCheckState = {
  txid: string
  streamType: string
  attempts: number
  nextCheckAt: number
  generation: number
  firstScheduledAt: number
}

type ConfirmationCheckHeapItem = {
  txid: string
  nextCheckAt: number
  generation: number
}

type WriteTraceSummary = {
  traceId: string
  stream: string
  totalMs: number
  walletLookupMs?: number
  walletIndex?: number
  address?: string
  spendableCount?: number
  txBuildMs?: number
  broadcastMs?: number
  txLogMs?: number
  acceptedVia?: string
  txid?: string
  error?: string
}

// Environment variables
const BSV_PRIVATE_KEY = process.env.BSV_PRIVATE_KEY || process.env.BSV_WALLET_1_PRIVATE_KEY || process.env.BSV_WALLET_2_PRIVATE_KEY || process.env.BSV_WALLET_3_PRIVATE_KEY
const BSV_FALLBACK_WIF = (bsvConfig?.wallets?.privateKeys && bsvConfig.wallets.privateKeys.length > 0) ? bsvConfig.wallets.privateKeys[0] : ''
const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY
const WOC_NETWORK = (process.env.BSV_NETWORK === 'mainnet') ? 'main' : 'test'
// Broadcasting endpoints: GorillaPool ARC (primary) → TAAL ARC (fallback)
const GORILLAPOOL_ARC_ENDPOINT = (process.env.BSV_GORILLAPOOL_ARC_ENDPOINT || 'https://arc.gorillapool.io').replace(/\/$/, '')
const TAAL_ARC_ENDPOINT = (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/$/, '')
// GorillaPool/TAAL ARC policy floor: ~100 sat/kB.
// Operator standard: 0.1025 sat/byte (102.5 sat/kB) — 2.5% margin above ARC floor.
// This thin margin is only safe in combination with:
//   (a) deterministic explicit-fee build (no dust-burn fallback) — see buildSignedTransaction
//   (b) INPUT_SIGNED = 149 conservative size estimate (absorbs ECDSA signature variance)
const FEE_RATE_SAT_PER_BYTE = Number(process.env.BSV_TX_FEE_RATE || 0.1025)
// BSV has no protocol-enforced dust limit (unlike BTC's 546). 1 sat is the minimum viable output.
const DUST_LIMIT = 1
// UTXO spend policy: default allows all UTXOs (including unconfirmed).
// Protection against long unconfirmed chains is handled architecturally:
//   1. usedKeys TTL — prevents re-spending the same UTXO for 30 min
//   2. mempool-chain backoff — pauses a wallet for 10 min on "too-long-mempool-chain"
//   3. UTXO splitter — creates fan-out pools from confirmed UTXOs
// Override with BSV_MIN_SPEND_CONFIRMATIONS=1 (or higher) if desired.
const MIN_SPEND_CONF = getMinSpendConfirmations()
const REFRESH_THRESHOLD = Number(process.env.BSV_UTXO_REFRESH_THRESHOLD || 10)
const SPEND_SOURCE_LIST_LIMIT = Math.max(100, Number(process.env.BSV_SPEND_SOURCE_LIST_LIMIT || 5000))
const BROADCAST_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.BSV_BROADCAST_TIMEOUT_MS || 15000))
const SLOW_WRITE_TO_CHAIN_MS = Math.max(1000, Number(process.env.BSV_SLOW_WRITE_TO_CHAIN_MS || 5000))
const SLOW_UTXO_LOOKUP_MS = Math.max(250, Number(process.env.BSV_SLOW_UTXO_LOOKUP_MS || 2000))
const EMERGENCY_LEGACY_UTXO_MODE = process.env.GAIALOG_EMERGENCY_LEGACY_UTXO === 'true'
const EMERGENCY_UTXO_MANAGER_URL = String(process.env.GAIALOG_EMERGENCY_UTXO_MANAGER_URL || '').trim()
const EMERGENCY_UTXO_MANAGER_SECRET = String(process.env.GAIALOG_EMERGENCY_UTXO_MANAGER_SECRET || '').trim()
const EMERGENCY_UTXO_MANAGER_TIMEOUT_MS = Math.max(1000, Number(process.env.GAIALOG_EMERGENCY_UTXO_MANAGER_TIMEOUT_MS || 5000))

// Data credibility features (opt-in for now)
const ENABLE_CREDIBILITY = process.env.GAIALOG_ENABLE_CREDIBILITY === 'true'
const REQUIRE_VALIDATION = process.env.GAIALOG_REQUIRE_VALIDATION === 'true'

// Optional UTXO fetch controls and lightweight pooling (defaults keep current behaviour)
const ENABLE_UTXO_POOL = process.env.BSV_ENABLE_UTXO_POOL === 'true'
const UTXO_POOL_MIN_SATS = Math.max(0, Number(process.env.BSV_UTXO_POOL_MIN_SATS || 0))
const UTXO_POOL_TTL_MS = Number(process.env.BSV_UTXO_POOL_TTL_MS || 10000)
const UTXO_FETCH_BACKOFF_BASE_MS = Number(process.env.BSV_UTXO_FETCH_BACKOFF_BASE_MS || 250)
const UTXO_FETCH_MAX_RETRIES = Number(process.env.BSV_UTXO_FETCH_MAX_RETRIES || 4)
// How long to treat an input UTXO as "used" (to avoid re-spends while indexers lag).
// This prevents txn-mempool-conflict when WoC /unspent still lists a just-spent UTXO.
const UTXO_USED_KEY_TTL_MS = Number(process.env.BSV_UTXO_USED_KEY_TTL_MS || 30 * 60 * 1000) // 30 min
const LOG_SUMMARY_INTERVAL_MS = Math.max(60000, Number(process.env.BSV_LOG_SUMMARY_INTERVAL_MS || 30 * 60 * 1000)) // 30 min
const MAX_IN_MEMORY_TX_LOG = Math.max(100, Number(process.env.BSV_MAX_IN_MEMORY_TX_LOG || 500))
const MAX_CONFIRMATION_CHECK_ATTEMPTS = Math.max(1, Number(process.env.BSV_CONFIRMATION_MAX_ATTEMPTS || 60))
const CONFIRMATION_INITIAL_DELAY_MS = Math.max(30000, Number(process.env.BSV_CONFIRMATION_INITIAL_DELAY_MS || 90 * 1000))
const CONFIRMATION_RETRY_BASE_DELAY_MS = Math.max(60000, Number(process.env.BSV_CONFIRMATION_RETRY_BASE_DELAY_MS || 5 * 60 * 1000))
const CONFIRMATION_ERROR_DELAY_MS = Math.max(CONFIRMATION_RETRY_BASE_DELAY_MS, Number(process.env.BSV_CONFIRMATION_ERROR_DELAY_MS || 10 * 60 * 1000))
const CONFIRMATION_MAX_RETRY_DELAY_MS = Math.max(CONFIRMATION_ERROR_DELAY_MS, Number(process.env.BSV_CONFIRMATION_MAX_RETRY_DELAY_MS || 30 * 60 * 1000))
const CONFIRMATION_SCHEDULER_INTERVAL_MS = Math.max(250, Number(process.env.BSV_CONFIRMATION_SCHEDULER_INTERVAL_MS || 1000))
const CONFIRMATION_MAX_CONCURRENCY = Math.max(1, Number(process.env.BSV_CONFIRMATION_MAX_CONCURRENCY || 2))
const CONFIRMATION_MAX_PER_TICK = Math.max(1, Number(process.env.BSV_CONFIRMATION_MAX_PER_TICK || (WHATSONCHAIN_API_KEY ? 4 : 2)))
const CONFIRMATION_MAX_TRACKED_TXIDS = Math.max(1000, Number(process.env.BSV_CONFIRMATION_MAX_TRACKED_TXIDS || (WHATSONCHAIN_API_KEY ? 50000 : 15000)))
const CONFIRMATION_MAX_TRACK_MS = Math.max(CONFIRMATION_RETRY_BASE_DELAY_MS, Number(process.env.BSV_CONFIRMATION_MAX_TRACK_MS || 6 * 60 * 60 * 1000))
const HEAP_GUARD_ENABLED = process.env.BSV_HEAP_GUARD_ENABLED !== 'false'
const HEAP_GUARD_HIGH_WATERMARK = Math.min(0.98, Math.max(0.5, Number(process.env.BSV_HEAP_GUARD_HIGH_WATERMARK || 0.82)))
const HEAP_GUARD_PAUSE_MS = Math.max(5000, Number(process.env.BSV_HEAP_GUARD_PAUSE_MS || 30000))
const HEAP_GUARD_MAX_BYTES = Math.max(0, Number(process.env.BSV_HEAP_GUARD_MAX_BYTES || 0))

// Supabase client removed; we persist via Postgres repositories (tx_log)

// Wallet class for BSV operations
export class BSVWallet {
  private wif: string
  private address: string
  private network: string
  // Simple in-memory balance cache (per address)
  private static balanceCacheByAddress: Map<string, { value: number; ts: number }> = new Map()
  private static readonly BALANCE_TTL_MS: number = Number(process.env.BSV_BALANCE_TTL_MS || 300000) // 5 minutes

  constructor(wif?: string) {
    const useWif = wif || BSV_PRIVATE_KEY || BSV_FALLBACK_WIF
    if (!useWif) {
      throw new Error('No BSV private key configured')
    }
    
    this.wif = useWif
    // Derive address using @bsv/sdk
    const sdkKey = SDKPrivateKey.fromWif(this.wif)
    const pub = sdkKey.toPublicKey()
    // P2PKH base58 address (mainnet/testnet is inferred from config below)
    this.address = pub.toAddress().toString()

    // Assert network consistency between WIF/address and configured network
    try {
      const detected = (this.address && this.address.startsWith('1')) ? 'mainnet' : 'testnet'
      const configured = process.env.BSV_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
      this.network = configured
      if (detected !== configured) {
        console.warn(`⚠️ WIF network (${detected}) differs from BSV_NETWORK (${configured}). Proceeding with configured network.`)
      }
    } catch (e) {
      // If detection fails, continue; bsv lib differences may hide network meta
      this.network = process.env.BSV_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
    }
  }

  getAddress(): string {
    return this.address
  }

  async getBalance(): Promise<number> {
    try {
      // Return cached value if still fresh
      const cached = BSVWallet.balanceCacheByAddress.get(this.address)
      const now = Date.now()
      if (cached && (now - cached.ts) < BSVWallet.BALANCE_TTL_MS) {
        return cached.value
      }

      const headers: Record<string, string> = {}
      if (WHATSONCHAIN_API_KEY) {
        if (WHATSONCHAIN_API_KEY.startsWith('mainnet_') || WHATSONCHAIN_API_KEY.startsWith('testnet_')) {
          headers['Authorization'] = WHATSONCHAIN_API_KEY
        } else {
          headers['woc-api-key'] = WHATSONCHAIN_API_KEY
        }
      }

      // Add explicit timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)
      const response = await fetch(
        `https://api.whatsonchain.com/v1/bsv/${WOC_NETWORK}/address/${this.address}/balance`,
        { headers, signal: controller.signal }
      )
      clearTimeout(timeoutId)

      if (!response.ok) {
        // On rate limit or server issues, fall back to cached or 0 without noisy logs
        if (response.status === 429 || response.status >= 500) {
          if (cached && (now - cached.ts) < BSVWallet.BALANCE_TTL_MS) {
            return cached.value
          }
          return 0
        }
        throw new Error(`Failed to fetch balance: ${response.statusText}`)
      }

      const data = await response.json()
      const confirmedSats = (data && typeof data.confirmed === 'number') ? data.confirmed : 0
      // Return balance in BSV (float) for display, but use UTXOs for spend checks
      const balanceBsv = confirmedSats / 100000000
      BSVWallet.balanceCacheByAddress.set(this.address, { value: balanceBsv, ts: Date.now() })
      return balanceBsv
    } catch (error) {
      // Suppress noisy logs for expected throttling; only log unexpected errors in debug mode
      const msg = error instanceof Error ? error.message : String(error)
      const throttled = /Failed to fetch|timeout|Too Many Requests|AbortError/i.test(msg)
      if (!throttled && bsvConfig.logging.level === 'debug') {
        console.error('Error fetching wallet balance:', error)
      }
      // Use cached or 0 as safe fallback
      const cached = BSVWallet.balanceCacheByAddress.get(this.address)
      return cached ? cached.value : 0
    }
  }

  async getUTXOs(): Promise<any[]> {
    const walletIndex = getWalletIndexForAddress(this.address)
    if (walletIndex != null) {
      try {
        const spendSource = getSpendSourceForWallet(walletIndex)
        const outputs = await spendSource.listSpendable({
          topic: getTreasuryTopicForWallet(walletIndex),
          limit: SPEND_SOURCE_LIST_LIMIT,
          order: 'asc',
          minSatoshis: 0,
          excludeReserved: false,
          confirmedOnly: MIN_SPEND_CONF > 0,
          allowDegradedStale: true,
        })
        return outputs.map((output: SpendableOutput) => ({
          tx_hash: output.txid,
          tx_pos: output.vout,
          value: output.satoshis,
          confirmations: output.confirmed ? Math.max(1, MIN_SPEND_CONF || 1) : 0,
          height: output.confirmed ? 1 : undefined,
          script: output.outputScript || undefined,
          rawTx: output.rawTx || undefined,
          proof: output.proof || undefined,
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if ((process.env.BSV_SPEND_SOURCE_MODE || '').toLowerCase() === 'overlay') {
          if (bsvConfig.logging.level === 'debug') {
            console.warn(`⚠️ Overlay spend-source wallet lookup failed for ${this.address.substring(0, 10)}...: ${message}`)
          }
          return []
        }
        if (bsvConfig.logging.level === 'debug') {
          console.warn(`⚠️ Spend-source wallet lookup failed for ${this.address.substring(0, 10)}...; using legacy UTXO provider: ${message}`)
        }
      }
    }

    const { getUnspentForAddress } = await import('./utxo-provider')
    const utxos = await getUnspentForAddress(this.address)
    return Array.isArray(utxos) ? utxos : []
  }
}

// Blockchain service class
export class BlockchainService {
  private wallet: BSVWallet | null = null
  private transactionLog: TransactionLog[] = []
  private lastInitError: string | null = null
  private wifsForSend: string[] = []
  private rrIndex: number = 0
  private broadcastCountSinceLastSample = 0
  // Lightweight per-address UTXO cache to avoid hammering indexers
  private utxoCacheByAddress: Map<string, {
    fetchedAt: number
    utxos: any[]
    // key -> expiresAt (ms). We keep recently-used keys even across refreshes
    // so we don't re-spend an input while indexers are eventually consistent.
    usedKeys: Map<string, number>
    inFlight: Promise<void> | null
  }> = new Map()
  // Transaction status aggregation to reduce log noise and memory pressure
  private txStatusBatch: { confirmed: number; pending: number; notFound: number; retryLimitReached: number; skipped: number } =
    { confirmed: 0, pending: 0, notFound: 0, retryLimitReached: 0, skipped: 0 }
  private summaryIntervalId: NodeJS.Timeout | null = null
  private confirmationSchedulerId: NodeJS.Timeout | null = null
  private pendingConfirmationByTxid: Map<string, ConfirmationCheckState> = new Map()
  private pendingConfirmationHeap: ConfirmationCheckHeapItem[] = []
  private confirmationChecksInFlight = 0
  private operationalStats: { broadcastsOk: number; broadcastsFailed: number; utxoRefreshes: number; rawUtxosFetched: number; heapBackoffs: number } =
    { broadcastsOk: 0, broadcastsFailed: 0, utxoRefreshes: 0, rawUtxosFetched: 0, heapBackoffs: 0 }
  private operationalErrors: Map<string, number> = new Map()
  private heapBackoffUntilMs = 0
  private broadcastBackoffUntilByChannel: Map<'gorillapool_arc' | 'taal_arc' | 'whatsonchain', number> = new Map()
  private broadcastBackoffLogAtByChannel: Map<'gorillapool_arc' | 'taal_arc' | 'whatsonchain', number> = new Map()

  constructor() {
    try {
      if (BSV_PRIVATE_KEY || BSV_FALLBACK_WIF) {
        this.wallet = new BSVWallet(BSV_PRIVATE_KEY || BSV_FALLBACK_WIF)
        this.lastInitError = null
      } else {
        console.log('⚠️ No BSV private key configured, blockchain features disabled')
      }
      // Prepare round-robin wallet list
      try {
        const configured = (bsvConfig?.wallets?.privateKeys || []).filter(k => typeof k === 'string' && k.length > 0)
        // Ensure primary key appears first and unique
        const set = new Set<string>()
        const list: string[] = []
        const pushUnique = (k?: string) => { if (k && k.length > 0 && !set.has(k)) { set.add(k); list.push(k) } }
        pushUnique(BSV_PRIVATE_KEY)
        configured.forEach(k => pushUnique(k))
        this.wifsForSend = list
      } catch {}
      
      // Start interval-based operational summary logging
      this.startSummaryLogging()
      this.startConfirmationScheduler()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.lastInitError = msg
      console.error('Error initializing wallet:', msg)
    }
  }

  private ensureWallet(): void {
    if (!this.wallet && (BSV_PRIVATE_KEY || BSV_FALLBACK_WIF)) {
      try {
        this.wallet = new BSVWallet(BSV_PRIVATE_KEY || BSV_FALLBACK_WIF)
        this.lastInitError = null
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.lastInitError = msg
        console.error('Failed to lazily initialize wallet:', msg)
      }
    }
  }

  private startSummaryLogging(): void {
    this.summaryIntervalId = setInterval(() => {
      const tx = this.txStatusBatch
      const stats = this.operationalStats
      const totalErrors = Array.from(this.operationalErrors.values()).reduce((sum, n) => sum + n, 0)
      const heapMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024))
      const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024))

      console.log('📊 Blockchain 30m summary:')
      console.log(`   ✅ Broadcasts: ${stats.broadcastsOk} success, ${stats.broadcastsFailed} failed`)
      console.log(`   🧾 Confirmation checks: ${tx.confirmed} confirmed, ${tx.pending} pending, ${tx.notFound} not-found, ${tx.retryLimitReached} retry-limit, ${tx.skipped} skipped, ${this.pendingConfirmationByTxid.size} queued`)
      console.log(`   🔁 UTXO refresh: ${stats.utxoRefreshes} refreshes, ${stats.rawUtxosFetched} raw UTXO(s) fetched`)
      if (stats.heapBackoffs > 0) {
        console.log(`   🛑 Heap guard: ${stats.heapBackoffs} temporary backoff event(s)`)
      }
      console.log(`   🧠 Memory: heap=${heapMb} MB, rss=${rssMb} MB`)
      if (totalErrors > 0) {
        const topErrors = Array.from(this.operationalErrors.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, n]) => `${k}=${n}`)
          .join(', ')
        console.log(`   ⚠️  Errors: ${totalErrors} total (${topErrors})`)
      }

      this.txStatusBatch = { confirmed: 0, pending: 0, notFound: 0, retryLimitReached: 0, skipped: 0 }
      this.operationalStats = { broadcastsOk: 0, broadcastsFailed: 0, utxoRefreshes: 0, rawUtxosFetched: 0, heapBackoffs: 0 }
      this.operationalErrors.clear()
    }, LOG_SUMMARY_INTERVAL_MS)
  }

  private recordOperationalError(scope: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error)
    const safe = msg.replace(/\s+/g, ' ').trim().slice(0, 120)
    const key = `${scope}:${safe || 'unknown'}`
    this.operationalErrors.set(key, (this.operationalErrors.get(key) || 0) + 1)
  }

  private shouldTraceTimings(): boolean {
    return bsvConfig.logging.level === 'debug'
  }

  private compactLogValue(value: unknown, max = 120): string {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  }

  private shortenToken(value: string | null | undefined, keep = 12): string {
    const safe = String(value || '')
    if (!safe) return 'n/a'
    return safe.length > keep ? `${safe.substring(0, keep)}...` : safe
  }

  private logUtxoLookupTrace(input: {
    traceId?: string
    walletIndex?: number
    address: string
    source: string
    spendableCount: number
    durationMs: number
    note?: string
  }): void {
    if (!this.shouldTraceTimings() && input.durationMs < SLOW_UTXO_LOOKUP_MS) return

    const parts = [
      '⏱️ UTXO lookup',
      input.traceId ? `trace=${input.traceId}` : '',
      typeof input.walletIndex === 'number' ? `wallet=W${input.walletIndex + 1}` : '',
      `addr=${this.shortenToken(input.address, 14)}`,
      `source=${input.source}`,
      `spendable=${Math.max(0, input.spendableCount)}`,
      `total=${Math.round(input.durationMs)}ms`,
    ].filter(Boolean)

    if (input.note) {
      parts.push(`note=${this.compactLogValue(input.note, 160)}`)
    }

    console.log(parts.join(' '))
  }

  private logBroadcastStep(traceId: string | undefined, channel: string, phase: string, durationMs?: number, note?: string): void {
    if (!this.shouldTraceTimings()) return

    const parts = [
      '⏱️ broadcast',
      traceId ? `trace=${traceId}` : '',
      `channel=${channel}`,
      `phase=${phase}`,
    ].filter(Boolean)

    if (typeof durationMs === 'number') {
      parts.push(`ms=${Math.round(durationMs)}`)
    }
    if (note) {
      parts.push(`note=${this.compactLogValue(note, 160)}`)
    }

    console.log(parts.join(' '))
  }

  private logWriteToChainSummary(summary: WriteTraceSummary): void {
    const force = !!summary.error || summary.totalMs >= SLOW_WRITE_TO_CHAIN_MS
    if (!this.shouldTraceTimings() && !force) return

    const parts = [
      `⏱️ writeToChain ${summary.error ? 'failed' : 'ok'}`,
      `trace=${summary.traceId}`,
      `stream=${summary.stream}`,
      `total=${Math.round(summary.totalMs)}ms`,
    ]

    if (typeof summary.walletIndex === 'number') parts.push(`wallet=W${summary.walletIndex + 1}`)
    if (summary.address) parts.push(`addr=${this.shortenToken(summary.address, 14)}`)
    if (typeof summary.spendableCount === 'number') parts.push(`spendable=${summary.spendableCount}`)
    if (typeof summary.walletLookupMs === 'number') parts.push(`walletPick=${Math.round(summary.walletLookupMs)}ms`)
    if (typeof summary.txBuildMs === 'number') parts.push(`txBuild=${Math.round(summary.txBuildMs)}ms`)
    if (typeof summary.broadcastMs === 'number') parts.push(`broadcast=${Math.round(summary.broadcastMs)}ms`)
    if (typeof summary.txLogMs === 'number') parts.push(`txLog=${Math.round(summary.txLogMs)}ms`)
    if (summary.acceptedVia) parts.push(`acceptedVia=${summary.acceptedVia}`)
    if (summary.txid) parts.push(`txid=${this.shortenToken(summary.txid, 12)}`)
    if (summary.error) parts.push(`error=${this.compactLogValue(summary.error, 180)}`)

    const logger = summary.error ? console.warn : console.log
    logger(parts.join(' '))
  }

  private detectBroadcastChannel(message: string): string {
    const safe = String(message || '').toUpperCase()
    if (safe.includes('GORILLAPOOL')) return 'gorillapool_arc'
    if (safe.includes('TAAL')) return 'taal_arc'
    if (safe.includes('WHATSONCHAIN') || safe.includes('WOC')) return 'whatsonchain'
    return 'unknown'
  }

  private isBroadcastChannelBackedOff(channel: 'gorillapool_arc' | 'taal_arc' | 'whatsonchain'): boolean {
    const until = this.broadcastBackoffUntilByChannel.get(channel) || 0
    if (until <= Date.now()) {
      this.broadcastBackoffUntilByChannel.delete(channel)
      return false
    }
    return true
  }

  private clearBroadcastChannelBackoff(channel: 'gorillapool_arc' | 'taal_arc' | 'whatsonchain'): void {
    this.broadcastBackoffUntilByChannel.delete(channel)
  }

  private noteBroadcastChannelBackoff(
    channel: 'gorillapool_arc' | 'taal_arc' | 'whatsonchain',
    durationMs: number,
    reason: string,
  ): void {
    const until = Date.now() + Math.max(1000, durationMs)
    this.broadcastBackoffUntilByChannel.set(channel, until)
    const lastLog = this.broadcastBackoffLogAtByChannel.get(channel) || 0
    if ((Date.now() - lastLog) > 15000) {
      const label = channel === 'gorillapool_arc' ? 'GorillaPool ARC' : channel === 'taal_arc' ? 'TAAL ARC' : 'WoC'
      console.warn(`⏸️  ${label} backoff for ${Math.round(durationMs / 1000)}s: ${reason}`)
      this.broadcastBackoffLogAtByChannel.set(channel, Date.now())
    }
  }

  private buildWhatsOnChainHeaders(includeJsonContentType: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {}
    if (includeJsonContentType) headers['Content-Type'] = 'application/json'
    if (WHATSONCHAIN_API_KEY) {
      if (WHATSONCHAIN_API_KEY.startsWith('mainnet_') || WHATSONCHAIN_API_KEY.startsWith('testnet_')) {
        headers['Authorization'] = WHATSONCHAIN_API_KEY
      } else {
        headers['woc-api-key'] = WHATSONCHAIN_API_KEY
      }
    }
    return headers
  }

  private jitterDelay(delayMs: number): number {
    const spread = delayMs * 0.2
    return Math.max(1000, Math.round(delayMs + ((Math.random() * 2 - 1) * spread)))
  }

  private calculateConfirmationRetryDelay(attempts: number, kind: 'pending' | 'not-found' | 'error'): number {
    const baseDelay = kind === 'error' ? CONFIRMATION_ERROR_DELAY_MS : CONFIRMATION_RETRY_BASE_DELAY_MS
    const exponent = Math.max(0, attempts - 1)
    return Math.min(CONFIRMATION_MAX_RETRY_DELAY_MS, baseDelay * Math.pow(2, exponent))
  }

  private startConfirmationScheduler(): void {
    if (this.confirmationSchedulerId) return
    this.confirmationSchedulerId = setInterval(() => {
      this.processConfirmationChecks().catch((error) => this.recordOperationalError('confirmation-scheduler', error))
    }, CONFIRMATION_SCHEDULER_INTERVAL_MS)
  }

  private enqueueConfirmationCheck(txid: string, streamType: string): void {
    const existing = this.pendingConfirmationByTxid.get(txid)
    if (!existing && this.pendingConfirmationByTxid.size >= CONFIRMATION_MAX_TRACKED_TXIDS) {
      this.txStatusBatch.skipped += 1
      this.recordOperationalError('confirmation-check', 'queue-capacity-reached')
      return
    }

    const next: ConfirmationCheckState = {
      txid,
      streamType,
      attempts: existing?.attempts || 0,
      nextCheckAt: Date.now() + this.jitterDelay(CONFIRMATION_INITIAL_DELAY_MS),
      generation: (existing?.generation || 0) + 1,
      firstScheduledAt: existing?.firstScheduledAt || Date.now(),
    }
    this.pendingConfirmationByTxid.set(txid, next)
    this.pushPendingConfirmation(next)
  }

  private rescheduleConfirmationCheck(state: ConfirmationCheckState, attempts: number, kind: 'pending' | 'not-found' | 'error'): void {
    const next: ConfirmationCheckState = {
      txid: state.txid,
      streamType: state.streamType,
      attempts,
      nextCheckAt: Date.now() + this.jitterDelay(this.calculateConfirmationRetryDelay(attempts, kind)),
      generation: state.generation + 1,
      firstScheduledAt: state.firstScheduledAt,
    }
    this.pendingConfirmationByTxid.set(state.txid, next)
    this.pushPendingConfirmation(next)
  }

  private pushPendingConfirmation(state: ConfirmationCheckState): void {
    const heapItem: ConfirmationCheckHeapItem = {
      txid: state.txid,
      nextCheckAt: state.nextCheckAt,
      generation: state.generation,
    }
    this.pendingConfirmationHeap.push(heapItem)
    let idx = this.pendingConfirmationHeap.length - 1
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2)
      if (this.pendingConfirmationHeap[parent].nextCheckAt <= this.pendingConfirmationHeap[idx].nextCheckAt) break
      const tmp = this.pendingConfirmationHeap[parent]
      this.pendingConfirmationHeap[parent] = this.pendingConfirmationHeap[idx]
      this.pendingConfirmationHeap[idx] = tmp
      idx = parent
    }
  }

  private peekPendingConfirmation(): ConfirmationCheckHeapItem | null {
    return this.pendingConfirmationHeap.length > 0 ? this.pendingConfirmationHeap[0] : null
  }

  private popPendingConfirmation(): ConfirmationCheckHeapItem | null {
    if (this.pendingConfirmationHeap.length === 0) return null
    const first = this.pendingConfirmationHeap[0]
    const last = this.pendingConfirmationHeap.pop()!
    if (this.pendingConfirmationHeap.length > 0) {
      this.pendingConfirmationHeap[0] = last
      let idx = 0
      while (true) {
        const left = idx * 2 + 1
        const right = idx * 2 + 2
        let smallest = idx
        if (left < this.pendingConfirmationHeap.length && this.pendingConfirmationHeap[left].nextCheckAt < this.pendingConfirmationHeap[smallest].nextCheckAt) {
          smallest = left
        }
        if (right < this.pendingConfirmationHeap.length && this.pendingConfirmationHeap[right].nextCheckAt < this.pendingConfirmationHeap[smallest].nextCheckAt) {
          smallest = right
        }
        if (smallest === idx) break
        const tmp = this.pendingConfirmationHeap[idx]
        this.pendingConfirmationHeap[idx] = this.pendingConfirmationHeap[smallest]
        this.pendingConfirmationHeap[smallest] = tmp
        idx = smallest
      }
    }
    return first
  }

  private async processConfirmationChecks(): Promise<void> {
    if (this.confirmationChecksInFlight >= CONFIRMATION_MAX_CONCURRENCY) return
    if (this.isBroadcastChannelBackedOff('whatsonchain')) return

    let launched = 0
    while (launched < CONFIRMATION_MAX_PER_TICK && this.confirmationChecksInFlight < CONFIRMATION_MAX_CONCURRENCY) {
      const next = this.peekPendingConfirmation()
      if (!next || next.nextCheckAt > Date.now()) break

      const item = this.popPendingConfirmation()
      if (!item) break

      const state = this.pendingConfirmationByTxid.get(item.txid)
      if (!state || state.generation !== item.generation) continue

      this.confirmationChecksInFlight += 1
      launched += 1
      void this.runConfirmationCheck(state).finally(() => {
        this.confirmationChecksInFlight = Math.max(0, this.confirmationChecksInFlight - 1)
      })
    }
  }

  private async runConfirmationCheck(state: ConfirmationCheckState): Promise<void> {
    const current = this.pendingConfirmationByTxid.get(state.txid)
    if (!current || current.generation !== state.generation) return

    if (current.attempts >= MAX_CONFIRMATION_CHECK_ATTEMPTS || (Date.now() - current.firstScheduledAt) >= CONFIRMATION_MAX_TRACK_MS) {
      this.txStatusBatch.retryLimitReached += 1
      const reason = current.attempts >= MAX_CONFIRMATION_CHECK_ATTEMPTS ? 'max-attempts-reached' : 'max-track-age-reached'
      this.recordOperationalError('confirmation-check', reason)
      this.pendingConfirmationByTxid.delete(current.txid)

      void this.cleanUpFailedTx(current.txid, current.streamType, reason)
      return
    }

    const attemptNumber = current.attempts + 1
    const network = WOC_NETWORK
    const wocUrl = `https://api.whatsonchain.com/v1/bsv/${network}/tx/${current.txid}`
    const headers = this.buildWhatsOnChainHeaders()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    try {
      const response = await fetch(wocUrl, { headers, signal: controller.signal })
      if (response.ok) {
        const txData = await response.json()
        const confirmations = txData.confirmations || 0

        if (confirmations > 0) {
          await upsertTxLog({
            txid: current.txid,
            type: current.streamType,
            provider: 'auto-confirmed',
            collected_at: new Date(),
            status: 'confirmed',
            onchain_at: new Date(),
            fee_sats: null,
            wallet_index: null,
            retries: null,
            error: null,
          })
          throughputObservability.recordConfirmed(current.txid, { family: current.streamType })
          this.txStatusBatch.confirmed += 1
          this.pendingConfirmationByTxid.delete(current.txid)
        } else {
          this.txStatusBatch.pending += 1
          this.rescheduleConfirmationCheck(current, attemptNumber, 'pending')
        }
        return
      }

      if (response.status === 404) {
        this.txStatusBatch.notFound += 1
        this.rescheduleConfirmationCheck(current, attemptNumber, 'not-found')
        return
      }

      if (response.status === 429) {
        this.noteBroadcastChannelBackoff('whatsonchain', WHATSONCHAIN_API_KEY ? 60000 : 120000, 'confirmation HTTP 429')
      } else if (response.status >= 500) {
        this.noteBroadcastChannelBackoff('whatsonchain', 30000, `confirmation HTTP ${response.status}`)
      }
      this.recordOperationalError('confirmation-check', `HTTP ${response.status}`)
      this.rescheduleConfirmationCheck(current, attemptNumber, 'error')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|ABORT|NETWORK|TIMED OUT/i.test(message.toUpperCase())) {
        this.noteBroadcastChannelBackoff('whatsonchain', 30000, `confirmation ${message}`)
      }
      this.recordOperationalError('confirmation-check', error)
      this.rescheduleConfirmationCheck(current, attemptNumber, 'error')
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async cleanUpFailedTx(txid: string, streamType: string, reason: string): Promise<void> {
    try {
      await upsertTxLog({
        txid,
        type: streamType,
        provider: 'confirmation-failed',
        collected_at: new Date(),
        status: 'failed',
        onchain_at: null,
        fee_sats: null,
        wallet_index: null,
        retries: null,
        error: reason,
      })
    } catch {}
    try {
      const removed = await removeUnconfirmedReading(txid)
      if (removed) {
        console.log(`🗑️ Removed stale unconfirmed reading: ${txid.substring(0, 12)}... (${reason})`)
      }
    } catch {}

    const logEntry = this.transactionLog.find((l) => l.txid === txid)
    if (logEntry) logEntry.status = 'failed'
  }

  private appendTransactionLog(entry: TransactionLog): void {
    this.transactionLog.push(entry)
    if (this.transactionLog.length > MAX_IN_MEMORY_TX_LOG) {
      const overflow = this.transactionLog.length - MAX_IN_MEMORY_TX_LOG
      this.transactionLog.splice(0, overflow)
    }
  }

  private compactPayloadForLog(payload: unknown): any {
    try {
      const text = JSON.stringify(payload)
      if (!text) return payload
      if (text.length <= 2048) return payload
      return {
        _truncated: true,
        bytes: Buffer.byteLength(text, 'utf8'),
        preview: text.slice(0, 512),
      }
    } catch {
      return { _truncated: true, reason: 'unserializable-payload' }
    }
  }

  private enforceHeapGuard(): void {
    if (!HEAP_GUARD_ENABLED) return
    const now = Date.now()
    if (now < this.heapBackoffUntilMs) {
      const waitMs = this.heapBackoffUntilMs - now
      throw new Error(`HEAP_PRESSURE_BACKOFF:${waitMs}`)
    }

    const heapUsed = process.memoryUsage().heapUsed
    const heapLimit = v8.getHeapStatistics().heap_size_limit || 0
    const overWatermark = heapLimit > 0 && (heapUsed / heapLimit) >= HEAP_GUARD_HIGH_WATERMARK
    const overAbsoluteCap = HEAP_GUARD_MAX_BYTES > 0 && heapUsed >= HEAP_GUARD_MAX_BYTES
    if (!overWatermark && !overAbsoluteCap) return

    this.heapBackoffUntilMs = now + HEAP_GUARD_PAUSE_MS
    this.operationalStats.heapBackoffs += 1
    this.recordOperationalError('heap-guard', `heapUsed=${heapUsed};heapLimit=${heapLimit}`)
    throw new Error('HEAP_PRESSURE_BACKOFF')
  }

  private walletEmptyUntil: Map<number, number> = new Map()
  private static readonly WALLET_EMPTY_CACHE_MS = 60_000

  private toEmergencyInventoryUtxo(walletIndex: number, raw: any): InventoryUtxo | null {
    const txid = String(raw?.tx_hash || raw?.txid || raw?.hash || '')
    const vout = Number(raw?.tx_pos ?? raw?.vout ?? 0)
    const satoshis = Number(raw?.value ?? raw?.satoshis ?? 0)
    if (!txid || !Number.isFinite(vout) || !Number.isFinite(satoshis) || satoshis < 0) return null

    const outputScript = String(raw?.script || raw?.outputScript || raw?.lockingScript || '')
    const confirmations = Number(raw?.confirmations || 0)
    const height = typeof raw?.height === 'number' ? raw.height : 0
    const confirmed = confirmations > 0 || height > 0

    return {
      topic: getTreasuryTopicForWallet(walletIndex),
      txid,
      vout: Math.floor(vout),
      satoshis: Math.floor(satoshis),
      output_script: outputScript,
      raw_tx: typeof raw?.rawTx === 'string' ? raw.rawTx : '',
      beef: null,
      admitted_at: new Date().toISOString(),
      confirmed,
      removed: false,
      removed_at: null,
      spending_txid: null,
      wallet_index: walletIndex,
      utxo_role: 'pool',
      locked: false,
      locked_by: null,
      locked_at: null,
    }
  }

  private async notifyEmergencyUtxoManager(input: {
    address: string
    walletIndex: number
    topic: string
    spentTxid: string
    spentVout: number
    spendingTxid: string
    change: { vout: number; satoshis: number; outputScript: string; confirmed?: boolean } | null
  }): Promise<void> {
    if (!EMERGENCY_UTXO_MANAGER_URL) return

    const base = EMERGENCY_UTXO_MANAGER_URL.replace(/\/+$/, '')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), EMERGENCY_UTXO_MANAGER_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (EMERGENCY_UTXO_MANAGER_SECRET) {
        headers['x-gaialog-utxo-manager-secret'] = EMERGENCY_UTXO_MANAGER_SECRET
      }

      const response = await fetch(`${base}/consume-admit`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status} ${body || response.statusText}`.trim())
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`⚠️ Emergency UTXO manager sync failed for ${input.spendingTxid.substring(0, 12)}...: ${message}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async getFirstWalletWithSpendableUtxos(
    minSatoshis: number,
    traceId?: string,
  ): Promise<{ wif: string; index: number; address: string; utxo: InventoryUtxo; inventoryBacked: boolean } | null> {
    const list = this.wifsForSend && this.wifsForSend.length > 0
      ? this.wifsForSend
      : (BSV_PRIVATE_KEY ? [BSV_PRIVATE_KEY] : (BSV_FALLBACK_WIF ? [BSV_FALLBACK_WIF] : []))
    if (list.length === 0) return null

    let isBackedOff: ((addr: string) => boolean) | null = null
    try {
      const mod = await import('./utxo-maintainer')
      isBackedOff = mod.isWalletBackedOff
    } catch {}

    const pickByConfirmedFirst = process.env.BSV_WALLET_PICK_BY_CONFIRMED_FIRST !== 'false'
    const confirmedPasses = pickByConfirmedFirst && MIN_SPEND_CONF <= 0 ? [true, false] : [MIN_SPEND_CONF > 0]

    if (EMERGENCY_LEGACY_UTXO_MODE) {
      for (const confirmedOnly of confirmedPasses) {
        const now = Date.now()
        for (let i = 0; i < list.length; i++) {
          const pick = (this.rrIndex + i) % list.length
          const wif = list[pick]
          try {
            const sdkKey = SDKPrivateKey.fromWif(wif)
            const addr = sdkKey.toPublicKey().toAddress().toString()

            if (isBackedOff && isBackedOff(addr)) continue

            const emptyUntil = this.walletEmptyUntil.get(pick) || 0
            if (emptyUntil > now) continue

            const startedAt = Date.now()
            const spendables = await this.getSpendableUtxos(addr, wif, pick, traceId, minSatoshis)
            const candidate = spendables
              .filter((row: any) => Number(row?.value ?? row?.satoshis ?? 0) >= minSatoshis)
              .sort((left: any, right: any) => {
                const l = Number(left?.value ?? left?.satoshis ?? 0)
                const r = Number(right?.value ?? right?.satoshis ?? 0)
                return l - r
              })[0]

            if (candidate) {
              const synthetic = this.toEmergencyInventoryUtxo(pick, candidate)
              if (!synthetic) continue
              const utxoKey = `${synthetic.txid}:${synthetic.vout}`
              this.markUtxosUsed([utxoKey])

              this.walletEmptyUntil.delete(pick)
              this.rrIndex = (pick + 1) % list.length
              this.logUtxoLookupTrace({
                traceId,
                walletIndex: pick,
                address: addr,
                source: 'legacy-emergency',
                spendableCount: spendables.length,
                durationMs: Date.now() - startedAt,
                note: `minSats=${minSatoshis};confirmedOnly=${confirmedOnly};dbBypass=true`,
              })
              return { wif, index: pick, address: addr, utxo: synthetic, inventoryBacked: false }
            }

            if (!confirmedOnly || confirmedPasses.length === 1) {
              this.walletEmptyUntil.set(pick, now + BlockchainService.WALLET_EMPTY_CACHE_MS)
            }
          } catch (error) {
            const addr = (() => {
              try {
                return SDKPrivateKey.fromWif(wif).toPublicKey().toAddress().toString()
              } catch {
                return ''
              }
            })()
            if (addr) {
              this.logUtxoLookupTrace({
                traceId,
                walletIndex: pick,
                address: addr,
                source: 'legacy-emergency-error',
                spendableCount: 0,
                durationMs: 0,
                note: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
      }
      return null
    }

    for (const confirmedOnly of confirmedPasses) {
      const now = Date.now()
      for (let i = 0; i < list.length; i++) {
        const pick = (this.rrIndex + i) % list.length
        const wif = list[pick]
        try {
          const sdkKey = SDKPrivateKey.fromWif(wif)
          const addr = sdkKey.toPublicKey().toAddress().toString()

          if (isBackedOff && isBackedOff(addr)) continue

          const emptyUntil = this.walletEmptyUntil.get(pick) || 0
          if (emptyUntil > now) continue

          const startedAt = Date.now()
          const acquired = await acquirePoolUtxo({
            walletIndex: pick,
            minSatoshis,
            confirmedOnly,
          })

          if (acquired) {
            this.walletEmptyUntil.delete(pick)
            this.rrIndex = (pick + 1) % list.length
            this.logUtxoLookupTrace({
              traceId,
              walletIndex: pick,
              address: addr,
              source: 'inventory',
              spendableCount: 1,
              durationMs: Date.now() - startedAt,
              note: `minSats=${minSatoshis};confirmedOnly=${confirmedOnly}`,
            })
            return { wif, index: pick, address: addr, utxo: acquired, inventoryBacked: true }
          }

          if (!confirmedOnly || confirmedPasses.length === 1) {
            this.walletEmptyUntil.set(pick, now + BlockchainService.WALLET_EMPTY_CACHE_MS)
          }
        } catch (error) {
          const addr = (() => {
            try {
              return SDKPrivateKey.fromWif(wif).toPublicKey().toAddress().toString()
            } catch {
              return ''
            }
          })()
          if (addr) {
            this.logUtxoLookupTrace({
              traceId,
              walletIndex: pick,
              address: addr,
              source: 'inventory-error',
              spendableCount: 0,
              durationMs: 0,
              note: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
    }

    return null
  }

  public getAddress(): string | null {
    this.ensureWallet()
    return this.wallet ? this.wallet.getAddress() : null
  }

  public getLastError(): string | null {
    return this.lastInitError
  }

  private getNextWalletWif(): { wif: string; index: number } {
    const list = this.wifsForSend && this.wifsForSend.length > 0 ? this.wifsForSend : (BSV_PRIVATE_KEY ? [BSV_PRIVATE_KEY] : (BSV_FALLBACK_WIF ? [BSV_FALLBACK_WIF] : []))
    if (list.length === 0) return { wif: '', index: 0 }
    const pick = this.rrIndex % list.length
    this.rrIndex = (this.rrIndex + 1) % list.length
    return { wif: list[pick], index: pick }
  }

  async checkBalance(): Promise<number> {
    try {
      this.ensureWallet()
      if (!this.wallet) {
        console.log('⚠️ Wallet not configured, returning 0 balance')
        return 0
      }
      
      const balance = await this.wallet.getBalance()
      
      if (balance < 0.001) {
        console.warn(`⚠️  Low wallet balance: ${balance} BSV. Consider funding the wallet.`)
      }
      
      return balance
    } catch (error) {
      console.error('Error checking balance:', error)
      return 0
    }
  }

  async writeToChain(data: BlockchainData): Promise<string> {
    const traceId = typeof data.traceId === 'string' && data.traceId.trim().length > 0
      ? data.traceId.trim()
      : `${data.stream}:${Date.now().toString(36)}`
    const writeStartedAt = Date.now()
    let walletLookupMs: number | undefined
    let txBuildMs: number | undefined
    let broadcastMs: number | undefined
    let txLogMs: number | undefined
    let selectedWalletIndex: number | undefined
    let selectedWalletAddress = ''
    let selectedSpendableCount: number | undefined
    let acceptedVia: string | undefined
    let acceptedTxid: string | undefined
    let fromAddress = '' // hoisted so outer catch can signal per-wallet backoff
    try {
      if (this.shouldTraceTimings()) {
        console.log(`⏱️ writeToChain start trace=${traceId} stream=${data.stream}`)
      }
      // Check if blockchain is configured
      if (!BSV_PRIVATE_KEY && !BSV_FALLBACK_WIF) {
        console.warn('⚠️ Blockchain private key not configured, skipping write to chain')
        return 'blockchain-not-configured'
      }
      this.enforceHeapGuard()

      // Create OP_RETURN data with top-level metadata
      const sanitizedPayload = (() => {
        try {
          const copy = { ...(data as any)?.payload }
          if (copy && typeof copy === 'object') {
            delete (copy as any).attribution
            delete (copy as any).notice
            delete (copy as any).source
            // Remove database-related references to reduce payload size
            delete (copy as any).source_hash
            delete (copy as any).db_source_hash
            // Strip provider_id/dataset_id from payload; they are promoted to root level
            delete (copy as any).provider_id
            delete (copy as any).dataset_id
          }
          return copy
        } catch {
          return data.payload
        }
      })()

      // Rename WAQI-style fields for clarity on-chain
      let payloadOut: any = sanitizedPayload
      try {
        if (data.stream === 'air_quality' && sanitizedPayload && typeof sanitizedPayload === 'object') {
          const p: any = sanitizedPayload
          payloadOut = {
            location: p.location,
            timestamp: p.timestamp,
            air_quality_index: p.aqi,
            fine_particulate_matter_pm25: p.pm25,
            coarse_particulate_matter_pm10: p.pm10,
            carbon_monoxide: p.co,
            nitrogen_dioxide: p.no2,
            ozone: p.o3,
          }
        }
      } catch {}

      // Include ASCII-transliterated location for explorers that mis-decode UTF-8
      let payloadWithAscii = payloadOut
      try {
        const { toAsciiSafe } = await import('./utils')
        if (payloadOut && typeof payloadOut === 'object' && (payloadOut as any).location) {
          const ascii = toAsciiSafe(String((payloadOut as any).location))
          if (ascii) payloadWithAscii = { ...(payloadOut as any), location_ascii: ascii }
        }
      } catch {}

      const rawProviderValue = (data as any)?.payload?.source || null
      const providerIdValue = (data as any)?.providerId || (data as any)?.payload?.provider_id || resolveProviderIdFromSource(rawProviderValue) || undefined
      const datasetIdValue = (data as any)?.datasetId || (data as any)?.payload?.dataset_id || undefined
      const providerValue = resolveSourceLabel(providerIdValue, datasetIdValue, rawProviderValue)
      const queueLaneValue = (data as any)?.queueLane === 'throughput' || (data as any)?.queueLane === 'coverage'
        ? (data as any).queueLane
        : undefined
      
      // Build credibility metadata if enabled
      let credibilityMeta: CredibilityMetadata | undefined
      if (ENABLE_CREDIBILITY) {
        try {
          const credBuilder = createCredibilityBuilder(
            (data as any)?.payload?.timestamp || new Date().toISOString()
          )
          
          // Record fetch stage
          credBuilder.recordFetch(providerValue, data.payload)
          
          // Validate the data
          const validationResult = dataValidator.validate(data.stream, data.payload || {})
          credBuilder.recordValidation(data.payload, validationResult)
          
          // If validation required and failed, log warning
          if (REQUIRE_VALIDATION && !validationResult.valid) {
            console.warn(`⚠️ Data validation failed for ${data.stream}:`, validationResult.errors)
            // Still proceed but mark as failed validation
          }
          
          // Calculate quality score
          const qualityScore = qualityScorer.calculateScore(
            data.payload || {},
            validationResult,
            providerValue
          )
          credBuilder.recordQualityScore(validationResult, qualityScore)
          
          // Record transformation stage
          credBuilder.recordTransformation(data.payload, payloadWithAscii, 'payload_sanitisation')
          
          // Build final metadata
          credibilityMeta = credBuilder.build()
        } catch (credErr) {
          console.warn('⚠️ Credibility metadata generation failed:', credErr)
        }
      }
      
      const base: any = {
        app: APP_NAME,
        schema_version: SCHEMA_VERSION,
        data_type: data.stream,
        timestamp: data.timestamp,
        payload: payloadWithAscii,
      }
      if (providerIdValue) base.provider_id = providerIdValue
      if (datasetIdValue) base.dataset_id = datasetIdValue
      if (providerValue !== 'unknown') {
        base.provider = providerValue
      }
      // Add credibility metadata if generated
      if (credibilityMeta) {
        base._credibility = credibilityMeta
      }
      const opReturnData = JSON.stringify(base)

      // Build payload bytes (optionally gzip) and optional extra pushes
      const includeHashPush = process.env.BSV_OPRETURN_INCLUDE_HASH_PUSH === 'true'
      const useGzip = process.env.BSV_OPRETURN_GZIP === 'true'
      const useTrueReturn = process.env.BSV_OPRETURN_TRUE_RETURN === 'true'
      const { buildOpFalseOpReturnWithTag } = await import('./opreturn')
      const extras: (Buffer | string)[] = []
      let payloadBytes: Buffer = Buffer.from(opReturnData, 'utf8')
      try {
        if (useGzip) {
          const { gzipSync } = await import('zlib')
          payloadBytes = Buffer.from(gzipSync(payloadBytes))
        }
      } catch {}
      // Compute SHA-256 over the embedded bytes (compressed if enabled)
      try {
        const { createHash } = await import('crypto')
        const h = createHash('sha256').update(payloadBytes).digest('hex')
        if (includeHashPush) {
          extras.push(Buffer.from(h, 'hex'))
        }
      } catch {}
      if (useGzip) {
        extras.push('encoding=gzip')
      }
      // Create OP_RETURN with Tag + Version + payload (+ optional extras)
      const scriptHex = buildOpFalseOpReturnWithTag({
        tag: 'GaiaLog',
        version: 'v1',
        payload: payloadBytes,
        extra: extras,
        useTrueReturn,
      })
      const opReturnScript = (bsv as any).Script.fromHex(scriptHex)
      const opReturnBytes = scriptHex.length / 2
      const opReturnOutputSats = useTrueReturn ? 1 : 0
      // Deterministic size constants. We always emit a P2PKH change output (BSV has no
      // dust limit), so the change-output bytes are always present.
      const BASE_WITH_CHANGE = 44 // version (4) + locktime (4) + in-count varint (1) + out-count varint (1) + P2PKH change output (34)
      const INPUT_SIGNED = 149 // worst-case signed P2PKH input (32 txid + 4 vout + 1 scriptLen + ~108 sig+pubkey + 4 sequence). 149 absorbs high-S signature variance.

      const estimateExplicitFee = (inputCount: number, feeMultiplier: number): { estimatedSize: number; explicitFee: number } => {
        const opReturnOutputEnvelope = 8 + (opReturnBytes < 253 ? 1 : 3)
        const estimatedSize = BASE_WITH_CHANGE + inputCount * INPUT_SIGNED + opReturnOutputEnvelope + opReturnBytes
        const explicitFee = Math.ceil(estimatedSize * FEE_RATE_SAT_PER_BYTE * feeMultiplier)
        return { estimatedSize, explicitFee }
      }
      const { explicitFee: singleInputExplicitFee } = estimateExplicitFee(1, 1)
      // 1.2x safety multiplier on the per-tx minimum stops the acquire layer from handing us
      // a UTXO so close to threshold that signature variance pushes us under ARC's floor.
      const minInputSatoshis = Math.max(
        UTXO_POOL_MIN_SATS,
        Math.ceil((opReturnOutputSats + singleInputExplicitFee + DUST_LIMIT) * 1.2),
      )

      const walletLookupStartedAt = Date.now()
      const picked = await this.getFirstWalletWithSpendableUtxos(minInputSatoshis, traceId)
      walletLookupMs = Date.now() - walletLookupStartedAt
      if (!picked) {
        const modeLabel = EMERGENCY_LEGACY_UTXO_MODE ? 'emergency spendable' : 'inventory'
        throw new Error(`No ${modeLabel} UTXOs available across wallets for minSats=${minInputSatoshis}`)
      }

      const { wif, index: walletIndexForLog, address, utxo: acquiredUtxo, inventoryBacked } = picked
      const acquiredUtxoKey = `${acquiredUtxo.txid}:${acquiredUtxo.vout}`
      selectedWalletIndex = walletIndexForLog
      selectedWalletAddress = address
      selectedSpendableCount = 1
      fromAddress = address

      const scriptPubKey = acquiredUtxo.output_script || (
        (bsv.Script as any).fromAddress
          ? (bsv.Script as any).fromAddress(address).toHex()
          : this.p2pkhLockingScriptHexFromWif(wif)
      )
      const bitcoreUtxos = [{
        txId: acquiredUtxo.txid,
        outputIndex: acquiredUtxo.vout,
        address,
        script: scriptPubKey,
        satoshis: Number(acquiredUtxo.satoshis),
      }]

      // Create transaction using explicit fee. bsv's feePerKb uses _estimateSize()
      // which runs BEFORE signing — input scriptSigs grow from ~40 to ~149 bytes,
      // so the library underestimates size and we end up with ~22 sat/kB instead of 102.5.
      // We estimate size ourselves: signed P2PKH input=149 bytes, op_return known.
      // BSV has no dust limit (unlike BTC's 546), so we ALWAYS emit a change output
      // and pay exactly explicitFee — fee becomes deterministic and clears ARC's policy
      // floor (~100 sat/kB) every time at our 102.5 sat/kB rate.
      const buildSignedTransaction = (feeMultiplier: number): {
        serialized: string
        changeOutput: { vout: number; satoshis: number; outputScript: string } | null
      } => {
        const numInputs = bitcoreUtxos.length
        const { explicitFee } = estimateExplicitFee(numInputs, feeMultiplier)
        const inputSats = bitcoreUtxos.reduce((s: number, u: any) => s + (u.satoshis || 0), 0)
        const availableForFee = inputSats - opReturnOutputSats
        if (availableForFee < explicitFee + DUST_LIMIT) {
          throw new Error(`Selected inputs do not cover explicit fee + 1 sat change: input=${inputSats} explicitFee=${explicitFee} (need at least ${explicitFee + opReturnOutputSats + DUST_LIMIT})`)
        }
        // BSV has no dust limit; always emit a change output so fee = explicitFee deterministically.
        const tx = new (bsv as any).Transaction()
          .from(bitcoreUtxos)
          .addOutput(new bsv.Transaction.Output({
            script: opReturnScript,
            satoshis: opReturnOutputSats,
          }))
          .fee(explicitFee)
          .change(address)
        const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
        tx.sign(signingKey)
        const serialized = tx.serialize()
        const outputSats = tx.outputs.reduce((s: number, o: any) => s + (o.satoshis || o._satoshis || 0), 0)
        const actualFee = inputSats - outputSats
        const txSizeBytes = serialized.length / 2
        if (actualFee < 2) {
          console.warn(`⚠️  TX fee sanity check: fee=${actualFee} sats, explicitFee=${explicitFee}, txSize=${txSizeBytes} bytes, input=${inputSats}`)
        }
        const changeOutput = tx.outputs
          .map((output: any, vout: number) => {
            let outputScript = ''
            try {
              outputScript = typeof output?.script?.toHex === 'function'
                ? output.script.toHex()
                : String(output?.script || '')
            } catch {}
            return {
              vout,
              satoshis: Number(output?.satoshis || output?._satoshis || 0),
              outputScript,
            }
          })
          .find((output: { satoshis: number; outputScript: string }) =>
            output.satoshis > 0 && output.outputScript.toLowerCase() !== scriptHex.toLowerCase()
          ) || null
        return { serialized, changeOutput }
      }

      // Build prevouts for ARC Extended Format (order must match inputs)
      const p2pkhScriptDefault = this.p2pkhLockingScriptHexFromWif(wif)
      const prevoutsForArc = Array.isArray(bitcoreUtxos) ? bitcoreUtxos.map((u: any) => {
        const sats = Number(u?.satoshis ?? u?.value ?? 0)
        let scriptHex = ''
        try {
          const sc: any = u?.script
          if (typeof sc === 'string') scriptHex = sc
          else if (sc && typeof sc.toHex === 'function') scriptHex = sc.toHex()
        } catch {}
        if (!scriptHex) scriptHex = p2pkhScriptDefault
        return { lockingScript: scriptHex, satoshis: sats }
      }) : []

      // Broadcast transaction via GorillaPool ARC (primary) → TAAL ARC (fallback)
      let normalHex = ''
      let changeOutput: { vout: number; satoshis: number; outputScript: string } | null = null
      try {
        const buildStartedAt = Date.now()
        const builtTx = buildSignedTransaction(1)
        normalHex = builtTx.serialized
        changeOutput = builtTx.changeOutput
        txBuildMs = Date.now() - buildStartedAt
        const broadcastStartedAt = Date.now()
        let broadcastResult: { txid: string; acceptedVia: string } | null = null
        try {
          broadcastResult = await this.broadcastTransaction(normalHex, prevoutsForArc, traceId)
        } finally {
          broadcastMs = Date.now() - broadcastStartedAt
        }
        if (!broadcastResult) throw new Error('Broadcast result missing')
        const { txid, acceptedVia: acceptedViaResult } = broadcastResult
        acceptedVia = acceptedViaResult
        acceptedTxid = txid
      } catch (innerErr) {
        if (inventoryBacked) {
          await releaseUtxo(acquiredUtxo.topic, acquiredUtxo.txid, acquiredUtxo.vout)
        } else {
          this.releaseUtxos([acquiredUtxoKey])
        }
        throw innerErr
      }

      const txid = acceptedTxid!

      if (inventoryBacked) {
        try {
          await consumeAndAdmitChange({
            topic: acquiredUtxo.topic,
            walletIndex: walletIndexForLog,
            spentTxid: acquiredUtxo.txid,
            spentVout: acquiredUtxo.vout,
            spendingTxid: txid,
            rawTx: normalHex,
            change: changeOutput ? {
              vout: changeOutput.vout,
              satoshis: changeOutput.satoshis,
              outputScript: changeOutput.outputScript,
              confirmed: false,
              utxoRole: 'pool',
            } : null,
          })
        } catch (inventoryErr) {
          const inventoryMsg = inventoryErr instanceof Error ? inventoryErr.message : String(inventoryErr)
          console.error(`❌ Inventory consume/admit failed for ${txid.substring(0, 12)}...: ${inventoryMsg}`)
        }
      } else {
        void this.notifyEmergencyUtxoManager({
          address,
          walletIndex: walletIndexForLog,
          topic: acquiredUtxo.topic,
          spentTxid: acquiredUtxo.txid,
          spentVout: acquiredUtxo.vout,
          spendingTxid: txid,
          change: changeOutput ? {
            vout: changeOutput.vout,
            satoshis: changeOutput.satoshis,
            outputScript: changeOutput.outputScript,
            confirmed: false,
          } : null,
        })
      }

      // Log transaction
      const transactionLog: TransactionLog = {
        txid,
        stream: data.stream,
        timestamp: data.timestamp,
        payload: this.compactPayloadForLog(data.payload),
        status: 'pending'
      }

      this.appendTransactionLog(transactionLog)
      this.operationalStats.broadcastsOk += 1
      throughputObservability.recordBroadcastAccepted({
        family: data.family || data.stream,
        providerId: providerIdValue,
        datasetId: datasetIdValue,
        queueLane: queueLaneValue,
        channel: acceptedVia,
        txid,
      })

      // Feed accepted transactions into the spend-source admission path.
      // In legacy mode this is a no-op; overlay mode can admit the outputs
      // immediately without waiting for external indexers to converge.
      if (inventoryBacked) {
        try {
          const spendSource = getSpendSourceForWallet(walletIndexForLog)
          const treasuryTopic = getTreasuryTopicForWallet(walletIndexForLog)
          void spendSource.submitAcceptedTx({
            clientRequestId: txid,
            topics: [treasuryTopic],
            rawTxEnvelope: {
              txid,
              rawTx: normalHex,
              acceptedVia,
              prevouts: prevoutsForArc,
              broadcastedAt: new Date().toISOString(),
            },
          }).catch((submitErr) => {
            const msg = submitErr instanceof Error ? submitErr.message : String(submitErr)
            console.warn(`⚠️ Spend-source submit failed for ${txid.substring(0, 12)}...: ${msg}`)
          })
        } catch {
          // Non-fatal – on-chain acceptance already succeeded.
        }
      }

      // ── Feed reading to /explorer store (zero API calls) ──
      try {
        if (canAttemptExplorerWrite()) {
          const pl: any = payloadWithAscii ?? data.payload ?? {}
          const explorerReading: StoredReading = {
            txid,
            dataType: data.stream,
            location: pl.location || pl.location_ascii || pl.station_name || pl.city || null,
            lat: pl.coordinates?.lat ?? pl.coordinates?.latitude ?? pl.latitude ?? null,
            lon: pl.coordinates?.lon ?? pl.coordinates?.longitude ?? pl.longitude ?? null,
            timestamp: data.timestamp,
            metrics: pl,
            provider: (data as any)?.payload?.source || null,
            blockHeight: 0, // Will be set when confirmed
            blockTime: null,
          }
          void addReading(explorerReading, { providerId: providerIdValue, datasetId: datasetIdValue })
            .then((inserted) => {
              if (!inserted) return
              throughputObservability.recordExplorerIndexed({
                family: data.family || data.stream,
                providerId: providerIdValue,
                datasetId: datasetIdValue,
                queueLane: queueLaneValue,
                channel: acceptedVia,
                txid,
              })
            })
            .catch(() => {
              // Non-fatal – explorer store is secondary
            })
        }
      } catch {
        // Non-fatal – explorer store is secondary
      }

      // Persist to tx_log (pending on broadcast, will be confirmed later)
      try {
        if (process.env.GAIALOG_NO_DB !== 'true') {
          const txLogStartedAt = Date.now()
          await upsertTxLog({
            txid,
            type: data.stream,
            provider: (data as any)?.payload?.source || 'unknown',
            collected_at: new Date(data.timestamp),
            status: 'pending',
            onchain_at: new Date(),
            fee_sats: null,
            wallet_index: walletIndexForLog,
            retries: 0,
            error: null,
          })
          txLogMs = Date.now() - txLogStartedAt
        }
      } catch (e) {
        // Non-fatal
      }

      // Queue a best-effort confirmation check without adding a new timer per TX
      this.enqueueConfirmationCheck(txid, data.stream)

      this.broadcastCountSinceLastSample++
      this.logWriteToChainSummary({
        traceId,
        stream: data.stream,
        totalMs: Date.now() - writeStartedAt,
        walletLookupMs,
        walletIndex: selectedWalletIndex,
        address: selectedWalletAddress || fromAddress,
        spendableCount: selectedSpendableCount,
        txBuildMs,
        broadcastMs,
        txLogMs,
        acceptedVia,
        txid: acceptedTxid,
      })
      return txid

    } catch (error) {
      // Suppress noisy logs for expected, transient availability issues
      const msg = error instanceof Error ? error.message : String(error)
      this.logWriteToChainSummary({
        traceId,
        stream: data.stream,
        totalMs: Date.now() - writeStartedAt,
        walletLookupMs,
        walletIndex: selectedWalletIndex,
        address: selectedWalletAddress || fromAddress,
        spendableCount: selectedSpendableCount,
        txBuildMs,
        broadcastMs,
        txLogMs,
        acceptedVia,
        txid: acceptedTxid,
        error: msg,
      })
      const transient = /already reserved|No UTXOs available across wallets|No inventory UTXOs available across wallets|No emergency spendable UTXOs available across wallets|No reservable UTXO|MEMPOOL_CHAIN_LIMIT|txn-mempool-conflict|DOUBLE_SPEND|HEAP_PRESSURE_BACKOFF/i.test(msg)
      const failedProviderValue = (data as any)?.payload?.source || 'unknown'
      const failedProviderId = (data as any)?.providerId || (data as any)?.payload?.provider_id || resolveProviderIdFromSource(failedProviderValue) || undefined
      const failedDatasetId = (data as any)?.datasetId || (data as any)?.payload?.dataset_id || undefined
      const failedQueueLane = (data as any)?.queueLane === 'throughput' || (data as any)?.queueLane === 'coverage'
        ? (data as any).queueLane
        : undefined
      this.operationalStats.broadcastsFailed += 1
      this.recordOperationalError('writeToChain', msg)
      throughputObservability.recordBroadcastFailed({
        family: data.family || data.stream,
        providerId: failedProviderId,
        datasetId: failedDatasetId,
        queueLane: failedQueueLane,
        channel: this.detectBroadcastChannel(msg),
        error: msg,
      })

      // Signal per-wallet mempool-chain backoff so round-robin skips this wallet
      if (msg.includes('MEMPOOL_CHAIN_LIMIT') && fromAddress) {
        try {
          const { signalMempoolChainLimit } = await import('./utxo-maintainer')
          signalMempoolChainLimit(fromAddress)
        } catch {}
      }

      if (!transient) {
        console.error('❌ Error writing to blockchain:', error)
      } else if (/txn-mempool-conflict|DOUBLE_SPEND/i.test(msg)) {
        // One-liner instead of full stack trace — this is recoverable
        console.warn(`⚠️  UTXO conflict (will retry with fresh UTXO): ${msg.split('\n')[0].substring(0, 120)}`)
      }
      
      // Log failed transaction
      if (!transient) {
        const failedLog: TransactionLog = {
          txid: 'failed',
          stream: data.stream,
          timestamp: data.timestamp,
          payload: this.compactPayloadForLog(data.payload),
          status: 'failed',
          error: msg || 'Unknown error'
        }
        this.appendTransactionLog(failedLog)
        try {
          if (process.env.GAIALOG_NO_DB !== 'true') {
            await upsertTxLog({
              txid: 'failed',
              type: data.stream,
              provider: (data as any)?.payload?.source || 'unknown',
              collected_at: new Date(data.timestamp),
              status: 'failed',
              onchain_at: null,
              fee_sats: null,
              wallet_index: null,
              retries: 0,
              error: failedLog.error || 'Unknown error',
            })
          }
        } catch {}
      }
      
      throw error
    }
  }

  private ensureAddressCache(address: string): {
    fetchedAt: number
    utxos: any[]
    usedKeys: Map<string, number>
    inFlight: Promise<void> | null
  } {
    let cache = this.utxoCacheByAddress.get(address)
    if (!cache) {
      cache = { fetchedAt: 0, utxos: [], usedKeys: new Map<string, number>(), inFlight: null }
      this.utxoCacheByAddress.set(address, cache)
    }
    return cache
  }

  private filterLocallyUsedUtxos(address: string, utxos: any[]): any[] {
    const now = Date.now()
    const cache = this.ensureAddressCache(address)
    try {
      for (const [key, exp] of cache.usedKeys.entries()) {
        if (exp <= now) cache.usedKeys.delete(key)
      }
    } catch {}
    return (Array.isArray(utxos) ? utxos : []).filter((u: any) => {
      const key = `${u.tx_hash}:${u.tx_pos}`
      const exp = cache.usedKeys.get(key)
      if (!exp) return true
      if (exp <= now) {
        cache.usedKeys.delete(key)
        return true
      }
      return false
    })
  }

  private mapSpendSourceOutputToUtxo(output: SpendableOutput, fallbackAddress: string): any {
    const confirmed = output.confirmed
    return {
      tx_hash: output.txid,
      tx_pos: output.vout,
      value: output.satoshis,
      address: output.address || fallbackAddress,
      script: output.outputScript,
      rawTx: output.rawTx,
      proof: output.proof,
      confirmations: confirmed ? Math.max(1, MIN_SPEND_CONF || 1) : 0,
      height: confirmed ? 1 : 0,
      admittedAt: output.admittedAt,
      spendSource: output.source,
      spendTopic: output.topic,
    }
  }

  private overlayResponseCache: Map<string, { fetchedAt: number; utxos: any[] }> = new Map()
  private overlayInFlight: Map<string, Promise<any[]>> = new Map()
  private static readonly OVERLAY_CACHE_TTL_MS = 5_000

  private async getSpendableUtxosFromSpendSource(address: string, walletIndex: number, minSatoshisHint: number = 0): Promise<any[]> {
    const now = Date.now()
    const cached = this.overlayResponseCache.get(address)
    if (cached && (now - cached.fetchedAt) < BlockchainService.OVERLAY_CACHE_TTL_MS) {
      return cached.utxos
    }

    const inflight = this.overlayInFlight.get(address)
    if (inflight) return inflight

    const driftRetryEnabled = process.env.BSV_OVERLAY_EMPTY_DRIFT_RETRY !== 'false'

    const fetching = (async () => {
      const topic = getTreasuryTopicForWallet(walletIndex)
      const spendSource = getSpendSourceForWallet(walletIndex)
      const confirmedOnly = MIN_SPEND_CONF > 0
      const effectiveMinSats = EMERGENCY_LEGACY_UTXO_MODE ? Math.max(minSatoshisHint, UTXO_POOL_MIN_SATS) : 0
      const listOnce = async () => {
        const outputs = await spendSource.listSpendable({
          topic,
          limit: SPEND_SOURCE_LIST_LIMIT,
          order: 'asc',
          minSatoshis: effectiveMinSats,
          excludeReserved: false,
          confirmedOnly,
        })
        return outputs.map(output => this.mapSpendSourceOutputToUtxo(output, address))
      }

      let mapped = await listOnce()

      if (mapped.length === 0 && driftRetryEnabled) {
        try {
          const totalAny = await spendSource.countSpendable({
            topic,
            minSatoshis: 0,
            excludeReserved: false,
            confirmedOnly: false,
            allowDegradedStale: true,
          })

          if (totalAny > 0 && confirmedOnly) {
            logOverlayUnconfirmedOnlyBlocked(walletIndex, totalAny, MIN_SPEND_CONF)
          }

          if (totalAny > 0 && !confirmedOnly) {
            logOverlayEmptyListDrift(walletIndex, totalAny)
            mapped = await listOnce()
          }
        } catch {
          // count is best-effort diagnostics / retry trigger
        }
      }

      return mapped
    })()

    this.overlayInFlight.set(address, fetching)
    try {
      const result = await fetching
      this.overlayResponseCache.set(address, { fetchedAt: Date.now(), utxos: result })
      return result
    } finally {
      this.overlayInFlight.delete(address)
    }
  }

  private async refreshUtxoCache(address: string, wif: string, force = false): Promise<void> {
    let cache = this.ensureAddressCache(address)
    if (cache.inFlight) {
      await cache.inFlight
      if (!force) return
      // force=true: the previous in-flight refresh may not have picked up the latest change outputs
    }
    cache.inFlight = (async () => {
      // Fetch UTXOs for the given address using a temporary wallet
      const tempWallet = new BSVWallet(wif)
      const fetched = await tempWallet.getUTXOs()
      cache!.utxos = Array.isArray(fetched) ? fetched : []
      cache!.fetchedAt = Date.now()
      // Do NOT clear usedKeys on refresh — WoC /unspent can lag, so a just-spent
      // UTXO may still appear briefly. We prune by expiry instead.
      try {
        const now = Date.now()
        for (const [k, exp] of cache!.usedKeys.entries()) {
          if (exp <= now) cache!.usedKeys.delete(k)
        }
      } catch {}
      
      this.operationalStats.utxoRefreshes += 1
      this.operationalStats.rawUtxosFetched += cache!.utxos.length
      // UTXO refresh detail is debug-only to avoid log spam in production.
      if (cache!.utxos.length > 0 && bsvConfig.logging.level === 'debug') {
        console.log(`🔁 UTXO cache refreshed for ${address.substring(0, 10)}...: ${cache!.utxos.length} raw UTXO(s) fetched`)
        cache!.utxos.slice(0, 3).forEach((u: any, idx: number) => {
          console.log(`   UTXO ${idx + 1}: value=${u.value || u.satoshis || 'unknown'}, conf=${u.confirmations || 0}, height=${u.height || 'unknown'}, tx=${(u.tx_hash || u.txId || '').substring(0, 16)}...`)
        })
      }
      
      cache!.inFlight = null
    })()
    await cache.inFlight
  }

  private async getSpendableUtxos(address: string, explicitWif?: string, walletIndex?: number, traceId?: string, minSatoshisHint: number = 0): Promise<any[]> {
    const startedAt = Date.now()
    const notes: string[] = []
    const resolvedWalletIndex = typeof walletIndex === 'number'
      ? walletIndex
      : getWalletIndexForAddress(address)
    if (resolvedWalletIndex != null) {
      try {
        const spendables = await this.getSpendableUtxosFromSpendSource(address, resolvedWalletIndex, minSatoshisHint)
        const filtered = this.filterLocallyUsedUtxos(address, spendables)
        this.logUtxoLookupTrace({
          traceId,
          walletIndex: resolvedWalletIndex,
          address,
          source: 'spend-source',
          spendableCount: filtered.length,
          durationMs: Date.now() - startedAt,
        })
        return filtered
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notes.push(`spend-source fallback=${message}`)
        const overlayMode = (process.env.BSV_SPEND_SOURCE_MODE || '').toLowerCase() === 'overlay'
        if (overlayMode) {
          this.logUtxoLookupTrace({
            traceId,
            walletIndex: resolvedWalletIndex ?? undefined,
            address,
            source: 'overlay-failed',
            spendableCount: 0,
            durationMs: Date.now() - startedAt,
            note: notes.join('; '),
          })
          return []
        }
        if (bsvConfig.logging.level === 'debug') {
          console.warn(`⚠️ Spend-source lookup failed for ${address.substring(0, 10)}...; falling back to legacy UTXO path: ${message}`)
        }
      }
    }

    if (!ENABLE_UTXO_POOL) {
      // No caching; fetch directly via a temporary wallet created from the matching or explicit WIF
      let useWif = explicitWif || ''
      if (!useWif) {
        for (const k of (this.wifsForSend && this.wifsForSend.length ? this.wifsForSend : (BSV_PRIVATE_KEY ? [BSV_PRIVATE_KEY] : (BSV_FALLBACK_WIF ? [BSV_FALLBACK_WIF] : [])))) {
          try {
            const key = SDKPrivateKey.fromWif(k)
            const addr = key.toPublicKey().toAddress().toString()
            if (addr === address) { useWif = k; break }
          } catch {}
        }
      }
      if (!useWif) throw new Error('No matching WIF found for address')
      const temp = new BSVWallet(useWif)
      const raw = await temp.getUTXOs()
      const filtered = Array.isArray(raw)
        ? raw.filter((u: any) => {
            return (u.confirmations || 0) >= MIN_SPEND_CONF || (typeof u.height !== 'number') || u.height > 0
          })
        : []
      this.logUtxoLookupTrace({
        traceId,
        walletIndex: resolvedWalletIndex ?? undefined,
        address,
        source: resolvedWalletIndex != null ? 'legacy-direct-fallback' : 'legacy-direct',
        spendableCount: filtered.length,
        durationMs: Date.now() - startedAt,
        note: notes.join('; '),
      })
      return filtered
    }
    const now = Date.now()
    let cache = this.utxoCacheByAddress.get(address)
    if (!cache) {
      await this.refreshUtxoCache(address, explicitWif || '')
      cache = this.utxoCacheByAddress.get(address)!
      notes.push('cold-cache-refresh')
    }
    // Best-effort prune expired used keys
    try {
      for (const [k, exp] of cache.usedKeys.entries()) {
        if (exp <= now) cache.usedKeys.delete(k)
      }
    } catch {}
    // Only refresh on TTL if available confirmed UTXOs is low
    const availableNow = (cache?.utxos || [])
      .filter((u: any) => {
        return (u.confirmations || 0) >= MIN_SPEND_CONF || (typeof u.height !== 'number') || u.height > 0
      })
      .filter((u: any) => {
        const key = `${u.tx_hash}:${u.tx_pos}`
        const exp = cache!.usedKeys.get(key)
        if (!exp) return true
        if (exp <= now) { cache!.usedKeys.delete(key); return true }
        return false
      })
    if (now - cache.fetchedAt > UTXO_POOL_TTL_MS && availableNow.length < REFRESH_THRESHOLD) {
      // Refresh using an explicit WIF that matches this address
      let matchWif = explicitWif || ''
      if (!matchWif) {
        for (const k of (this.wifsForSend && this.wifsForSend.length ? this.wifsForSend : (BSV_PRIVATE_KEY ? [BSV_PRIVATE_KEY] : (BSV_FALLBACK_WIF ? [BSV_FALLBACK_WIF] : [])))) {
          try {
            const key = SDKPrivateKey.fromWif(k)
            const addr = key.toPublicKey().toAddress().toString()
            if (addr === address) { matchWif = k; break }
          } catch {}
        }
      }
      if (!matchWif) throw new Error('No matching WIF found for address')
      await this.refreshUtxoCache(address, matchWif)
      cache = this.utxoCacheByAddress.get(address)!
      notes.push('ttl-refresh')
    }
    const used = cache.usedKeys
    const available = cache.utxos
      .filter((u: any) => (u.confirmations || 0) >= MIN_SPEND_CONF || (typeof u.height !== 'number') || u.height > 0)
      .filter((u: any) => {
        const key = `${u.tx_hash}:${u.tx_pos}`
        const exp = used.get(key)
        if (!exp) return true
        if (exp <= now) { used.delete(key); return true }
        return false
      })
    if (available.length === 0) {
      // Try a forced refresh once
      let matchWif = explicitWif || ''
      if (!matchWif) {
        for (const k of (this.wifsForSend && this.wifsForSend.length ? this.wifsForSend : (BSV_PRIVATE_KEY ? [BSV_PRIVATE_KEY] : (BSV_FALLBACK_WIF ? [BSV_FALLBACK_WIF] : [])))) {
          try {
            const key = SDKPrivateKey.fromWif(k)
            const addr = key.toPublicKey().toAddress().toString()
            if (addr === address) { matchWif = k; break }
          } catch {}
        }
      }
      if (matchWif) await this.refreshUtxoCache(address, matchWif)
      if (matchWif) notes.push('empty-refresh')
      const refreshed = this.utxoCacheByAddress.get(address)!
      const filtered = refreshed.utxos
        .filter((u: any) => (u.confirmations || 0) >= MIN_SPEND_CONF || (typeof u.height !== 'number') || u.height > 0)
        .filter((u: any) => {
          const key = `${u.tx_hash}:${u.tx_pos}`
          const exp = refreshed.usedKeys.get(key)
          if (!exp) return true
          if (exp <= now) { refreshed.usedKeys.delete(key); return true }
          return false
        })
      this.logUtxoLookupTrace({
        traceId,
        walletIndex: resolvedWalletIndex ?? undefined,
        address,
        source: resolvedWalletIndex != null ? 'legacy-cache-fallback' : 'legacy-cache',
        spendableCount: filtered.length,
        durationMs: Date.now() - startedAt,
        note: notes.join('; '),
      })
      return filtered
    }
    this.logUtxoLookupTrace({
      traceId,
      walletIndex: resolvedWalletIndex ?? undefined,
      address,
      source: resolvedWalletIndex != null ? 'legacy-cache-fallback' : 'legacy-cache',
      spendableCount: available.length,
      durationMs: Date.now() - startedAt,
      note: notes.join('; '),
    })
    return available
  }

  private markUtxosUsed(keys: string[]): void {
    if (!ENABLE_UTXO_POOL && !EMERGENCY_LEGACY_UTXO_MODE) return
    const exp = Date.now() + Math.max(1000, UTXO_USED_KEY_TTL_MS)
    // Mark in every address cache (keys are globally unique per address anyway)
    for (const cache of this.utxoCacheByAddress.values()) {
      for (const k of keys) cache.usedKeys.set(k, exp)
    }
  }

  private releaseUtxos(keys: string[]): void {
    if (!ENABLE_UTXO_POOL && !EMERGENCY_LEGACY_UTXO_MODE) return
    for (const cache of this.utxoCacheByAddress.values()) {
      for (const k of keys) cache.usedKeys.delete(k)
    }
  }

  /**
   * Force refresh all UTXO caches for all configured wallets
   * Useful when UTXOs are not being detected despite having balances
   */
  async forceRefreshAllUtxoCaches(): Promise<void> {
    const list = this.wifsForSend && this.wifsForSend.length > 0
      ? this.wifsForSend
      : (BSV_PRIVATE_KEY ? [BSV_PRIVATE_KEY] : (BSV_FALLBACK_WIF ? [BSV_FALLBACK_WIF] : []))
    
    console.log(`🔄 Force refreshing UTXO caches for ${list.length} wallet(s)...`)
    
    for (const wif of list) {
      try {
        const sdkKey = SDKPrivateKey.fromWif(wif)
        const addr = sdkKey.toPublicKey().toAddress().toString()
        
        // Clear existing cache to force fresh fetch
        if (ENABLE_UTXO_POOL) {
          const cache = this.utxoCacheByAddress.get(addr)
          if (cache) {
            cache.fetchedAt = 0 // Force refresh by making cache stale
            cache.utxos = [] // Clear existing UTXOs
            cache.usedKeys.clear() // Clear used key TTLs (explicit force refresh)
            cache.inFlight = null // Cancel any in-flight refresh
          }
        }

        // Overlay-backed lookups cache responses in-process; clear so next spend path refetches
        this.overlayResponseCache.delete(addr)
        this.overlayInFlight.delete(addr)
        
        // Force refresh
        await this.refreshUtxoCache(addr, wif)
        
        // Get raw count from cache
        const cache = this.utxoCacheByAddress.get(addr)
        const rawCount = cache?.utxos?.length || 0
        
        // Verify we got UTXOs after filtering
        const spendable = await this.getSpendableUtxos(addr, wif)
        console.log(`   ${addr.substring(0, 10)}...: ${rawCount} raw UTXO(s), ${spendable.length} spendable (min_conf=${MIN_SPEND_CONF})`)
        
        // If we have raw UTXOs but no spendable, log why
        if (rawCount > 0 && spendable.length === 0) {
          const sample = cache?.utxos?.[0]
          if (sample) {
            const conf = sample.confirmations || 0
            const height = sample.height
            console.log(`   ⚠️  UTXOs filtered out: sample has ${conf} confirmations, height=${height}, min_required=${MIN_SPEND_CONF}`)
          }
        }
      } catch (e) {
        const addr = (() => {
          try {
            const sdkKey = SDKPrivateKey.fromWif(wif)
            return sdkKey.toPublicKey().toAddress().toString()
          } catch {
            return 'unknown'
          }
        })()
        console.error(`   Failed to refresh ${addr.substring(0, 10)}...: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    
    console.log('✅ UTXO cache refresh complete')
  }

  // ARC txStatus values that indicate the TX was genuinely accepted for our purposes.
  // SEEN_IN_ORPHAN_MEMPOOL: relay accepted the tx but parent(s) are not visible to that ARC
  // instance yet. Falling through to TAAL/WoC often yields 460 / "Missing inputs" for the same
  // reason — so treating orphan as success (default) avoids total broadcast failure. Operators
  // who require strict main-mempool acceptance can set BSV_ARC_ACCEPT_ORPHAN_MEMPOOL=false.
  private static ARC_OK_STATUSES = new Set([
    'SEEN_ON_NETWORK',
    'MINED',
    'ACCEPTED',
    'STORED',
    'RECEIVED',
    'REQUESTED_BY_NETWORK',
    'SENT_TO_NETWORK',
    'ANNOUNCED_TO_NETWORK',
  ])

  // ARC txStatus values that mean the TX was rejected (should NOT be treated as success)
  private static ARC_REJECT_STATUSES = new Set([
    'DOUBLE_SPEND_ATTEMPTED',
    'REJECTED',
    'INVALID',
    'EVICTED',
  ])

  /**
   * Parse an ARC response and return the txid ONLY if the TX was genuinely accepted.
   * ARC returns HTTP 200 + a valid txid even for DOUBLE_SPEND_ATTEMPTED — we must
   * inspect the txStatus field to avoid logging a rejected TX as "successful".
   */
  private parseArcResponse(responseText: string, providerLabel: string): string | null {
    try {
      const parsed = JSON.parse(responseText || '{}')
      const txid = typeof parsed.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(parsed.txid)
        ? parsed.txid : null
      const status = typeof parsed.txStatus === 'string' ? parsed.txStatus : ''

      // Reject if ARC explicitly flagged as failed
      if (txid && BlockchainService.ARC_REJECT_STATUSES.has(status)) {
        const competing = Array.isArray(parsed.competingTxs) ? ` (competing: ${parsed.competingTxs[0]?.substring(0, 12)}...)` : ''
        console.warn(`⚠️  ARC (${providerLabel}): TX rejected — txStatus=${status}${competing} txid=${txid.substring(0, 12)}...`)
        return null
      }

      // Orphan mempool: accept by default (GP often returns this when parents lag; TAAL/WoC then 460/missing-inputs).
      // Set BSV_ARC_ACCEPT_ORPHAN_MEMPOOL=false to try fallbacks instead (legacy strict behaviour).
      if (txid && status === 'SEEN_IN_ORPHAN_MEMPOOL') {
        const acceptOrphan = process.env.BSV_ARC_ACCEPT_ORPHAN_MEMPOOL !== 'false'
        if (!acceptOrphan) {
          console.warn(
            `⚠️  ARC (${providerLabel}): txStatus=SEEN_IN_ORPHAN_MEMPOOL — trying next broadcaster ` +
              `(unset BSV_ARC_ACCEPT_ORPHAN_MEMPOOL or set true to accept) txid=${txid.substring(0, 12)}...`,
          )
          return null
        }
        if (bsvConfig.logging.level !== 'error') {
          console.warn(
            `⚠️  ARC (${providerLabel}): txStatus=SEEN_IN_ORPHAN_MEMPOOL — accepting txid=${txid.substring(0, 12)}... ` +
              `(parents not visible to all relays; set BSV_ARC_ACCEPT_ORPHAN_MEMPOOL=false to reject)`,
          )
        }
        return txid
      }

      // Accept if status is known-good or if no status field was returned (legacy ARC)
      if (txid && (BlockchainService.ARC_OK_STATUSES.has(status) || !status)) {
        if (bsvConfig.logging.level === 'debug') {
          console.log(`📡 ARC (${providerLabel}): txStatus=${status || 'N/A'} txid=${txid.substring(0, 12)}...`)
        }
        return txid
      }

      // Unknown status with a txid — log but accept cautiously
      if (txid) {
        console.warn(`⚠️  ARC (${providerLabel}): Unknown txStatus="${status}" — accepting txid=${txid.substring(0, 12)}... cautiously`)
        return txid
      }
    } catch {}

    // Fallback: some ARC deployments return plain string txid (no JSON)
    const plain = (responseText || '').replace(/"/g, '').trim()
    if (/^[0-9a-fA-F]{64}$/.test(plain)) return plain
    return null
  }

  private async broadcastTransaction(
    serializedTx: string,
    prevouts?: Array<{ lockingScript: string; satoshis: number }>,
    traceId?: string
  ): Promise<{ txid: string; acceptedVia: string }> {
    const errors: string[] = []

    // Build ARC request bodies:
    // - extended format includes prevouts for stricter validation
    // - raw-only body is a compatibility fallback (some ARC gateways reject extended metadata)
    const arcBodyRaw: any = { rawTx: serializedTx }
    const useExtended = !!(prevouts && prevouts.length > 0 && (process.env.BSV_ARC_EXTENDED_FORMAT !== 'false'))
    const arcBodyExtended: any = { rawTx: serializedTx }
    if (useExtended) {
      try {
        arcBodyExtended.inputs = prevouts!.map(p => ({
          lockingScript: p.lockingScript,
          satoshis: Math.max(0, Number(p.satoshis) || 0),
        }))
      } catch {}
    }

    // Method 1: GorillaPool ARC (primary) — public access, no API key required
    try {
      if (this.isBroadcastChannelBackedOff('gorillapool_arc')) {
        errors.push('GorillaPool ARC skipped (ENDPOINT_BACKOFF)')
        this.logBroadcastStep(traceId, 'gorillapool_arc', 'skipped', 0, 'ENDPOINT_BACKOFF')
      } else {
      const gpStartedAt = Date.now()
      this.logBroadcastStep(traceId, 'gorillapool_arc', 'start', undefined, `timeout=${BROADCAST_FETCH_TIMEOUT_MS}ms`)
      const gpHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
      const gpApiKey = process.env.BSV_GORILLAPOOL_API_KEY
      if (gpApiKey) gpHeaders['Authorization'] = `Bearer ${gpApiKey}`

      const gpRes = await this.fetchWithTimeout(`${GORILLAPOOL_ARC_ENDPOINT}/v1/tx`, {
        method: 'POST',
        headers: gpHeaders,
        body: JSON.stringify(useExtended ? arcBodyExtended : arcBodyRaw)
      })
      const gpText = await gpRes.text().catch(() => '')
      if (gpRes.ok) {
        const txid = this.parseArcResponse(gpText, 'GorillaPool')
        if (txid) {
          this.logBroadcastStep(traceId, 'gorillapool_arc', 'accepted', Date.now() - gpStartedAt, `txid=${this.shortenToken(txid, 12)}`)
          this.clearBroadcastChannelBackoff('gorillapool_arc')
          return { txid, acceptedVia: 'gorillapool_arc' }
        }
        this.logBroadcastStep(traceId, 'gorillapool_arc', 'rejected', Date.now() - gpStartedAt, 'ok-without-accepted-txid')
        errors.push(`GorillaPool ARC: rejected or unexpected response: ${gpText.substring(0, 200)}`)
      } else {
        if (bsvConfig.logging.level !== 'error') {
          console.warn(`⚠️  ARC (GorillaPool) ${gpRes.status}: ${gpText.substring(0, 150)}`)
        }
        if (gpRes.status === 429) {
          this.noteBroadcastChannelBackoff('gorillapool_arc', 60000, 'HTTP 429')
        } else if (gpRes.status >= 500) {
          this.noteBroadcastChannelBackoff('gorillapool_arc', 30000, `HTTP ${gpRes.status}`)
        }
        // GorillaPool sometimes rejects extended-format metadata with 461, or returns 460 when parents
        // are not visible to ARC. Retry once with rawTx-only before failing over to TAAL/WoC.
        const gp461 = gpRes.status === 461 || /malformed|false\/empty top stack/i.test(gpText)
        const gp460 =
          gpRes.status === 460 ||
          /parent transaction not found|fee requires|Not extended format|Missing input scripts|Failed validity with parents/i.test(gpText)
        const gpCompatRetry = useExtended && (gp461 || gp460)
        this.logBroadcastStep(traceId, 'gorillapool_arc', `http_${gpRes.status}`, Date.now() - gpStartedAt, gpCompatRetry ? 'compat-retry' : undefined)
        if (gpCompatRetry) {
          try {
            const gpCompatStartedAt = Date.now()
            this.logBroadcastStep(traceId, 'gorillapool_arc_rawtx_retry', 'start', undefined, `timeout=${BROADCAST_FETCH_TIMEOUT_MS}ms`)
            const gpCompatRes = await this.fetchWithTimeout(`${GORILLAPOOL_ARC_ENDPOINT}/v1/tx`, {
              method: 'POST',
              headers: gpHeaders,
              body: JSON.stringify(arcBodyRaw)
            })
            const gpCompatText = await gpCompatRes.text().catch(() => '')
            if (gpCompatRes.ok) {
              const txid = this.parseArcResponse(gpCompatText, 'GorillaPool')
              if (txid) {
                this.logBroadcastStep(traceId, 'gorillapool_arc_rawtx_retry', 'accepted', Date.now() - gpCompatStartedAt, `txid=${this.shortenToken(txid, 12)}`)
                if (bsvConfig.logging.level !== 'error') {
                  console.warn('⚠️  ARC (GorillaPool): accepted after rawTx compatibility retry (460/461 / extended mismatch)')
                }
                this.clearBroadcastChannelBackoff('gorillapool_arc')
                return { txid, acceptedVia: 'gorillapool_arc' }
              }
              this.logBroadcastStep(traceId, 'gorillapool_arc_rawtx_retry', 'rejected', Date.now() - gpCompatStartedAt, 'ok-without-accepted-txid')
              errors.push(`GorillaPool ARC compatibility retry: unexpected response: ${gpCompatText.substring(0, 200)}`)
            } else {
              this.logBroadcastStep(traceId, 'gorillapool_arc_rawtx_retry', `http_${gpCompatRes.status}`, Date.now() - gpCompatStartedAt)
              if (bsvConfig.logging.level !== 'error') {
                console.warn(`⚠️  ARC (GorillaPool compat) ${gpCompatRes.status}: ${gpCompatText.substring(0, 150)}`)
              }
              if (gpCompatRes.status === 429) {
                this.noteBroadcastChannelBackoff('gorillapool_arc', 60000, 'HTTP 429')
              } else if (gpCompatRes.status >= 500) {
                this.noteBroadcastChannelBackoff('gorillapool_arc', 30000, `HTTP ${gpCompatRes.status}`)
              }
              errors.push(`GorillaPool ARC compatibility retry failed (${gpCompatRes.status}): ${gpCompatText.substring(0, 300)}`)
            }
          } catch (compatErr) {
            this.logBroadcastStep(traceId, 'gorillapool_arc_rawtx_retry', 'error', undefined, compatErr instanceof Error ? compatErr.message : String(compatErr))
            this.noteBroadcastChannelBackoff('gorillapool_arc', 30000, compatErr instanceof Error ? compatErr.message : String(compatErr))
            errors.push(`GorillaPool ARC compatibility retry error: ${compatErr instanceof Error ? compatErr.message : String(compatErr)}`)
          }
        } else {
          errors.push(`GorillaPool ARC failed (${gpRes.status}): ${gpText.substring(0, 300)}`)
        }
      }
      }
    } catch (e) {
      this.logBroadcastStep(traceId, 'gorillapool_arc', 'error', undefined, e instanceof Error ? e.message : String(e))
      this.noteBroadcastChannelBackoff('gorillapool_arc', 30000, e instanceof Error ? e.message : String(e))
      errors.push(`GorillaPool ARC error: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Method 2: TAAL ARC (fallback)
    try {
      if (this.isBroadcastChannelBackedOff('taal_arc')) {
        errors.push('TAAL ARC skipped (ENDPOINT_BACKOFF)')
        this.logBroadcastStep(traceId, 'taal_arc', 'skipped', 0, 'ENDPOINT_BACKOFF')
      } else {
      const taalStartedAt = Date.now()
      this.logBroadcastStep(traceId, 'taal_arc', 'start', undefined, `timeout=${BROADCAST_FETCH_TIMEOUT_MS}ms`)
      const arcKey = process.env.BSV_ARC_API_KEY
      const taalHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
      if (arcKey) taalHeaders['Authorization'] = `Bearer ${arcKey}`

      const arcRes = await this.fetchWithTimeout(`${TAAL_ARC_ENDPOINT}/v1/tx`, {
        method: 'POST',
        headers: taalHeaders,
        body: JSON.stringify(useExtended ? arcBodyExtended : arcBodyRaw)
      })
      const arcText = await arcRes.text().catch(() => '')
      if (arcRes.ok) {
        const txid = this.parseArcResponse(arcText, 'TAAL')
        if (txid) {
          this.logBroadcastStep(traceId, 'taal_arc', 'accepted', Date.now() - taalStartedAt, `txid=${this.shortenToken(txid, 12)}`)
          this.clearBroadcastChannelBackoff('taal_arc')
          return { txid, acceptedVia: 'taal_arc' }
        }
        this.logBroadcastStep(traceId, 'taal_arc', 'rejected', Date.now() - taalStartedAt, 'ok-without-accepted-txid')
        errors.push(`TAAL ARC: rejected or unexpected response: ${arcText.substring(0, 200)}`)
      } else {
        this.logBroadcastStep(traceId, 'taal_arc', `http_${arcRes.status}`, Date.now() - taalStartedAt)
        if (bsvConfig.logging.level !== 'error') {
          console.warn(`⚠️  ARC (TAAL) ${arcRes.status}: ${arcText.substring(0, 150)}`)
        }
        if (arcRes.status === 429) {
          this.noteBroadcastChannelBackoff('taal_arc', 60000, 'HTTP 429')
        } else if (arcRes.status >= 500) {
          this.noteBroadcastChannelBackoff('taal_arc', 30000, `HTTP ${arcRes.status}`)
        }
        const taal461 = arcRes.status === 461 || /malformed|false\/empty top stack/i.test(arcText)
        const taal460 =
          arcRes.status === 460 ||
          /parent transaction not found|fee requires|Not extended format|Missing input scripts|Failed validity with parents/i.test(arcText)
        const taalCompatRetry = useExtended && (taal461 || taal460)
        if (taalCompatRetry) {
          try {
            const taalCompatStartedAt = Date.now()
            this.logBroadcastStep(traceId, 'taal_arc_rawtx_retry', 'start', undefined, `timeout=${BROADCAST_FETCH_TIMEOUT_MS}ms`)
            const taalCompatRes = await this.fetchWithTimeout(`${TAAL_ARC_ENDPOINT}/v1/tx`, {
              method: 'POST',
              headers: taalHeaders,
              body: JSON.stringify(arcBodyRaw),
            })
            const taalCompatText = await taalCompatRes.text().catch(() => '')
            if (taalCompatRes.ok) {
              const txid = this.parseArcResponse(taalCompatText, 'TAAL')
              if (txid) {
                this.logBroadcastStep(traceId, 'taal_arc_rawtx_retry', 'accepted', Date.now() - taalCompatStartedAt, `txid=${this.shortenToken(txid, 12)}`)
                if (bsvConfig.logging.level !== 'error') {
                  console.warn('⚠️  ARC (TAAL): accepted after rawTx compatibility retry (460/461)')
                }
                this.clearBroadcastChannelBackoff('taal_arc')
                return { txid, acceptedVia: 'taal_arc' }
              }
              this.logBroadcastStep(traceId, 'taal_arc_rawtx_retry', 'rejected', Date.now() - taalCompatStartedAt, 'ok-without-accepted-txid')
              errors.push(`TAAL ARC compatibility retry: unexpected response: ${taalCompatText.substring(0, 200)}`)
            } else {
              this.logBroadcastStep(traceId, 'taal_arc_rawtx_retry', `http_${taalCompatRes.status}`, Date.now() - taalCompatStartedAt)
              if (bsvConfig.logging.level !== 'error') {
                console.warn(`⚠️  ARC (TAAL compat) ${taalCompatRes.status}: ${taalCompatText.substring(0, 150)}`)
              }
              if (taalCompatRes.status === 429) {
                this.noteBroadcastChannelBackoff('taal_arc', 60000, 'HTTP 429')
              } else if (taalCompatRes.status >= 500) {
                this.noteBroadcastChannelBackoff('taal_arc', 30000, `HTTP ${taalCompatRes.status}`)
              }
              errors.push(`TAAL ARC compatibility retry failed (${taalCompatRes.status}): ${taalCompatText.substring(0, 300)}`)
            }
          } catch (compatErr) {
            this.logBroadcastStep(traceId, 'taal_arc_rawtx_retry', 'error', undefined, compatErr instanceof Error ? compatErr.message : String(compatErr))
            this.noteBroadcastChannelBackoff('taal_arc', 30000, compatErr instanceof Error ? compatErr.message : String(compatErr))
            errors.push(`TAAL ARC compatibility retry error: ${compatErr instanceof Error ? compatErr.message : String(compatErr)}`)
          }
        } else {
          errors.push(`TAAL ARC failed (${arcRes.status}): ${arcText.substring(0, 300)}`)
        }
      }
      }
    } catch (e) {
      this.logBroadcastStep(traceId, 'taal_arc', 'error', undefined, e instanceof Error ? e.message : String(e))
      this.noteBroadcastChannelBackoff('taal_arc', 30000, e instanceof Error ? e.message : String(e))
      errors.push(`TAAL ARC error: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Method 3: WhatsOnChain broadcast (final fallback)
    // WoC broadcasts directly to miners and does NOT share ARC's
    // double-spend conflict memory — this unblocks UTXOs that ARC
    // incorrectly flags as DOUBLE_SPEND_ATTEMPTED due to stale conflicts.
    try {
      if (this.isBroadcastChannelBackedOff('whatsonchain')) {
        errors.push('WoC broadcast skipped (ENDPOINT_BACKOFF)')
        this.logBroadcastStep(traceId, 'whatsonchain', 'skipped', 0, 'ENDPOINT_BACKOFF')
      } else {
      const wocStartedAt = Date.now()
      this.logBroadcastStep(traceId, 'whatsonchain', 'start', undefined, `timeout=${BROADCAST_FETCH_TIMEOUT_MS}ms`)
      const wocNetwork = WOC_NETWORK
      const wocHeaders = this.buildWhatsOnChainHeaders(true)

      const wocRes = await this.fetchWithTimeout(`https://api.whatsonchain.com/v1/bsv/${wocNetwork}/tx/raw`, {
        method: 'POST',
        headers: wocHeaders,
        body: JSON.stringify({ txhex: serializedTx })
      })
      const wocText = await wocRes.text().catch(() => '')
      if (wocRes.ok) {
        // WoC returns the txid as a plain string (with quotes)
        const txid = wocText.replace(/"/g, '').trim()
        if (/^[0-9a-fA-F]{64}$/.test(txid)) {
          this.logBroadcastStep(traceId, 'whatsonchain', 'accepted', Date.now() - wocStartedAt, `txid=${this.shortenToken(txid, 12)}`)
          console.log(`📡 WoC broadcast accepted: txid=${txid.substring(0, 12)}...`)
          this.clearBroadcastChannelBackoff('whatsonchain')
          return { txid, acceptedVia: 'whatsonchain' }
        }
        this.logBroadcastStep(traceId, 'whatsonchain', 'rejected', Date.now() - wocStartedAt, 'ok-without-accepted-txid')
        errors.push(`WoC returned unexpected response: ${wocText.substring(0, 200)}`)
      } else {
        this.logBroadcastStep(traceId, 'whatsonchain', `http_${wocRes.status}`, Date.now() - wocStartedAt)
        if (bsvConfig.logging.level !== 'error') {
          console.warn(`⚠️  WoC broadcast ${wocRes.status}: ${wocText.substring(0, 150)}`)
        }
        if (wocRes.status === 429) {
          this.noteBroadcastChannelBackoff('whatsonchain', WHATSONCHAIN_API_KEY ? 60000 : 120000, 'HTTP 429')
        } else if (wocRes.status >= 500) {
          this.noteBroadcastChannelBackoff('whatsonchain', 30000, `HTTP ${wocRes.status}`)
        }
        errors.push(`WoC broadcast failed (${wocRes.status}): ${wocText.substring(0, 300)}`)
      }
      }
    } catch (e) {
      this.logBroadcastStep(traceId, 'whatsonchain', 'error', undefined, e instanceof Error ? e.message : String(e))
      this.noteBroadcastChannelBackoff('whatsonchain', 30000, e instanceof Error ? e.message : String(e))
      errors.push(`WoC broadcast error: ${e instanceof Error ? e.message : String(e)}`)
    }

    // If we reach here, all methods failed.
    // Detect the specific "too-long-mempool-chain" transient condition — this resolves
    // automatically once the next block is mined and parent TXs are confirmed.
    const allErrors = errors.join('\n')
    const isMempoolChain = allErrors.includes('too-long-mempool-chain')
    if (isMempoolChain) {
      console.warn(`⏳ Mempool chain too long — waiting for next block to shorten the unconfirmed ancestor chain. Will retry automatically.`)
      throw new Error('MEMPOOL_CHAIN_LIMIT')
    }
    const isRateLimited = /429|TOO MANY REQUESTS|RATE LIMIT/i.test(allErrors)
    if (isRateLimited) {
      throw new Error(`BROADCAST_RATE_LIMITED\n${allErrors}`)
    }
    const isEndpointUnavailable = /BROADCAST_TIMEOUT|fetch failed|ENDPOINT_BACKOFF|ECONN|ENOTFOUND|ETIMEDOUT|TIMED OUT|NETWORK/i.test(allErrors)
    if (isEndpointUnavailable) {
      throw new Error(`BROADCAST_ENDPOINT_UNAVAILABLE\n${allErrors}`)
    }
    throw new Error(`All broadcast methods failed:\n${allErrors}`)
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number = BROADCAST_FETCH_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`BROADCAST_TIMEOUT:${timeoutMs}`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private p2pkhLockingScriptHexFromWif(wif: string): string {
    const key = SDKPrivateKey.fromWif(wif)
    const pubKeyHash = Buffer.from(key.toPublicKey().toHash())
    const opDup = '76'
    const opHash160 = 'a9'
    const push20 = '14'
    const opEqualVerify = '88'
    const opCheckSig = 'ac'
    const hashHex = pubKeyHash.toString('hex')
    return opDup + opHash160 + push20 + hashHex + opEqualVerify + opCheckSig
  }

  async sendToAddress(toAddress: string, amountSats: number): Promise<string> {
    try {
      if (!BSV_PRIVATE_KEY && !BSV_FALLBACK_WIF) {
        throw new Error('No private key configured')
      }
      this.ensureWallet()
      if (!this.wallet) {
        throw new Error('Wallet not initialized')
      }

      const fromAddress = this.wallet.getAddress()
      const utxos = await this.wallet.getUTXOs()
      if (!Array.isArray(utxos) || utxos.length === 0) {
        throw new Error('No UTXOs available')
      }

      // Sort by value descending and pick as many as needed
      const sorted = [...utxos].sort((a: any, b: any) => (b.value || 0) - (a.value || 0))
      const scriptFromAddr = (bsv.Script as any).fromAddress
        ? (bsv.Script as any).fromAddress(fromAddress).toHex()
        : this.p2pkhLockingScriptHexFromWif((this.wallet as any)['wif'])

      // Explicit-fee build (avoids bsv's pre-sign _estimateSize underestimate which would
      // produce ~22 sat/kB actual rate vs our 102.5 sat/kB target).
      // Size formula: BASE 12 + N inputs × 149 + 2 P2PKH outputs (recipient + change) × 34 = 88 + 149N
      const SEND_BASE_BYTES = 12 // version + locktime + in-count + out-count varints
      const SEND_INPUT_BYTES = 149 // signed P2PKH input
      const SEND_P2PKH_OUTPUT_BYTES = 34 // value (8) + scriptLen (1) + P2PKH script (25)
      const estimateSendBytes = (inputCount: number) => SEND_BASE_BYTES + inputCount * SEND_INPUT_BYTES + 2 * SEND_P2PKH_OUTPUT_BYTES
      const selected: any[] = []
      let totalInput = 0
      // Iteratively grow input set until inputs cover amount + the explicit fee for that input count.
      for (const u of sorted) {
        selected.push({
          txId: u.tx_hash,
          outputIndex: u.tx_pos,
          address: fromAddress,
          script: scriptFromAddr,
          satoshis: u.value,
        })
        totalInput += u.value
        const explicitFeeForCount = Math.ceil(estimateSendBytes(selected.length) * FEE_RATE_SAT_PER_BYTE)
        if (totalInput >= amountSats + explicitFeeForCount + DUST_LIMIT) break
      }
      const explicitFee = Math.ceil(estimateSendBytes(selected.length) * FEE_RATE_SAT_PER_BYTE)
      if (totalInput < amountSats + explicitFee + DUST_LIMIT) {
        throw new Error(`Insufficient UTXO value for requested amount + fee: input=${totalInput} need>=${amountSats + explicitFee + DUST_LIMIT}`)
      }

      const tx = new (bsv as any).Transaction()
        .from(selected)
        .to(toAddress, amountSats)
        .fee(explicitFee)
        .change(fromAddress)

      const signingKey = (bsv as any).PrivateKey.fromWIF((this.wallet as any)['wif'])
      tx.sign(signingKey)

      // Broadcast
      const p2pkhScriptDefault = this.p2pkhLockingScriptHexFromWif((this.wallet as any)['wif'])
      const prevoutsForArc = Array.isArray(selected) ? selected.map((u: any) => {
        const sats = Number(u?.satoshis ?? u?.value ?? 0)
        let scriptHex = ''
        try {
          const sc: any = u?.script
          if (typeof sc === 'string') scriptHex = sc
          else if (sc && typeof sc.toHex === 'function') scriptHex = sc.toHex()
        } catch {}
        if (!scriptHex) scriptHex = p2pkhScriptDefault
        return { lockingScript: scriptHex, satoshis: sats }
      }) : []
      const { txid } = await this.broadcastTransaction(tx.serialize(), prevoutsForArc)
      return txid
    } catch (error) {
      console.error('sendToAddress error:', error)
      throw error
    }
  }

  private async saveToDatabase(_transaction: TransactionLog): Promise<void> { /* deprecated */ }

  async getTransactionHistory(_stream?: string, _limit: number = 100): Promise<TransactionLog[]> {
    // DB history disabled in this path; return local in-memory log for now
    return this.getLocalTransactionLog()
  }

  getLocalTransactionLog(): TransactionLog[] {
    return [...this.transactionLog]
  }

  public getAndResetBroadcastCount(): number {
    const n = this.broadcastCountSinceLastSample
    this.broadcastCountSinceLastSample = 0
    return n
  }

  async verifyTransaction(txid: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.whatsonchain.com/v1/bsv/${WOC_NETWORK}/tx/${txid}/raw`,
        { headers: this.buildWhatsOnChainHeaders() }
      )

      return response.ok
    } catch (error) {
      console.error('Error verifying transaction:', error)
      return false
    }
  }

  // Cleanup method to stop batch logging
  destroy(): void {
    if (this.summaryIntervalId) {
      clearInterval(this.summaryIntervalId)
      this.summaryIntervalId = null
    }
    if (this.confirmationSchedulerId) {
      clearInterval(this.confirmationSchedulerId)
      this.confirmationSchedulerId = null
    }
    this.pendingConfirmationByTxid.clear()
    this.pendingConfirmationHeap = []
  }
}

// Persist singleton on globalThis to survive Next.js dev-mode module
// re-evaluations that would otherwise create duplicate service instances.
const _bs = globalThis as any
if (!_bs.__GAIALOG_BLOCKCHAIN_SERVICE__) {
  _bs.__GAIALOG_BLOCKCHAIN_SERVICE__ = new BlockchainService()
}
export const blockchainService: BlockchainService = _bs.__GAIALOG_BLOCKCHAIN_SERVICE__
