import * as v8 from 'v8'
import { createHash } from 'crypto'
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import {
  buildOpReturnTx,
  buildPaymentTx,
  p2pkhLockingScriptHexFromWif as p2pkhLockingScriptHexFromWifSdk,
  type TxInputSpec,
} from './broadcast/tx-builder'
import {
  getBroadcasterCallbackToken,
  getCachedPolicyFeeRateSatPerByte,
  recordBroadcasterAcceptance,
  submitTransaction,
  type AcceptedOutcome,
} from './broadcast/broadcaster-client'
// DB write via repositories (Postgres)
import { upsertTxLog } from './repositories'
import { DEFAULT_TX_FEE_RATE, bsvConfig } from './bsv-config'
import { APP_NAME, SCHEMA_VERSION } from './constants'
// Data credibility features
import { dataValidator, qualityScorer } from './validation'
import { createCredibilityBuilder } from './pipeline-integrity'
import type { CredibilityMetadata } from './types/credibility'
// Explorer store – routed through the read-source switcher (legacy / dual / overlay)
import { addReading, canAttemptExplorerWrite, type StoredReading } from './explorer-read-source'
import { getSpendSourceForWallet, getTreasuryTopicForWallet, getWalletIndexForAddress, type SpendableOutput } from './spend-source'
import { acquirePoolUtxo, consumeAndAdmitChange, releaseUtxo, type InventoryUtxo } from './utxo-inventory'
import { getMinSpendConfirmations } from './utxo-spend-policy'
import {
  logOverlayEmptyListDrift,
  logOverlayUnconfirmedOnlyBlocked,
} from './utxo-overlay-monitor'
import { QueueLane, resolveProviderIdFromSource, resolveSourceLabel } from './stream-registry'
import { throughputObservability } from './throughput-observability'
import { upsertArcBroadcastStatus } from './arc-broadcast-status'
import { classifyArcTxStatus, type ArcPhase, type ArcStatusProvider } from './arc-tx-status'

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
// Fee-rate floor for every transaction this service builds.
//
// The live rate is read from the BSV Broadcaster (`GET /policy`) through
// `getCachedPolicyFeeRateSatPerByte` and held by `resolveFeeRateForBuild`,
// which takes the highest rate across reachable hosts and refreshes it in the
// background so a write never waits on it. This constant is the floor and the
// fallback when no host can be reached: `DEFAULT_TX_FEE_RATE` (0.15 sat/byte)
// clears the 0.1 sat/byte network floor with headroom.
const FEE_RATE_SAT_PER_BYTE = (() => {
  const configured = Number(
    process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE,
  )
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TX_FEE_RATE
})()
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
// Maximum OP_RETURN payload size in bytes, before script assembly.
//
// BSV's practical ceiling for a single non-standard transaction is far above
// this; the cap exists to stop a runaway payload (an unbounded provider array,
// a credibility blob, a mis-serialised object) from being built, signed and
// broadcast as a multi-megabyte transaction that the operators then have to
// pay for. Large enough that every legitimate reading fits, small enough that
// a bug fails at build time with a named error rather than at broadcast.
const BSV_MAX_OPRETURN_BYTES = (() => {
  const raw = Number(process.env.BSV_MAX_OPRETURN_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90_000
})()
const HEAP_GUARD_HIGH_WATERMARK = Math.min(0.98, Math.max(0.5, Number(process.env.BSV_HEAP_GUARD_HIGH_WATERMARK || 0.82)))
const HEAP_GUARD_PAUSE_MS = Math.max(5000, Number(process.env.BSV_HEAP_GUARD_PAUSE_MS || 30000))
const HEAP_GUARD_MAX_BYTES = Math.max(0, Number(process.env.BSV_HEAP_GUARD_MAX_BYTES || 0))

// Supabase client removed; we persist via Postgres repositories (tx_log)

/**
 * Locally computed transaction id for a signed transaction's hex.
 *
 * Double SHA-256 of the serialised transaction, byte-reversed — the definition
 * every BSV node and broadcaster uses. Computed here from the hex we are about
 * to send, so a broadcaster's echoed txid can be checked against the actual
 * transaction rather than trusted.
 */
function computeTxidFromHex(txHex: string): string | null {
  try {
    const bytes = Buffer.from(txHex, 'hex')
    if (bytes.length === 0) return null
    return createHash('sha256')
      .update(createHash('sha256').update(bytes).digest())
      .digest()
      .reverse()
      .toString('hex')
  } catch {
    return null
  }
}

/** Ceiling on the fee-retry multiplier, whatever the environment asks for. */
const BROADCAST_FEE_RETRY_MAX = 3

/**
 * Fee multiplier applied once when the broadcaster answers 465 (fee too low).
 *
 * 1.5x on a 0.15 sat/byte build is 0.225 sat/byte, comfortably above the live
 * floor without paying an order of magnitude over it. Overridable, and clamped
 * so a misconfigured value cannot produce an absurd fee on the rebuild.
 */
const BROADCAST_FEE_RETRY_MULTIPLIER = (() => {
  const configured = Number(process.env.BSV_BROADCASTER_FEE_RETRY_MULTIPLIER)
  const multiplier = Number.isFinite(configured) && configured > 1 ? configured : 1.5
  return Math.min(multiplier, BROADCAST_FEE_RETRY_MAX)
})()

/**
 * Terminal statuses the broadcaster uses for a transaction it has judged.
 * Presence of one means the answer is about these bytes, not about a mismatch.
 */
const TERMINAL_TX_STATUSES = new Set([
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'EVICTED',
  'DOUBLE_SPEND_ATTEMPTED',
])

/**
 * True when a terminal outcome leaves the network state of OUR transaction
 * unknown, which is the one case where the input must be quarantined rather
 * than released.
 *
 * The distinguishing signal is structural, not textual: a 2xx response whose
 * status says the transaction was accepted, paired with a terminal verdict,
 * means the host acknowledged something other than the bytes we signed (a
 * truncated echo, a truncated txid, a response for a different txid). A 4xx —
 * or a 2xx carrying a rejection status — is a verdict about our bytes, and
 * releasing the input is safe because nothing of ours was relayed.
 */
function terminalOutcomeLeavesStateUnknown(outcome: {
  httpStatus: number
  txStatus: string | null
}): boolean {
  if (outcome.httpStatus < 200 || outcome.httpStatus >= 300) return false
  const status = (outcome.txStatus ?? '').trim().toUpperCase()
  return !TERMINAL_TX_STATUSES.has(status)
}

/**
 * Which status provider an accepted submission came from.
 *
 * Only the Broadcaster's own verdict makes `DOUBLE_SPEND_ATTEMPTED` terminal.
 * A degraded acceptance came from a relay that does not track lifecycle, so it
 * takes the cautious ARC branch and holds the inputs.
 */
function arcStatusProviderForAcceptance(outcome: AcceptedOutcome): ArcStatusProvider {
  return outcome.degraded ? 'arc' : 'broadcaster'
}

/**
 * True when an error is a deterministic rejection that retrying cannot fix.
 *
 * `TERMINAL_BROADCAST_ERROR` covers malformed scripts, invalid signatures and
 * double spends: every host validates the same bytes against the same
 * consensus rules, so a retry repeats the same rejection. Used to skip the
 * retry ladder rather than burn attempts on a payload that can never be mined.
 */
export function isTerminalBroadcastError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /TERMINAL_BROADCAST_ERROR/.test(message)
}

