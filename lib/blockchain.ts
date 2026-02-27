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
// Explorer store – feed new broadcasts for the /explorer page (Supabase-backed)
import { addReading, type StoredReading } from './supabase-explorer'

// Types
export interface BlockchainData {
  stream: string
  timestamp: number
  payload: any
}

export interface TransactionLog {
  txid: string
  stream: string
  timestamp: number
  payload: any
  status: 'pending' | 'confirmed' | 'failed'
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
// GorillaPool/TAAL ARC minimum: 100 sat/kB (0.1 sat/byte)
// Default to 0.15 sat/byte (150 sat/kB) for comfortable margin above the 100 sat/kB floor
const FEE_RATE_SAT_PER_BYTE = Number(process.env.BSV_TX_FEE_RATE || 0.15)
// BSV has no dust limit — 1 sat is the minimum viable output
const DUST_LIMIT = 1
// UTXO spend policy: default allows all UTXOs (including unconfirmed).
// Protection against long unconfirmed chains is handled architecturally:
//   1. usedKeys TTL — prevents re-spending the same UTXO for 30 min
//   2. mempool-chain backoff — pauses a wallet for 10 min on "too-long-mempool-chain"
//   3. UTXO splitter — creates fan-out pools from confirmed UTXOs
// Override with BSV_MIN_SPEND_CONFIRMATIONS=1 (or higher) if desired.
const MIN_SPEND_CONF = Number(process.env.BSV_MIN_SPEND_CONFIRMATIONS ?? 0)
const REFRESH_THRESHOLD = Number(process.env.BSV_UTXO_REFRESH_THRESHOLD || 10)

// Data credibility features (opt-in for now)
const ENABLE_CREDIBILITY = process.env.GAIALOG_ENABLE_CREDIBILITY === 'true'
const REQUIRE_VALIDATION = process.env.GAIALOG_REQUIRE_VALIDATION === 'true'

// Optional UTXO fetch controls and lightweight pooling (defaults keep current behaviour)
const ENABLE_UTXO_POOL = process.env.BSV_ENABLE_UTXO_POOL === 'true'
const ENABLE_UTXO_DB_LOCKS = process.env.BSV_ENABLE_UTXO_DB_LOCKS === 'true'
const UTXO_POOL_TTL_MS = Number(process.env.BSV_UTXO_POOL_TTL_MS || 10000)
const UTXO_FETCH_BACKOFF_BASE_MS = Number(process.env.BSV_UTXO_FETCH_BACKOFF_BASE_MS || 250)
const UTXO_FETCH_MAX_RETRIES = Number(process.env.BSV_UTXO_FETCH_MAX_RETRIES || 4)
// How long to treat an input UTXO as "used" (to avoid re-spends while indexers lag).
// This prevents txn-mempool-conflict when WoC /unspent still lists a just-spent UTXO.
const UTXO_USED_KEY_TTL_MS = Number(process.env.BSV_UTXO_USED_KEY_TTL_MS || 30 * 60 * 1000) // 30 min
const LOG_SUMMARY_INTERVAL_MS = Math.max(60000, Number(process.env.BSV_LOG_SUMMARY_INTERVAL_MS || 30 * 60 * 1000)) // 30 min
const MAX_IN_MEMORY_TX_LOG = Math.max(100, Number(process.env.BSV_MAX_IN_MEMORY_TX_LOG || 500))
const MAX_CONFIRMATION_CHECK_ATTEMPTS = Math.max(1, Number(process.env.BSV_CONFIRMATION_MAX_ATTEMPTS || 60))
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
  private txStatusBatch: { confirmed: number; pending: number; notFound: number; retryLimitReached: number } =
    { confirmed: 0, pending: 0, notFound: 0, retryLimitReached: 0 }
  private summaryIntervalId: NodeJS.Timeout | null = null
  private confirmationAttemptsByTxid: Map<string, number> = new Map()
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
      console.log(`   🧾 Confirmation checks: ${tx.confirmed} confirmed, ${tx.pending} pending, ${tx.notFound} not-found, ${tx.retryLimitReached} retry-limit`)
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

      this.txStatusBatch = { confirmed: 0, pending: 0, notFound: 0, retryLimitReached: 0 }
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