/** True when the broadcaster reported the fee as below its policy floor. */
export function isFeeTooLowBroadcastError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /FEE_TOO_LOW|fee too low|\b465\b/i.test(message)
}

/**
 * True when the endpoint asked for a delay (503/429/476) rather than judging the transaction. */
export function isEndpointBackoffError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /ENDPOINT_BACKOFF|BROADCASTER_BACKPRESSURE/.test(message)
}

/**
 * The fee rate used to build the next transaction.
 *
 * `getCachedPolicyFeeRateSatPerByte` is the source of truth, but it fans out a
 * `GET /policy` to every host when its 60-second cache expires. `writeToChain`
 * runs once per reading, so calling it directly would mean a burst of writes
 * arriving just after expiry each pays up to a 4-second timeout — and, worse,
 * fires its own set of requests, since the client dedupes nothing in flight.
 *
 * So the resolved rate is held here and reused until a refresh completes. A
 * stale rate is safe by construction: the builder adds a safety multiplier and
 * the write path retries a 465 rejection once at 1.5x. A missing rate (first
 * write after process start) is the only case that waits, and concurrent
 * first writes share one fetch.
 */
let cachedEffectiveFeeRate: number | null = null
let cachedEffectiveFeeRateAt = 0
let feeRateRefreshInFlight: Promise<void> | null = null
const FEE_RATE_REFRESH_INTERVAL_MS = 60_000

function refreshEffectiveFeeRateInBackground(): void {
  if (feeRateRefreshInFlight) return
  feeRateRefreshInFlight = getCachedPolicyFeeRateSatPerByte(FEE_RATE_SAT_PER_BYTE)
    .then(rate => {
      if (Number.isFinite(rate) && rate > 0) {
        cachedEffectiveFeeRate = rate
        cachedEffectiveFeeRateAt = Date.now()
      }
    })
    .catch(() => {
      // Keep the last known rate; the floor is still a valid build value.
    })
    .finally(() => {
      feeRateRefreshInFlight = null
    })
}

/**
 * The fee rate to build at, without adding network latency to a write.
 *
 * Returns the cached rate immediately when one exists and refreshes it in the
 * background once it ages past the client's own cache window. Only a process
 * with no rate yet waits, and only for one fetch.
 */
async function resolveFeeRateForBuild(): Promise<number> {
  const fresh = cachedEffectiveFeeRate != null
    && Date.now() - cachedEffectiveFeeRateAt < FEE_RATE_REFRESH_INTERVAL_MS
  if (fresh) return cachedEffectiveFeeRate as number
  if (cachedEffectiveFeeRate != null && cachedEffectiveFeeRate > 0) {
    // Serve the stale rate now; the refresh lands before the next build.
    refreshEffectiveFeeRateInBackground()
    return cachedEffectiveFeeRate
  }

  refreshEffectiveFeeRateInBackground()
  await feeRateRefreshInFlight
  return cachedEffectiveFeeRate ?? FEE_RATE_SAT_PER_BYTE
}

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

  /**
   * Best-effort channel attribution for observability.
   *
   * Broadcasts go through the BSV Broadcaster's host ladder first, with the
   * legacy ARC relays only as a transport-level fallback; the labels here match
   * what an operator sees in the logs.
   */
  private detectBroadcastChannel(message: string): string {
    const safe = String(message || '').toUpperCase()
    if (safe.includes('BSV_BROADCASTER') || safe.includes('ARCADE-')) return 'bsv_broadcaster'
    if (safe.includes('GORILLAPOOL')) return 'gorillapool_arc'
    if (safe.includes('TAAL')) return 'taal_arc'
    if (safe.includes('WHATSONCHAIN') || safe.includes('WOC')) return 'whatsonchain'
    return 'unknown'
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

  private enqueueConfirmationCheck(_txid: string, _streamType: string): void {
    // ARC status poller owns post-broadcast phase advancement. Do not enqueue
    // WhatsOnChain confirmation checks or allow cleanUpFailedTx to delete rows.
    return
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
    this.pendingConfirmationByTxid.clear()
    this.pendingConfirmationHeap.length = 0
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
    let acceptedTxStatus: string | undefined
    let acceptedPhase: ArcPhase = 'pending'
    let actualFeeSats: number | undefined
    let fromAddress = '' // hoisted so outer catch can signal per-wallet backoff
    try {
      if (this.shouldTraceTimings()) {
        console.log(`⏱️ writeToChain start trace=${traceId} stream=${data.stream}`)
      }
      // Check if blockchain is configured
      if (!BSV_PRIVATE_KEY && !BSV_FALLBACK_WIF) {
        // Throwing rather than returning a sentinel string. The previous
        // `return 'blockchain-not-configured'` was indistinguishable from a
        // real txid to every caller that only checked for a non-empty string,
        // so a misconfigured deployment recorded readings as broadcast and
        // linked them to a txid that does not exist. A throw reaches the
        // caller's failure path, where it is retried or recorded as a failure.
        console.warn('⚠️ Blockchain private key not configured; refusing to build a transaction')
        throw new Error('BLOCKCHAIN_NOT_CONFIGURED: no signing keys available')
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

      // Rename WAQI-style fields for clarity on-chain. Everything not renamed is
      // carried through unchanged: the earlier form rebuilt the payload from a
      // fixed list, which silently dropped so2, temperature_c, humidity_pct,
      // pressure_mb, wind_kph, wind_deg, coordinates and any other field the
      // collector had attached.
      let payloadOut: any = sanitizedPayload
      try {
        if (data.stream === 'air_quality' && sanitizedPayload && typeof sanitizedPayload === 'object') {
          const {
            aqi,
            pm25,
            pm10,
            co,
            no2,
            o3,
            ...rest
          } = sanitizedPayload as Record<string, any>
          payloadOut = {
            ...rest,
            air_quality_index: aqi,
            fine_particulate_matter_pm25: pm25,
            coarse_particulate_matter_pm10: pm10,
            carbon_monoxide: co,
            nitrogen_dioxide: no2,
            ozone: o3,
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
      //
      // Size is checked before the script is assembled and before any UTXO is
      // acquired, so an oversized payload costs nothing and fails with a named
      // error instead of producing a transaction that ARC rejects for size.
      if (payloadBytes.length > BSV_MAX_OPRETURN_BYTES) {
        throw new Error(
          `OPRETURN_PAYLOAD_TOO_LARGE: ${payloadBytes.length} bytes exceeds the ` +
            `${BSV_MAX_OPRETURN_BYTES}-byte limit (BSV_MAX_OPRETURN_BYTES) for stream=${data.stream}`,
        )
      }
      const scriptHex = buildOpFalseOpReturnWithTag({
        tag: 'GaiaLog',
        version: 'v1',
        payload: payloadBytes,
        extra: extras,
        useTrueReturn,
      })
      const opReturnBytes = scriptHex.length / 2
      const opReturnOutputSats = useTrueReturn ? 1 : 0

      // The fee rate comes from the broadcaster's own `/policy`, cached for 60s
      // and taken as the maximum across reachable hosts. Building at that rate
      // means one signed transaction clears the floor at every host in the
      // ladder, which matters because a fee rejection is terminal and cannot be
      // retried more cheaply elsewhere.
      const effectiveFeeRate = await resolveFeeRateForBuild()

      // Deterministic size model: version + locktime + in-count + out-count
      // (10), one worst-case signed P2PKH input (149), the OP_RETURN output
      // envelope and body, and a 34-byte P2PKH change output.
      const BASE_WITH_CHANGE = 44
      const INPUT_SIGNED = 149
      const estimateOpReturnTxSize = (inputCount: number): number => {
        const opReturnOutputEnvelope = 8 + (opReturnBytes < 253 ? 1 : 3)
        return BASE_WITH_CHANGE + inputCount * INPUT_SIGNED + opReturnOutputEnvelope + opReturnBytes
      }

      // 1.2x safety multiplier on the per-tx minimum stops the acquire layer
      // handing back a UTXO so close to the threshold that signature variance
      // (70-72 byte DER) pushes the transaction under the fee floor.
      const minInputSatoshis = Math.max(
        UTXO_POOL_MIN_SATS,
        Math.ceil(
          (opReturnOutputSats + Math.ceil(estimateOpReturnTxSize(1) * effectiveFeeRate) + DUST_LIMIT) *
            1.2,
        ),
      )

      // Smallest change output that is worth creating at all.
      //
      // Auto-consolidation spends roughly one input per dust row, so a row worth
      // less than about three consolidation-input fees cannot pay for its own
      // sweep. Change below `minInputSatoshis` is still real money — it just
      // cannot fund a write — so it is admitted as `dust` for consolidation to
      // collect. Change below this floor is genuinely uneconomic and is folded
      // into the fee instead, which loses strictly less than stranding it.
      //
      // Clamped to `minInputSatoshis`: if the acquire threshold were ever lower
      // than three input fees, a change output large enough to fund a write
      // would otherwise be swallowed as fee, which is the exact waste this
      // constant exists to prevent.
      const minConsolidatableDustSats = Math.min(
        minInputSatoshis,
        Math.ceil(INPUT_SIGNED * effectiveFeeRate * 3),
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

      const scriptPubKey =
        acquiredUtxo.output_script || p2pkhLockingScriptHexFromWifSdk(wif)

      // Exactly one input: the UTXO the acquisition layer locked for us.
      const inputSpec: TxInputSpec = {
        txid: acquiredUtxo.txid,
        vout: acquiredUtxo.vout,
        satoshis: Number(acquiredUtxo.satoshis),
        lockingScriptHex: scriptPubKey,
      }

      /**
       * Build and sign the OP_RETURN transaction at a given fee multiplier.
       *
       * The fee is passed explicitly (`explicitFeeSats`) rather than letting the
       * builder derive it, because the rate that matters is the broadcaster's
       * own live `/policy` rate, which the builder cannot see from a worker. The
       * size estimate uses the conservative 149-byte signed input, so the fee is
       * an upper bound on what the signed transaction needs — it can never come
       * out one satoshi under the floor because a DER signature ran long.
       */
      const buildOpReturn = async (feeMultiplier: number) => {
        const explicitFeeSats = Math.ceil(
          estimateOpReturnTxSize(1) * effectiveFeeRate * feeMultiplier,
        )
        const built = await buildOpReturnTx({
          wif,
          inputs: [inputSpec],
          opReturnScriptHex: scriptHex,
          opReturnSats: opReturnOutputSats,
          changeAddress: address,
          explicitFeeSats,
          // The builder folds any remainder below the change floor into the fee,
          // so "no change output" and "uneconomic remainder" are the same case.
          emitChange: true,
          changeFloorSats: minConsolidatableDustSats,
        })
        const change = built.outputs.find(output => output.isChange) ?? null
        return {
          built,
          change,
          // Change large enough for a later write to acquire is pool inventory.
          // Smaller (but still sweepable) change is dust, which consolidation
          // collects and returns to reserve — keeping it out of the pool.
          changeRole: change == null
            ? null
            : (change.satoshis >= minInputSatoshis ? 'pool' as const : 'dust' as const),
        }
      }

      let normalHex = ''
      let changeOutput: { vout: number; satoshis: number; outputScript: string } | null = null
      let changeRole: 'pool' | 'dust' | null = null
      let acceptedOutcome: AcceptedOutcome | null = null
      // Set when the broadcaster's txid disagrees with the transaction we built.
      // The catch block must then quarantine the input rather than release it:
      // the signed transaction may be on the network, so returning its input to
      // the pool invites a second spend of it.
      let txidMismatch = false
      const prevoutSpecs = [{ lockingScript: scriptPubKey, satoshis: Number(acquiredUtxo.satoshis) }]
      try {
        const buildStartedAt = Date.now()
        let prepared = await buildOpReturn(1)
        txBuildMs = Date.now() - buildStartedAt

        const broadcastStartedAt = Date.now()
        let outcome = await submitTransaction({
          efBytes: prepared.built.efBytes,
          rawHex: prepared.built.rawHex,
          expectedTxid: prepared.built.txid,
          callbackToken: getBroadcasterCallbackToken(),
          allowLegacyFallback: true,
        })

        // 465 means the fee was under the current floor — the policy rate moved
        // between the cached read and the submission. Rebuilding the SAME
        // outpoint at a higher multiplier retries cheaply; acquiring a fresh
        // UTXO instead would pay a second full transaction for the same reading.
        if (outcome.kind === 'fee-too-low') {
          console.warn(
            `⚠️  Broadcaster rejected fee as too low (465) for trace=${traceId} at ` +
              `${effectiveFeeRate.toFixed(3)} sat/byte; rebuilding the same input at ` +
              `${BROADCAST_FEE_RETRY_MULTIPLIER}x and retrying once`,
          )
          const rebuildStartedAt = Date.now()
          prepared = await buildOpReturn(BROADCAST_FEE_RETRY_MULTIPLIER)
          txBuildMs += Date.now() - rebuildStartedAt
          // The rebuild's submit time is the one that counts as broadcast time.
          const retrySubmitStartedAt = Date.now()
          outcome = await submitTransaction({
            efBytes: prepared.built.efBytes,
            rawHex: prepared.built.rawHex,
            expectedTxid: prepared.built.txid,
            callbackToken: getBroadcasterCallbackToken(),
            allowLegacyFallback: true,
          })
          broadcastMs = Date.now() - retrySubmitStartedAt
        } else {
          broadcastMs = Date.now() - broadcastStartedAt
        }

        normalHex = prepared.built.rawHex
        actualFeeSats = prepared.built.feeSats
        changeOutput = prepared.change
          ? {
              vout: prepared.change.vout,
              satoshis: prepared.change.satoshis,
              outputScript: prepared.change.outputScript,
            }
          : null
        changeRole = prepared.changeRole

        if (outcome.kind === 'terminal') {
          if (outcome.doubleSpend) {
            throw new Error(`DOUBLE_SPEND_ATTEMPTED: ${outcome.message}`)
          }
          // A 2xx response that carries no verdict about these bytes means the
          // host acknowledged something else, so our transaction may still be
          // propagating. That is the one case where the input must be
          // quarantined rather than released — releasing it invites a second
          // spend of an outpoint that may already be spent.
          if (terminalOutcomeLeavesStateUnknown(outcome)) {
            txidMismatch = true
            throw new Error(`TXID_MISMATCH: ${outcome.message}`)
          }
          throw new Error(
            `TERMINAL_BROADCAST_ERROR: broadcaster rejected the transaction` +
              `${outcome.code != null ? ` (code ${outcome.code})` : ''}` +
              `${outcome.txStatus ? ` [${outcome.txStatus}]` : ''} from ${outcome.host}: ${outcome.message}`,
          )
        }

        if (outcome.kind === 'non-final') {
          // 476: the locktime has not passed yet. Nothing is wrong with the
          // transaction; it becomes valid later, so the caller must retry.
          throw new Error(
            `ENDPOINT_BACKOFF: transaction not final yet (476 locktime) from ${outcome.host}: ${outcome.message}`,
          )
        }

        if (outcome.kind === 'fee-too-low') {
          // Already retried once at a higher multiplier above.
          throw new Error(
            `FEE_TOO_LOW: broadcaster rejected the rebuilt transaction as under-paying ` +
              `(${outcome.code}) at ${effectiveFeeRate.toFixed(3)} sat/byte: ${outcome.message}`,
          )
        }

        if (outcome.kind === 'pending-retry') {
          // Nothing was learned about the transaction: the host asked us to come
          // back later. Retryable, and the input is still unspent.
          throw new Error(
            `ENDPOINT_BACKOFF: ${outcome.reason} (retry in ${Math.round(outcome.retryAfterMs / 1000)}s)`,
          )
        }

        if (outcome.kind === 'transport') {
          throw new Error(`BROADCAST_ENDPOINT_UNAVAILABLE: ${outcome.reason}`)
        }

        // accepted — either the Broadcaster itself or a degraded relay fallback.
        if (outcome.txid.toLowerCase() !== prepared.built.txid.toLowerCase()) {
          txidMismatch = true
          console.error(
            `❌ Txid mismatch for trace=${traceId}: accepted=${outcome.txid.substring(0, 16)}... ` +
              `local=${prepared.built.txid.substring(0, 16)}... (via ${outcome.host}); rejecting broadcast`,
          )
          throw new Error(
            `TXID_MISMATCH: broadcaster returned ${outcome.txid.slice(0, 16)}... but the signed ` +
              `transaction hashes to ${prepared.built.txid.slice(0, 16)}...`,
          )
        }

        acceptedOutcome = outcome
        acceptedVia = outcome.degraded
          ? (outcome.legacyProvider ?? 'legacy_relay')
          : 'bsv_broadcaster'
        acceptedTxid = outcome.txid
        // The provider is what decides how DOUBLE_SPEND_ATTEMPTED classifies: a
        // broadcaster rejection is final, an ARC report is not. `AcceptedOutcome`
        // carries the split as `degraded`/`legacyProvider`, so the classifier's
        // provider is derived from those rather than read from a field.
        acceptedTxStatus = outcome.txStatus
        acceptedPhase = classifyArcTxStatus(
          outcome.txStatus,
          arcStatusProviderForAcceptance(outcome),
        )
      } catch (innerErr) {
        if (txidMismatch && inventoryBacked) {
          // Unknown network state: quarantine so the input cannot be acquired
          // and spent again. The local txid is the true id of the transaction
          // that was built and submitted.
          const localTxid = computeTxidFromHex(normalHex) || acceptedTxid || ''
          await this.quarantineSpentOutpoint({
            topic: acquiredUtxo.topic,
            txid: acquiredUtxo.txid,
            vout: acquiredUtxo.vout,
            spendingTxid: localTxid,
          })
        } else if (inventoryBacked) {
          // Cooldown so a UTXO whose broadcast just failed (commonly ARC 460
          // "parent transaction not found" in chain-of-unconfirmed conditions)
          // is not instantly re-acquired by the next worker and rejected for
          // the same reason. Reuses the propagation-grace window by default.
          const cooldownMs = (() => {
            const raw = Number(process.env.BSV_PROPAGATION_GRACE_MS)
            return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2500
          })()
          await releaseUtxo(acquiredUtxo.topic, acquiredUtxo.txid, acquiredUtxo.vout, { cooldownMs })
        } else {
          this.releaseUtxos([acquiredUtxoKey])
        }
        throw innerErr
      }

      const txid = acceptedTxid!

      // Persist the acceptance. Runs outside the broadcast try/catch on purpose:
      // this is a bookkeeping write about a transaction the network has already
      // accepted, and letting it run inside the block meant a failure here
      // released the spent input back to the pool — an accepted transaction
      // whose input was offered up for a second spend.
      //
      // `recordBroadcasterAcceptance` writes the fields the SSE subscriber and
      // the reconciler depend on: `accepted_endpoint`, `provider`,
      // `callback_token`, `merkle_path` and the block it commits to. It sets
      // `provider: 'broadcaster'`, so the reconciler queries the right host for
      // this txid instead of an ARC endpoint that has never heard of it.
      try {
        if (acceptedOutcome) {
          await recordBroadcasterAcceptance(acceptedOutcome)
        } else {
          // Defensive: an acceptance with no outcome should not be reachable.
          await upsertArcBroadcastStatus({
            txid,
            txStatus: acceptedTxStatus,
            acceptedVia: acceptedVia!,
          })
        }
      } catch (statusErr) {
        console.warn(
          `⚠️  Could not persist broadcast status for ${txid.substring(0, 12)}...: ` +
            `${statusErr instanceof Error ? statusErr.message : String(statusErr)}. ` +
            `Broadcast succeeded; the status poller will pick this txid up from tx_log.`,
        )
      }

      if (inventoryBacked) {
        // Spend the input and admit the change. This must succeed: the
        // transaction is already on the network and has paid for the input, so
        // a failure here means the overlay still believes the input is
        // available.
        //
        // The previous behaviour logged and continued, which left the spent
        // outpoint in `removed = false, locked = <this worker>`. Once the lock
        // aged past reapStaleLocks' 15 minutes, the reaper freed it and the
        // next write happily acquired and re-spent a UTXO that was already
        // spent — a guaranteed txn-mempool-conflict, and a change output that
        // was never recorded at all.
        //
        // One immediate retry covers a transient connection loss during the
        // commit. If it still fails, fall back to a direct, minimal UPDATE that
        // marks the outpoint spent. That needs no change row and no topic
        // counter, so it is far more likely to succeed than the full call, and
        // it removes the row from the reaper's reach permanently.
        const admitArgs = {
          topic: acquiredUtxo.topic,
          walletIndex: walletIndexForLog,
          spentTxid: acquiredUtxo.txid,
          spentVout: acquiredUtxo.vout,
          spendingTxid: txid,
          rawTx: normalHex,
          phase: acceptedPhase,
          change: changeOutput ? {
            vout: changeOutput.vout,
            satoshis: changeOutput.satoshis,
            outputScript: changeOutput.outputScript,
            confirmed: false,
            // `dust` keeps sub-floor change out of the pool (no acquisition will
            // ever take it) while making it visible to the consolidation sweep,
            // which returns it to `reserve`. `pool` is only for change a later
            // write can actually acquire.
            utxoRole: changeRole ?? ('pool' as const),
          } : null,
        }
        try {
          await consumeAndAdmitChange(admitArgs)
        } catch (firstErr) {
          const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
          console.warn(
            `⚠️  Inventory consume/admit failed for ${txid.substring(0, 12)}... (${firstMsg}); retrying once`,
          )
          try {
            await consumeAndAdmitChange(admitArgs)
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
            console.error(
              `❌ Inventory consume/admit failed twice for ${txid.substring(0, 12)}...: ${retryMsg}. ` +
                `Quarantining spent outpoint ${acquiredUtxo.txid}:${acquiredUtxo.vout} so it cannot be re-spent.`,
            )
            await this.quarantineSpentOutpoint({
              topic: acquiredUtxo.topic,
              txid: acquiredUtxo.txid,
              vout: acquiredUtxo.vout,
              spendingTxid: txid,
            })
          }
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
              prevouts: prevoutSpecs,
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
            // The resolved provider label, not the raw payload source. The
            // previous form wrote `payload.source || 'unknown'`, which is
            // 'unknown' for every family whose collector does not stamp a
            // `source` into the payload — including all thirteen that do not
            // go through the legacy four. providerValue is already derived
            // earlier in this method from providerId + datasetId + payload.
            provider: providerValue,
            collected_at: new Date(data.timestamp),
            status: 'pending',
            onchain_at: new Date(),
            // actualFee is measured from the signed transaction in
            // buildSignedTransaction (input sats minus output sats). It was
            // computed and then discarded, so tx_log.fee_sats was always null
            // and the fee actually paid was unrecoverable after the fact.
            fee_sats: actualFeeSats ?? null,
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
      // Retryable conditions: the transaction was never judged invalid, the
      // network or the wallet just could not serve it this time. A terminal
      // rejection is deliberately absent — that one is worth a full log line and
      // a `failed` tx_log row, because it will never be mined as built.
      const transient = /already reserved|No UTXOs available across wallets|No inventory UTXOs available across wallets|No emergency spendable UTXOs available across wallets|No reservable UTXO|MEMPOOL_CHAIN_LIMIT|txn-mempool-conflict|DOUBLE_SPEND|HEAP_PRESSURE_BACKOFF|ENDPOINT_BACKOFF|BROADCASTER_BACKPRESSURE|FEE_TOO_LOW|BROADCAST_ENDPOINT_UNAVAILABLE|BROADCAST_RATE_LIMITED/i.test(msg)
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
      } else if (isEndpointBackoffError(error)) {
        console.warn(`⏳ Broadcaster asked for a delay; the UTXO is held for retry: ${msg.split('\n')[0].substring(0, 160)}`)
      } else if (isFeeTooLowBroadcastError(error)) {
        console.warn(`⚠️  Fee under policy after a rebuild at a higher multiplier: ${msg.split('\n')[0].substring(0, 160)}`)
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
   * Mark a spent outpoint as removed in the overlay inventory, without touching
   * its change output or topic counters.
   *
   * Last-resort path after {@link consumeAndAdmitChange} has failed twice. The
   * transaction is already on the network, so the outpoint is spent whether the
   * overlay knows it or not. Leaving the row in place means `reapStaleLocks`
   * eventually clears its lock and the pool offers it again — a UTXO that is
   * provably gone, which produces `txn-mempool-conflict` on every retry.
   *
   * Deliberately minimal: one UPDATE on one row plus the topic counter, no
   * change row, no joins. Marking the row removed is the part of the full
   * admission that must not be lost, and the part least likely to fail under
   * the conditions that caused the original failure.
   *
   * Failure here is logged, not thrown. The broadcast already succeeded; the
   * caller's contract is that the transaction is on-chain, and turning an
   * inventory-bookkeeping failure into a failed write would only cause a
   * duplicate broadcast of a transaction that has already been paid for.
   */
  private async quarantineSpentOutpoint(input: {
    topic: string
    txid: string
    vout: number
    spendingTxid: string
  }): Promise<boolean> {
    try {
      const { withOverlayTransaction, refreshTopicCounts } = await import('./overlay-repository')
      await withOverlayTransaction(async (client) => {
        await client.query(`SET LOCAL statement_timeout = 15000`)
        const res = await client.query(
          `UPDATE overlay_admitted_utxos
              SET removed = true,
                  spending_txid = $4,
                  removed_at = now(),
                  locked = false,
                  locked_by = NULL,
                  locked_at = NULL
            WHERE topic = $1
              AND txid = $2
              AND vout = $3
              AND removed = false`,
          [input.topic, input.txid, input.vout, input.spendingTxid],
        )
        // Keep overlay_topic_counts consistent with the row we just removed.
        // Gated on rowCount so a row already removed by a partially-successful
        // admission attempt is not double-counted.
        if ((res.rowCount || 0) > 0) {
          await refreshTopicCounts(client, input.topic, -1)
        }
      })
      console.warn(
        `🛡️  Quarantined spent outpoint ${input.txid}:${input.vout} (spent by ${input.spendingTxid.substring(0, 12)}...) — ` +
          `it can no longer be re-acquired by the pool.`,
      )
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(
        `❌ Quarantine of spent outpoint ${input.txid}:${input.vout} failed: ${msg}. ` +
          `This outpoint is spent and remains acquirable — manual reconciliation required.`,
      )
      return false
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

  /**
   * Send value to one or more addresses from a wallet this service controls.
   *
   * A thin wrapper over `buildPaymentTx` + `submitTransaction` so no caller
   * needs to know which network path is current. Change returns to the signing
   * wallet and is subject to the same dust floor as the write path: a remainder
   * too small for consolidation pays the fee rather than becoming an output
   * nothing will ever spend.
   */
  private async sendPayment(input: {
    wif: string
    fromAddress: string
    outputs: Array<{ address: string; satoshis: number }>
    utxos: Array<{ txid: string; vout: number; satoshis: number; lockingScriptHex: string }>
  }): Promise<{ txid: string; acceptedVia: string; txStatus: string }> {
    const effectiveFeeRate = await resolveFeeRateForBuild()

    // One recipient output plus change, with a worst-case signed input each.
    const estimatedBytes = 10 + input.utxos.length * 149 + (input.outputs.length + 1) * 34

    const built = await buildPaymentTx({
      wif: input.wif,
      inputs: input.utxos.map(utxo => ({
        txid: utxo.txid,
        vout: utxo.vout,
        satoshis: utxo.satoshis,
        lockingScriptHex: utxo.lockingScriptHex,
      })),
      outputs: input.outputs,
      changeAddress: input.fromAddress,
      explicitFeeSats: Math.ceil(estimatedBytes * effectiveFeeRate),
      // Same three-inputs-worth-of-fee floor the write path uses, so a payment
      // cannot leave behind change that only consolidation could ever collect.
      changeFloorSats: Math.ceil(149 * effectiveFeeRate * 3),
    })

    const outcome = await submitTransaction({
      efBytes: built.efBytes,
      rawHex: built.rawHex,
      expectedTxid: built.txid,
      callbackToken: getBroadcasterCallbackToken(),
      allowLegacyFallback: true,
    })

    if (outcome.kind === 'accepted') {
      await recordBroadcasterAcceptance(outcome)
      return {
        txid: outcome.txid,
        acceptedVia: outcome.degraded ? (outcome.legacyProvider ?? 'legacy_relay') : 'bsv_broadcaster',
        txStatus: outcome.txStatus,
      }
    }

    if (outcome.kind === 'terminal') {
      const competing = outcome.doubleSpend ? 'DOUBLE_SPEND_ATTEMPTED: ' : ''
      const code = outcome.code != null ? ' (code ' + String(outcome.code) + ')' : ''
      throw new Error('TERMINAL_BROADCAST_ERROR: ' + competing + outcome.message + code)
    }
    if (outcome.kind === 'fee-too-low') {
      throw new Error('FEE_TOO_LOW: ' + outcome.message)
    }
    if (outcome.kind === 'non-final') {
      throw new Error('ENDPOINT_BACKOFF: transaction not final yet (476): ' + outcome.message)
    }
    if (outcome.kind === 'pending-retry') {
      throw new Error('ENDPOINT_BACKOFF: ' + outcome.reason)
    }
    throw new Error('BROADCAST_ENDPOINT_UNAVAILABLE: ' + outcome.reason)
  }


  async sendToAddress(toAddress: string, amountSats: number): Promise<string> {
    try {
      if (!Number.isSafeInteger(amountSats) || amountSats < 1) {
        throw new Error(`amountSats must be a positive integer number of satoshis (got ${amountSats})`)
      }
      if (!BSV_PRIVATE_KEY && !BSV_FALLBACK_WIF) {
        throw new Error('No private key configured')
      }
      this.ensureWallet()
      if (!this.wallet) {
        throw new Error('Wallet not initialized')
      }

      const fromAddress = this.wallet.getAddress()
      const wif = (this.wallet as any)['wif'] as string
      const utxos = await this.wallet.getUTXOs()
      if (!Array.isArray(utxos) || utxos.length === 0) {
        throw new Error('No UTXOs available')
      }

      const ownLockingScriptHex = p2pkhLockingScriptHexFromWifSdk(wif)
      const effectiveFeeRate = await resolveFeeRateForBuild()

      // Largest first, so the fewest inputs fund the payment. Grown one input at
      // a time against the fee for that input count, because a larger input set
      // costs more bytes and therefore more fee.
      const sorted = [...utxos].sort((a: any, b: any) => (b.value || 0) - (a.value || 0))
      const estimateSendFee = (inputCount: number) =>
        Math.ceil((10 + inputCount * 149 + 2 * 34) * effectiveFeeRate)

      const selected: Array<{ txid: string; vout: number; satoshis: number; lockingScriptHex: string }> = []
      let totalInput = 0
      for (const utxo of sorted) {
        const satoshis = Number(utxo?.value ?? utxo?.satoshis ?? 0)
        if (!Number.isFinite(satoshis) || satoshis < 1) continue
        selected.push({
          txid: String(utxo?.tx_hash ?? utxo?.txid ?? ''),
          vout: Number(utxo?.tx_pos ?? utxo?.vout ?? 0),
          satoshis,
          lockingScriptHex: String(utxo?.script || ownLockingScriptHex),
        })
        totalInput += satoshis
        if (totalInput >= amountSats + estimateSendFee(selected.length) + DUST_LIMIT) break
      }

      const minimumRequired = amountSats + estimateSendFee(selected.length) + DUST_LIMIT
      if (selected.length === 0 || totalInput < minimumRequired) {
        throw new Error(
          `Insufficient UTXO value for requested amount + fee: input=${totalInput} need>=${minimumRequired}`,
        )
      }

      const { txid } = await this.sendPayment({
        wif,
        fromAddress,
        outputs: [{ address: toAddress, satoshis: amountSats }],
        utxos: selected,
      })
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