  private async getFirstWalletWithSpendableUtxos(): Promise<{ wif: string; index: number; address: string; utxos: any[] } | null> {
    // Build list, starting from current rrIndex for fairness
    const list = this.wifsForSend && this.wifsForSend.length > 0
      ? this.wifsForSend
      : (BSV_PRIVATE_KEY ? [BSV_PRIVATE_KEY] : (BSV_FALLBACK_WIF ? [BSV_FALLBACK_WIF] : []))
    if (list.length === 0) return null
    
    const diagnostics: Array<{ address: string; spendableCount: number; totalBalance?: number; error?: string; backedOff?: boolean }> = []
    
    // Import backoff checker (lazy — non-fatal if module unavailable)
    let isBackedOff: ((addr: string) => boolean) | null = null
    try {
      const mod = await import('./utxo-maintainer')
      isBackedOff = mod.isWalletBackedOff
    } catch {}

    for (let i = 0; i < list.length; i++) {
      const pick = (this.rrIndex + i) % list.length
      const wif = list[pick]
      try {
        const sdkKey = SDKPrivateKey.fromWif(wif)
        const addr = sdkKey.toPublicKey().toAddress().toString()

        // Skip wallets in mempool-chain backoff (prevents hammering doomed UTXOs)
        if (isBackedOff && isBackedOff(addr)) {
          diagnostics.push({ address: addr, spendableCount: 0, backedOff: true })
          continue
        }

        const spendable = await this.getSpendableUtxos(addr, wif)
        
        // Estimate balance from spendable UTXOs for diagnostics (avoid extra WoC calls)
        let balance: number | undefined
        try {
          const totalSats = spendable.reduce((sum: number, u: any) => sum + (u.value || 0), 0)
          balance = totalSats / 100000000
        } catch {}
        
        diagnostics.push({
          address: addr,
          spendableCount: spendable.length,
          totalBalance: balance
        })
        
        if (spendable.length > 0) {
          // Advance rrIndex to the position after the one we used
          this.rrIndex = (pick + 1) % list.length
          return { wif, index: pick, address: addr, utxos: spendable }
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
        diagnostics.push({
          address: addr,
          spendableCount: 0,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
    
    // Log diagnostics when no UTXOs found
    console.error('❌ No spendable UTXOs found across wallets. Diagnostics:')
    diagnostics.forEach((d, idx) => {
      const balanceStr = d.totalBalance !== undefined 
        ? `${(d.totalBalance * 100000000).toFixed(0)} sats (${d.totalBalance.toFixed(6)} BSV)`
        : 'unknown'
      console.error(`   Wallet ${idx + 1} (${d.address.substring(0, 10)}...): ${d.spendableCount} spendable UTXOs, balance: ${balanceStr}${d.error ? `, error: ${d.error}` : ''}`)
    })
    
    // If wallets have balances but no UTXOs, force refresh and try once more
    const hasBalances = diagnostics.some(d => d.totalBalance !== undefined && d.totalBalance > 0)
    if (hasBalances && ENABLE_UTXO_POOL) {
      console.log('🔄 Wallets have balances but no UTXOs detected. Force refreshing caches...')
      try {
        await this.forceRefreshAllUtxoCaches()
        
        // Try again after refresh
        for (let i = 0; i < list.length; i++) {
          const pick = (this.rrIndex + i) % list.length
          const wif = list[pick]
          try {
            const sdkKey = SDKPrivateKey.fromWif(wif)
            const addr = sdkKey.toPublicKey().toAddress().toString()
            const spendable = await this.getSpendableUtxos(addr, wif)
            
            if (spendable.length > 0) {
              this.rrIndex = (pick + 1) % list.length
              console.log(`✅ Found ${spendable.length} UTXO(s) after refresh for ${addr.substring(0, 10)}...`)
              return { wif, index: pick, address: addr, utxos: spendable }
            }
          } catch {}
        }
      } catch (refreshError) {
        console.error('Failed to force refresh UTXO caches:', refreshError)
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
    let fromAddress = '' // hoisted so outer catch can signal per-wallet backoff
    try {
      // Check if blockchain is configured
      if (!BSV_PRIVATE_KEY && !BSV_FALLBACK_WIF) {
        console.warn('⚠️ Blockchain private key not configured, skipping write to chain')
        return 'blockchain-not-configured'
      }
      this.enforceHeapGuard()
      // Pick a wallet that currently has spendable UTXOs (fair round-robin)
      const picked = await this.getFirstWalletWithSpendableUtxos()
      if (!picked) throw new Error('No UTXOs available across wallets')
      const { wif, index: walletIndexForLog, address: pickedAddress } = picked
      fromAddress = pickedAddress

      // Proceed based on UTXO availability rather than blunt balance threshold

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

      const providerValue = (data as any)?.payload?.source || 'unknown'
      
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
      // Omit provider for advanced_metrics payloads (per request)
      if (data.stream !== 'advanced_metrics') {
        base.provider = providerValue
      }
      // Add credibility metadata if generated
      if (credibilityMeta) {
        base._credibility = credibilityMeta
      }
      const opReturnData = JSON.stringify(base)

      // Use the previously fetched spendable UTXOs for the selected wallet
      const utxos = picked.utxos
      if (utxos.length === 0) {
        throw new Error('No UTXOs available for transaction')
      }

      // Build UTXO objects with reconstructed scriptPubKey for our address (P2PKH)
      const address = fromAddress
      const scriptPubKey = (bsv.Script as any).fromAddress
        ? (bsv.Script as any).fromAddress(address).toHex()
        : this.p2pkhLockingScriptHexFromWif(wif)
      // Prefer confirmed UTXOs first (prevents long unconfirmed ancestor chains).
      // Fallback to mixed spendable UTXOs only if no confirmed inputs are available.
      const preferConfirmed = process.env.BSV_PREFER_CONFIRMED_UTXOS !== 'false'
      const isConfirmedUtxo = (u: any): boolean => {
        const conf = Number(u?.confirmations || 0)
        const h = typeof u?.height === 'number' ? u.height : null
        return conf > 0 || (h != null && h > 0)
      }
      const confirmedOnly = utxos.filter(isConfirmedUtxo)
      const selectionPool = (preferConfirmed && confirmedOnly.length > 0) ? confirmedOnly : utxos

      // If below low-watermark, prefer the smallest to leave the largest for the splitter
      const lowWater = Number(process.env.BSV_UTXO_LOW_WATERMARK || 50)
      // Order candidate UTXOs
      const candidates = selectionPool.length <= lowWater
        ? [...selectionPool].sort((a: any, b: any) => (a.value || 0) - (b.value || 0))
        : [...selectionPool].sort((a: any, b: any) => (b.value || 0) - (a.value || 0))
      // Try to reserve one; skip already-reserved inputs
      let selectedUtxo: any | null = null
      let inputKey = ''
      for (const u of candidates) {
        const key = `${u.tx_hash}:${u.tx_pos}`
        if (ENABLE_UTXO_DB_LOCKS) {
          try {
            const { reserveUtxoKeys } = await import('./utxo-locks')
            const reserved = await reserveUtxoKeys([key])
            if (reserved.includes(key)) {
              selectedUtxo = u
              inputKey = key
              break
            }
          } catch {}
        } else {
          // No DB lock: pick the first candidate that isn't already in-flight.
          // Check usedKeys directly (not just the pre-filtered snapshot) to close
          // the race window between concurrent writeToChain calls.
          const addrCache = this.utxoCacheByAddress.get(address)
          const alreadyUsed = addrCache?.usedKeys?.get(key)
          if (alreadyUsed && alreadyUsed > Date.now()) continue // skip — another call grabbed it
          // Mark used IMMEDIATELY to prevent concurrent calls from selecting the same UTXO
          if (ENABLE_UTXO_POOL && addrCache) {
            addrCache.usedKeys.set(key, Date.now() + Math.max(1000, UTXO_USED_KEY_TTL_MS))
          }
          selectedUtxo = u
          inputKey = key
          break
        }
      }
      // If every candidate was already claimed, force-refresh and try once more.
      // Change outputs from recent TXs may now be visible to the indexer.
      if (!selectedUtxo) {
        await this.refreshUtxoCache(address, wif, true)
        const freshUtxos = await this.getSpendableUtxos(address, wif)
        const freshConfirmedOnly = freshUtxos.filter(isConfirmedUtxo)
        const freshPool = (preferConfirmed && freshConfirmedOnly.length > 0) ? freshConfirmedOnly : freshUtxos
        const freshCandidates = freshPool.length <= lowWater
          ? [...freshPool].sort((a: any, b: any) => (a.value || 0) - (b.value || 0))
          : [...freshPool].sort((a: any, b: any) => (b.value || 0) - (a.value || 0))
        for (const u of freshCandidates) {
          const key = `${u.tx_hash}:${u.tx_pos}`
          const addrCache = this.utxoCacheByAddress.get(address)
          const alreadyUsed = addrCache?.usedKeys?.get(key)
          if (alreadyUsed && alreadyUsed > Date.now()) continue
          if (ENABLE_UTXO_POOL && addrCache) {
            addrCache.usedKeys.set(key, Date.now() + Math.max(1000, UTXO_USED_KEY_TTL_MS))
          }
          selectedUtxo = u
          inputKey = key
          break
        }
      }
      if (!selectedUtxo) {
        throw new Error('No reservable UTXO available')
      }
      const bitcoreUtxos = [{
        txId: selectedUtxo.tx_hash,
        outputIndex: selectedUtxo.tx_pos,
        address,
        script: scriptPubKey,
        satoshis: selectedUtxo.value,
      }]

      // Build payload bytes (optionally gzip) and optional extra pushes
      const includeHashPush = process.env.BSV_OPRETURN_INCLUDE_HASH_PUSH === 'true'
      const useGzip = process.env.BSV_OPRETURN_GZIP === 'true'
      const useTrueReturn = process.env.BSV_OPRETURN_TRUE_RETURN === 'true'
      const { buildOpFalseOpReturnWithTag } = await import('./opreturn')
      const extras: (Buffer | string)[] = []
      let payloadBytes = Buffer.from(opReturnData, 'utf8')
      try {
        if (useGzip) {
          const { gzipSync } = await import('zlib')
          payloadBytes = gzipSync(payloadBytes)
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

      // Create transaction using library helpers for fee/change handling
      const buildSerialized = (feeMultiplier: number): string => {
        const tx = new (bsv as any).Transaction()
          .from(bitcoreUtxos)
          .addOutput(new bsv.Transaction.Output({
            script: opReturnScript,
            satoshis: useTrueReturn ? 1 : 0,
          }))
          .change(address)
          .feePerKb(FEE_RATE_SAT_PER_BYTE * 1000 * feeMultiplier)
        const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
        tx.sign(signingKey)
        return tx.serialize()
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
      // Note: UTXO was already marked used at selection time (race-condition guard).
      // The call below simply refreshes the TTL.
      let reservedKeys: string[] = []
      try {
        if (ENABLE_UTXO_POOL) {
          reservedKeys = bitcoreUtxos.map((i: any) => `${i.txId}:${i.outputIndex}`)
          this.markUtxosUsed(reservedKeys) // refresh TTL
        }
        const normalHex = buildSerialized(1)
        const txid = await this.broadcastTransaction(normalHex, prevoutsForArc)

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

      // ── Feed reading to /explorer store (zero API calls) ──
      try {
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
        addReading(explorerReading)
      } catch {
        // Non-fatal – explorer store is secondary
      }

      // Persist to tx_log (pending on broadcast, will be confirmed later)
      try {
        if (process.env.GAIALOG_NO_DB !== 'true') {
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
        }
      } catch (e) {
        // Non-fatal
      }

      // Schedule confirmation check after a delay to update status
      this.scheduleConfirmationCheck(txid, data.stream).catch(() => {})

      this.broadcastCountSinceLastSample++
      // Release global reservation after successful broadcast
      if (ENABLE_UTXO_DB_LOCKS) {
        try { const { releaseUtxoKeys } = await import('./utxo-locks'); await releaseUtxoKeys([inputKey]) } catch {}
      }
      return txid
      } catch (innerErr) {
        // On failure, release reserved UTXOs back to pool
        if (ENABLE_UTXO_POOL && reservedKeys.length > 0) {
          this.releaseUtxos(reservedKeys)
        }
        // Release global reservation as well
        if (ENABLE_UTXO_DB_LOCKS) {
          try { const { releaseUtxoKeys } = await import('./utxo-locks'); await releaseUtxoKeys([inputKey]) } catch {}
        }
        throw innerErr
      }

    } catch (error) {
      // Suppress noisy logs for expected, transient availability issues
      const msg = error instanceof Error ? error.message : String(error)
      const transient = /already reserved|No UTXOs available across wallets|No reservable UTXO|MEMPOOL_CHAIN_LIMIT|txn-mempool-conflict|DOUBLE_SPEND|HEAP_PRESSURE_BACKOFF/i.test(msg)
      this.operationalStats.broadcastsFailed += 1
      this.recordOperationalError('writeToChain', msg)

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

  private async refreshUtxoCache(address: string, wif: string, force = false): Promise<void> {
    let cache = this.utxoCacheByAddress.get(address)
    if (!cache) {
      cache = { fetchedAt: 0, utxos: [], usedKeys: new Map<string, number>(), inFlight: null }
      this.utxoCacheByAddress.set(address, cache)
    }
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

  private async getSpendableUtxos(address: string, explicitWif?: string): Promise<any[]> {
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
      return Array.isArray(raw)
        ? raw.filter((u: any) => {
            return (u.confirmations || 0) >= MIN_SPEND_CONF || (typeof u.height !== 'number') || u.height > 0
          })
        : []
    }
    const now = Date.now()
    let cache = this.utxoCacheByAddress.get(address)
    if (!cache) {
      await this.refreshUtxoCache(address, explicitWif || '')
      cache = this.utxoCacheByAddress.get(address)!
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
      const refreshed = this.utxoCacheByAddress.get(address)!
      return refreshed.utxos
        .filter((u: any) => (u.confirmations || 0) >= MIN_SPEND_CONF || (typeof u.height !== 'number') || u.height > 0)
        .filter((u: any) => {
          const key = `${u.tx_hash}:${u.tx_pos}`
          const exp = refreshed.usedKeys.get(key)
          if (!exp) return true
          if (exp <= now) { refreshed.usedKeys.delete(key); return true }
          return false
        })
    }
    return available
  }

  private markUtxosUsed(keys: string[]): void {
    if (!ENABLE_UTXO_POOL) return
    const exp = Date.now() + Math.max(1000, UTXO_USED_KEY_TTL_MS)
    // Mark in every address cache (keys are globally unique per address anyway)
    for (const cache of this.utxoCacheByAddress.values()) {
      for (const k of keys) cache.usedKeys.set(k, exp)
    }
  }

  private releaseUtxos(keys: string[]): void {
    if (!ENABLE_UTXO_POOL) return
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

  // ARC txStatus values that indicate the TX was genuinely accepted.
  // SEEN_IN_ORPHAN_MEMPOOL means ARC accepted but parent chain is long/unconfirmed;
  // the TX will propagate automatically once parents confirm in a block.
  private static ARC_OK_STATUSES = new Set([
    'SEEN_ON_NETWORK',
    'MINED',
    'ACCEPTED',
    'STORED',
    'RECEIVED',
    'ANNOUNCED_TO_NETWORK',
    'SEEN_IN_ORPHAN_MEMPOOL',
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
    prevouts?: Array<{ lockingScript: string; satoshis: number }>
  ): Promise<string> {
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
      const gpHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
      const gpApiKey = process.env.BSV_GORILLAPOOL_API_KEY
      if (gpApiKey) gpHeaders['Authorization'] = `Bearer ${gpApiKey}`

      const gpRes = await fetch(`${GORILLAPOOL_ARC_ENDPOINT}/v1/tx`, {
        method: 'POST',
        headers: gpHeaders,
        body: JSON.stringify(useExtended ? arcBodyExtended : arcBodyRaw)
      })
      const gpText = await gpRes.text().catch(() => '')
      if (gpRes.ok) {
        const txid = this.parseArcResponse(gpText, 'GorillaPool')
        if (txid) return txid
        errors.push(`GorillaPool ARC: rejected or unexpected response: ${gpText.substring(0, 200)}`)
      } else {
        if (bsvConfig.logging.level !== 'error') {
          console.warn(`⚠️  ARC (GorillaPool) ${gpRes.status}: ${gpText.substring(0, 150)}`)
        }
        // GorillaPool sometimes rejects extended-format metadata with 461.
        // Retry once without prevouts before failing over to TAAL/WoC.
        const gp461 = gpRes.status === 461 || /malformed|false\/empty top stack/i.test(gpText)
        if (useExtended && gp461) {
          try {
            const gpCompatRes = await fetch(`${GORILLAPOOL_ARC_ENDPOINT}/v1/tx`, {
              method: 'POST',
              headers: gpHeaders,
              body: JSON.stringify(arcBodyRaw)
            })
            const gpCompatText = await gpCompatRes.text().catch(() => '')
            if (gpCompatRes.ok) {
              const txid = this.parseArcResponse(gpCompatText, 'GorillaPool')
              if (txid) {
                if (bsvConfig.logging.level !== 'error') {
                  console.warn('⚠️  ARC (GorillaPool): accepted after rawTx compatibility retry (without extended inputs)')
                }
                return txid
              }
              errors.push(`GorillaPool ARC compatibility retry: unexpected response: ${gpCompatText.substring(0, 200)}`)
            } else {
              if (bsvConfig.logging.level !== 'error') {
                console.warn(`⚠️  ARC (GorillaPool compat) ${gpCompatRes.status}: ${gpCompatText.substring(0, 150)}`)
              }
              errors.push(`GorillaPool ARC compatibility retry failed (${gpCompatRes.status}): ${gpCompatText.substring(0, 300)}`)
            }
          } catch (compatErr) {
            errors.push(`GorillaPool ARC compatibility retry error: ${compatErr instanceof Error ? compatErr.message : String(compatErr)}`)
          }
        } else {
          errors.push(`GorillaPool ARC failed (${gpRes.status}): ${gpText.substring(0, 300)}`)
        }
      }
    } catch (e) {
      errors.push(`GorillaPool ARC error: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Method 2: TAAL ARC (fallback)
    try {
      const arcKey = process.env.BSV_ARC_API_KEY
      const taalHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
      if (arcKey) taalHeaders['Authorization'] = `Bearer ${arcKey}`

      const arcRes = await fetch(`${TAAL_ARC_ENDPOINT}/v1/tx`, {
        method: 'POST',
        headers: taalHeaders,
        body: JSON.stringify(useExtended ? arcBodyExtended : arcBodyRaw)
      })
      const arcText = await arcRes.text().catch(() => '')
      if (arcRes.ok) {
        const txid = this.parseArcResponse(arcText, 'TAAL')
        if (txid) return txid
        errors.push(`TAAL ARC: rejected or unexpected response: ${arcText.substring(0, 200)}`)
      } else {
        if (bsvConfig.logging.level !== 'error') {
          console.warn(`⚠️  ARC (TAAL) ${arcRes.status}: ${arcText.substring(0, 150)}`)
        }
        errors.push(`TAAL ARC failed (${arcRes.status}): ${arcText.substring(0, 300)}`)
      }
    } catch (e) {
      errors.push(`TAAL ARC error: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Method 3: WhatsOnChain broadcast (final fallback)
    // WoC broadcasts directly to miners and does NOT share ARC's
    // double-spend conflict memory — this unblocks UTXOs that ARC
    // incorrectly flags as DOUBLE_SPEND_ATTEMPTED due to stale conflicts.
    try {
      const wocNetwork = WOC_NETWORK
      const wocHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
      if (WHATSONCHAIN_API_KEY) wocHeaders['woc-api-key'] = WHATSONCHAIN_API_KEY

      const wocRes = await fetch(`https://api.whatsonchain.com/v1/bsv/${wocNetwork}/tx/raw`, {
        method: 'POST',
        headers: wocHeaders,
        body: JSON.stringify({ txhex: serializedTx })
      })
      const wocText = await wocRes.text().catch(() => '')
      if (wocRes.ok) {
        // WoC returns the txid as a plain string (with quotes)
        const txid = wocText.replace(/"/g, '').trim()
        if (/^[0-9a-fA-F]{64}$/.test(txid)) {
          console.log(`📡 WoC broadcast accepted: txid=${txid.substring(0, 12)}...`)
          return txid
        }
        errors.push(`WoC returned unexpected response: ${wocText.substring(0, 200)}`)
      } else {
        if (bsvConfig.logging.level !== 'error') {
          console.warn(`⚠️  WoC broadcast ${wocRes.status}: ${wocText.substring(0, 150)}`)
        }
        errors.push(`WoC broadcast failed (${wocRes.status}): ${wocText.substring(0, 300)}`)
      }
    } catch (e) {
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
    throw new Error(`All broadcast methods failed:\n${allErrors}`)
  }

  private async scheduleConfirmationCheck(txid: string, streamType: string): Promise<void> {
    // Wait 60 seconds for transaction to propagate and get indexed (increased from 30s)
    setTimeout(async () => {
      try {
        const previousAttempts = this.confirmationAttemptsByTxid.get(txid) || 0
        if (previousAttempts >= MAX_CONFIRMATION_CHECK_ATTEMPTS) {
          this.txStatusBatch.retryLimitReached += 1
          this.recordOperationalError('confirmation-check', 'max-attempts-reached')
          this.confirmationAttemptsByTxid.delete(txid)
          return
        }
        this.confirmationAttemptsByTxid.set(txid, previousAttempts + 1)

        const network = WOC_NETWORK
        const wocUrl = `https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}`
        const headers: Record<string, string> = {}
        if (WHATSONCHAIN_API_KEY) {
          headers['woc-api-key'] = WHATSONCHAIN_API_KEY
        }
        
        const response = await fetch(wocUrl, { headers })
        
        if (response.ok) {
          const txData = await response.json()
          const confirmations = txData.confirmations || 0
          
          // Update status to confirmed if it has at least 1 confirmation
          if (confirmations > 0) {
            await upsertTxLog({
              txid,
              type: streamType,
              provider: 'auto-confirmed',
              collected_at: new Date(),
              status: 'confirmed',
              onchain_at: new Date(),
              fee_sats: null,
              wallet_index: null,
              retries: null,
              error: null,
            })
            this.txStatusBatch.confirmed += 1
            this.confirmationAttemptsByTxid.delete(txid)
          } else {
            // Still in mempool, check again later.
            this.txStatusBatch.pending += 1
            setTimeout(() => this.scheduleConfirmationCheck(txid, streamType).catch(() => {}), 120000)
          }
        } else if (response.status === 404) {
          // Transaction not found - might have been rejected or not yet indexed
          this.txStatusBatch.notFound += 1
          // Check again after 2 minutes.
          setTimeout(() => this.scheduleConfirmationCheck(txid, streamType).catch(() => {}), 120000)
        }
      } catch (error) {
        // Silently fail - confirmation checking is best-effort
        this.recordOperationalError('confirmation-check', error)
      }
    }, 60000) // Initial check after 60 seconds (increased from 30s)
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

      const selected: any[] = []
      let totalInput = 0
      const feePerKb = FEE_RATE_SAT_PER_BYTE * 1000
      const baseOverhead = 200 // bytes rough baseline
      const estimatedFee = Math.ceil(baseOverhead * FEE_RATE_SAT_PER_BYTE)
      const target = amountSats + estimatedFee + DUST_LIMIT
      for (const u of sorted) {
        selected.push({
          txId: u.tx_hash,
          outputIndex: u.tx_pos,
          address: fromAddress,
          script: scriptFromAddr,
          satoshis: u.value,
        })
        totalInput += u.value
        if (totalInput >= target) break
      }
      if (totalInput < target) {
        throw new Error('Insufficient UTXO value for requested amount + fee')
      }

      const tx = new (bsv as any).Transaction()
        .from(selected)
        .to(toAddress, amountSats)
        .change(fromAddress)
        .feePerKb(feePerKb)

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
      const txid = await this.broadcastTransaction(tx.serialize(), prevoutsForArc)
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
        `https://api.whatsonchain.com/v1/bsv/${WOC_NETWORK}/tx/${txid}/raw`
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
    this.confirmationAttemptsByTxid.clear()
  }
}

// Persist singleton on globalThis to survive Next.js dev-mode module
// re-evaluations that would otherwise create duplicate service instances.
const _bs = globalThis as any
if (!_bs.__GAIALOG_BLOCKCHAIN_SERVICE__) {
  _bs.__GAIALOG_BLOCKCHAIN_SERVICE__ = new BlockchainService()
}
export const blockchainService: BlockchainService = _bs.__GAIALOG_BLOCKCHAIN_SERVICE__
