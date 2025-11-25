import * as bsv from 'bsv'
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
// DB write via repositories (Postgres)
import { upsertTxLog } from './repositories'
import { bsvConfig } from './bsv-config'
import { APP_NAME, SCHEMA_VERSION } from './constants'
// Data credibility features
import { dataValidator, qualityScorer } from './validation'
import { createCredibilityBuilder } from './pipeline-integrity'
import type { CredibilityMetadata } from './types/credibility'

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
const GORILLAPOOL_MAPI_ENDPOINT = (process.env.BSV_GORILLAPOOL_MAPI_ENDPOINT || 'https://mapi.gorillapool.io')
// Default to ~1 sat/kB when not configured
const FEE_RATE_SAT_PER_BYTE = Number(process.env.BSV_TX_FEE_RATE || 0.001)
const DUST_LIMIT = 546
const MIRROR_TO_WOC = process.env.BSV_MIRROR_TO_WOC === 'true'
const MIRROR_TO_ARC = process.env.BSV_MIRROR_TO_ARC === 'true'
const WOC_FIRST = process.env.BSV_WOC_FIRST === 'true'
const WOC_ONLY = process.env.BSV_WOC_ONLY === 'true'
const WOC_MIRROR_MAX_RPS = 3
// Optional low-fee WoC lane (limited throughput)
const WOC_LOW_FEE_ENABLED = process.env.BSV_WOC_LOW_FEE_ENABLED === 'true'
const WOC_LOW_FEE_FACTOR = Number(process.env.BSV_WOC_LOW_FEE_FACTOR || 0.1) // 10x reduction by default
const WOC_LOW_FEE_TPS = Number(process.env.BSV_WOC_LOW_FEE_TPS || 2) // 2 TPS cap by default
// WoC cooldown configuration (auto-fallback to ARC on repeated failures)
const WOC_COOLDOWN_THRESHOLD = Number(process.env.BSV_WOC_COOLDOWN_THRESHOLD || 3) // failures before cooldown
const WOC_COOLDOWN_DURATION_MS = Number(process.env.BSV_WOC_COOLDOWN_DURATION_MS || 75000) // 75s cooldown
const MIN_SPEND_CONF = Number(process.env.BSV_MIN_SPEND_CONFIRMATIONS || 1)
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
  private wocMirrorTimestamps: number[] = []
  // Shared limiter for all WoC tx/raw POSTs (low-fee lane + mirror)
  private wocTxRawTimestamps: number[] = []
  private broadcastCountSinceLastSample = 0
  // Lightweight per-address UTXO cache to avoid hammering indexers
  private utxoCacheByAddress: Map<string, {
    fetchedAt: number
    utxos: any[]
    usedKeys: Set<string>
    inFlight: Promise<void> | null
  }> = new Map()
  // Transaction status aggregation to reduce log noise
  private txStatusBatch: { confirmed: string[], pending: string[], notFound: string[] } = { confirmed: [], pending: [], notFound: [] }
  private batchIntervalId: NodeJS.Timeout | null = null
  // WoC cooldown tracking (auto-fallback to ARC on repeated failures)
  private wocConsecutiveFailures = 0
  private wocCooldownUntil = 0

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
      
      // Start transaction status batch logging
      this.startTxStatusBatchLogging()
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

  private startTxStatusBatchLogging(): void {
    // Log aggregated transaction statuses every 60 seconds instead of individually
    this.batchIntervalId = setInterval(() => {
      const { confirmed, pending, notFound } = this.txStatusBatch
      
      if (confirmed.length > 0 || pending.length > 0 || notFound.length > 0) {
        console.log(`📊 Transaction Status Update:`)
        if (confirmed.length > 0) {
          console.log(`   ✅ Confirmed: ${confirmed.length} transactions`)
        }
        if (pending.length > 0) {
          console.log(`   ⏳ Pending in mempool: ${pending.length} transactions`)
        }
        if (notFound.length > 0) {
          console.log(`   ⚠️  Not found on WOC: ${notFound.length} transactions (may be rejected or still propagating)`)
        }
        
        // Reset batch
        this.txStatusBatch = { confirmed: [], pending: [], notFound: [] }
      }
    }, 60000) // Every 60 seconds
  }

  /**
   * Check if WoC is currently in cooldown mode
   */
  private isWocInCooldown(): boolean {
    if (this.wocCooldownUntil > 0 && Date.now() < this.wocCooldownUntil) {
      return true
    }
    // Cooldown expired, reset
    if (this.wocCooldownUntil > 0 && Date.now() >= this.wocCooldownUntil) {
      console.log('🔄 WoC cooldown expired, re-enabling WoC broadcasting')
      this.wocCooldownUntil = 0
      this.wocConsecutiveFailures = 0
    }
    return false
  }

  /**
   * Record a WoC failure and potentially trigger cooldown
   */
  private recordWocFailure(): void {
    this.wocConsecutiveFailures++
    if (this.wocConsecutiveFailures >= WOC_COOLDOWN_THRESHOLD) {
      this.wocCooldownUntil = Date.now() + WOC_COOLDOWN_DURATION_MS
      console.warn(`⚠️ WoC hit ${this.wocConsecutiveFailures} consecutive failures, entering cooldown for ${WOC_COOLDOWN_DURATION_MS / 1000}s (using ARC fallback)`)
    }
  }

  /**
   * Record a WoC success, resetting the failure counter
   */
  private recordWocSuccess(): void {
    if (this.wocConsecutiveFailures > 0) {
      console.log(`✅ WoC recovered after ${this.wocConsecutiveFailures} failure(s), resetting counter`)
    }
    this.wocConsecutiveFailures = 0
  }

  /**
   * Get current WoC cooldown status (for monitoring/debugging)
   */
  public getWocCooldownStatus(): {
    inCooldown: boolean
    consecutiveFailures: number
    cooldownRemainingMs: number
    cooldownThreshold: number
    cooldownDurationMs: number
  } {
    const now = Date.now()
    const inCooldown = this.wocCooldownUntil > 0 && now < this.wocCooldownUntil
    return {
      inCooldown,
      consecutiveFailures: this.wocConsecutiveFailures,
      cooldownRemainingMs: inCooldown ? this.wocCooldownUntil - now : 0,
      cooldownThreshold: WOC_COOLDOWN_THRESHOLD,
      cooldownDurationMs: WOC_COOLDOWN_DURATION_MS,
    }
  }

  /**
   * Manually reset WoC cooldown (for admin/debugging)
   */
  public resetWocCooldown(): void {
    const wasInCooldown = this.wocCooldownUntil > 0 && Date.now() < this.wocCooldownUntil
    this.wocCooldownUntil = 0
    this.wocConsecutiveFailures = 0
    if (wasInCooldown) {
      console.log('🔧 WoC cooldown manually reset by admin')
    }
  }

  private async getFirstWalletWithSpendableUtxos(): Promise<{ wif: string; index: number; address: string; utxos: any[] } | null> {
    // Build list, starting from current rrIndex for fairness
    const list = this.wifsForSend && this.wifsForSend.length > 0
      ? this.wifsForSend
      : (BSV_PRIVATE_KEY ? [BSV_PRIVATE_KEY] : (BSV_FALLBACK_WIF ? [BSV_FALLBACK_WIF] : []))
    if (list.length === 0) return null
    
    const diagnostics: Array<{ address: string; spendableCount: number; totalBalance?: number; error?: string }> = []
    
    for (let i = 0; i < list.length; i++) {
      const pick = (this.rrIndex + i) % list.length
      const wif = list[pick]
      try {
        const sdkKey = SDKPrivateKey.fromWif(wif)
        const addr = sdkKey.toPublicKey().toAddress().toString()
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
    try {
      // Check if blockchain is configured
      if (!BSV_PRIVATE_KEY && !BSV_FALLBACK_WIF) {
        console.warn('⚠️ Blockchain private key not configured, skipping write to chain')
        return 'blockchain-not-configured'
      }
      // Pick a wallet that currently has spendable UTXOs (fair round-robin)
      const picked = await this.getFirstWalletWithSpendableUtxos()
      if (!picked) throw new Error('No UTXOs available across wallets')
      const { wif, index: walletIndexForLog, address: fromAddress } = picked

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
      // Select a single confirmed UTXO
      // If below low-watermark, prefer the smallest to leave the largest for the splitter
      const lowWater = Number(process.env.BSV_UTXO_LOW_WATERMARK || 50)
      // Order candidate UTXOs
      const candidates = utxos.length <= lowWater
        ? [...utxos].sort((a: any, b: any) => (a.value || 0) - (b.value || 0))
        : [...utxos].sort((a: any, b: any) => (b.value || 0) - (a.value || 0))
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
          // No DB lock: just pick the first candidate
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

      // Broadcast transaction (prefer WoC low-fee lane when enabled and capacity available)
      // Prevent double-use of the same cached UTXOs across rapid sends
      let reservedKeys: string[] = []
      try {
        if (ENABLE_UTXO_POOL) {
          reservedKeys = bitcoreUtxos.map((i: any) => `${i.txId}:${i.outputIndex}`)
          this.markUtxosUsed(reservedKeys)
        }
        let txid: string
        try {
          // Check if WoC is in cooldown - if so, use ARC directly
          const wocInCooldown = this.isWocInCooldown()
          
          if ((WOC_FIRST || WOC_LOW_FEE_ENABLED || WOC_ONLY) && !wocInCooldown) {
            // Throttled WoC-first path: wait for slot, then prefer WoC with low-fee factor when enabled
            await this.waitForWocSlot()
            const feeFactor = WOC_LOW_FEE_ENABLED ? Math.max(WOC_LOW_FEE_FACTOR, 0.01) : 1
            const woCHex = buildSerialized(feeFactor)
            try {
              txid = await this.broadcastViaWocOnly(woCHex)
              this.recordWocSuccess()
            } catch {
              // Retry WoC once more after a brief wait, then fall back
              await this.waitForWocSlot()
              const woCHex2 = buildSerialized(feeFactor)
              try {
                txid = await this.broadcastViaWocOnly(woCHex2)
                this.recordWocSuccess()
              } catch {
                this.recordWocFailure()
                // In WOC_ONLY mode, still allow ARC fallback during cooldown
                if (WOC_ONLY && !this.isWocInCooldown()) {
                  throw new Error('WoC-only mode: WoC broadcast failed after retries')
                }
                // Fall back to ARC (either normally or during WoC cooldown)
                console.log(`🔄 Falling back to ARC broadcast${this.isWocInCooldown() ? ' (WoC in cooldown)' : ''}`)
                const normalHex = buildSerialized(1)
                txid = await this.broadcastTransaction(normalHex, prevoutsForArc)
              }
            }
          } else if (wocInCooldown) {
            // WoC is in cooldown, use ARC directly
            const normalHex = buildSerialized(1)
            txid = await this.broadcastTransaction(normalHex, prevoutsForArc)
          } else {
            // Legacy behavior when not using WoC-first or low-fee lane
            const normalHex = buildSerialized(1)
            txid = await this.broadcastTransaction(normalHex, prevoutsForArc)
          }
        } catch (_e) {
          // Final fallback to normal path if anything else blew up
          if (WOC_ONLY && !this.isWocInCooldown()) {
            throw _e
          }
          const normalHex = buildSerialized(1)
          txid = await this.broadcastTransaction(normalHex, prevoutsForArc)
        }

        // Log transaction
      const transactionLog: TransactionLog = {
        txid,
        stream: data.stream,
        timestamp: data.timestamp,
        payload: data.payload,
        status: 'pending'
      }

      this.transactionLog.push(transactionLog)
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
      const transient = /already reserved|No UTXOs available across wallets|No reservable UTXO/i.test(msg)
      if (!transient) {
        console.error('❌ Error writing to blockchain:', error)
      }
      
      // Log failed transaction
      if (!transient) {
        const failedLog: TransactionLog = {
          txid: 'failed',
          stream: data.stream,
          timestamp: data.timestamp,
          payload: data.payload,
          status: 'failed',
          error: msg || 'Unknown error'
        }
        this.transactionLog.push(failedLog)
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

  /**
   * Reserve a WoC tx/raw POST slot if available within the 1s window.
   * Returns true when reserved, false when capacity is exhausted.
   */
  private canTakeWocTxRawSlot(): boolean {
    const now = Date.now()
    const capacity = WOC_LOW_FEE_ENABLED ? WOC_LOW_FEE_TPS : WOC_MIRROR_MAX_RPS
    this.wocTxRawTimestamps = this.wocTxRawTimestamps.filter(t => now - t < 1000)
    if (this.wocTxRawTimestamps.length >= capacity) return false
    this.wocTxRawTimestamps.push(now)
    return true
  }

  /**
   * Wait until a WoC tx/raw slot is available, reserving it when acquired.
   * Uses the same internal slot accounting as mirrors/low-fee path.
   */
  private async waitForWocSlot(): Promise<void> {
    // Busy-wait in short sleeps until a slot is available
    while (true) {
      if (this.canTakeWocTxRawSlot()) return
      await new Promise(r => setTimeout(r, 15))
    }
  }

  /**
   * Direct WoC broadcast (tx/raw). Caller must acquire slot first via canTakeWocTxRawSlot.
   */
  private async broadcastViaWocOnly(serializedTx: string): Promise<string> {
    const wocNet = WOC_NETWORK
    const wocRes = await fetch(`https://api.whatsonchain.com/v1/bsv/${wocNet}/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: serializedTx })
    })
    const wocText = await wocRes.text().catch(() => '')
    if (wocRes.ok) {
      const txid = (wocText || '').replace(/"/g, '').trim()
      if (/^[0-9a-fA-F]{64}$/.test(txid)) {
        // Mirror WoC success to ARC asynchronously to keep mempools in sync
        try {
          const arcKey = process.env.BSV_ARC_API_KEY
          const arcEndpoint = (process.env.BSV_API_ENDPOINT || 'https://api.taal.com/arc').replace(/\/$/, '')
          if (arcKey && MIRROR_TO_ARC) {
            fetch(`${arcEndpoint}/v1/tx`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${arcKey}`,
              },
              body: JSON.stringify({ rawTx: serializedTx })
            }).catch(() => {})
          }
        } catch {}
        return txid
      }
      throw new Error(`WOC returned invalid txid: ${wocText}`)
    }
    throw new Error(`WOC failed (${wocRes.status})`)
  }

  private async refreshUtxoCache(address: string, wif: string): Promise<void> {
    let cache = this.utxoCacheByAddress.get(address)
    if (!cache) {
      cache = { fetchedAt: 0, utxos: [], usedKeys: new Set<string>(), inFlight: null }
      this.utxoCacheByAddress.set(address, cache)
    }
    if (cache.inFlight) {
      await cache.inFlight
      return
    }
    cache.inFlight = (async () => {
      // Fetch UTXOs for the given address using a temporary wallet
      const tempWallet = new BSVWallet(wif)
      const fetched = await tempWallet.getUTXOs()
      cache!.utxos = Array.isArray(fetched) ? fetched : []
      cache!.fetchedAt = Date.now()
      cache!.usedKeys.clear()
      
      // Debug logging for UTXO refresh
      console.log(`🔁 UTXO cache refreshed for ${address.substring(0, 10)}...: ${cache!.utxos.length} raw UTXO(s) fetched`)
      if (cache!.utxos.length > 0 && bsvConfig.logging.level === 'debug') {
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
            const conf = (u.confirmations || 0) >= MIN_SPEND_CONF
            const byHeight = typeof u.height === 'number' ? (u.height > 0 || (u.height === 0 && MIN_SPEND_CONF <= 1)) : true
            return conf || byHeight
          })
        : []
    }
    const now = Date.now()
    let cache = this.utxoCacheByAddress.get(address)
    if (!cache) {
      await this.refreshUtxoCache(address, explicitWif || '')
      cache = this.utxoCacheByAddress.get(address)!
    }
    // Only refresh on TTL if available confirmed UTXOs is low
    const availableNow = (cache?.utxos || [])
      .filter((u: any) => {
        const conf = (u.confirmations || 0) >= MIN_SPEND_CONF
        const byHeight = typeof u.height === 'number' ? (u.height > 0 || (u.height === 0 && MIN_SPEND_CONF <= 1)) : true
        return conf || byHeight
      })
      .filter((u: any) => !cache!.usedKeys.has(`${u.tx_hash}:${u.tx_pos}`))
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
      .filter((u: any) => {
        const conf = (u.confirmations || 0) >= MIN_SPEND_CONF
        const byHeight = typeof u.height === 'number' ? (u.height > 0 || (u.height === 0 && MIN_SPEND_CONF <= 1)) : true
        return conf || byHeight
      })
      .filter((u: any) => !used.has(`${u.tx_hash}:${u.tx_pos}`))
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
        .filter((u: any) => {
          const conf = (u.confirmations || 0) >= MIN_SPEND_CONF
          const byHeight = typeof u.height === 'number' ? (u.height > 0 || (u.height === 0 && MIN_SPEND_CONF <= 1)) : true
          return conf || byHeight
        })
        .filter((u: any) => !refreshed.usedKeys.has(`${u.tx_hash}:${u.tx_pos}`))
    }
    return available
  }

  private markUtxosUsed(keys: string[]): void {
    if (!ENABLE_UTXO_POOL) return
    // Mark in every address cache (keys are globally unique per address anyway)
    for (const cache of this.utxoCacheByAddress.values()) {
      for (const k of keys) cache.usedKeys.add(k)
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
            cache.usedKeys.clear() // Clear used keys
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

  private async broadcastTransaction(
    serializedTx: string,
    prevouts?: Array<{ lockingScript: string; satoshis: number }>
  ): Promise<string> {
    const errors: string[] = []
    let lastArcText: string | undefined

    // Optional Method 0: WhatOnChain first (cost-optimised, throttled)
    if (WOC_FIRST || WOC_ONLY) {
      try {
        await this.waitForWocSlot()
        const wocNet = WOC_NETWORK
        const wocRes = await fetch(`https://api.whatsonchain.com/v1/bsv/${wocNet}/tx/raw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txhex: serializedTx })
        })
        const wocText = await wocRes.text().catch(() => '')
        if (wocRes.ok) {
          const txid = (wocText || '').replace(/"/g, '').trim()
          if (/^[0-9a-fA-F]{64}$/.test(txid)) return txid
        } else {
          errors.push(`WhatOnChain failed (${wocRes.status})`)
          if (WOC_ONLY) {
            throw new Error(`WoC-only mode: WhatOnChain failed (${wocRes.status})`)
          }
        }
      } catch (e) {
        errors.push(`WhatOnChain error: ${e instanceof Error ? e.message : String(e)}`)
        if (WOC_ONLY) {
          throw new Error(`WoC-only mode: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    // Method 1: TAAL ARC (primary)
    try {
      const arcKey = process.env.BSV_ARC_API_KEY
      const arcEndpoint = process.env.BSV_API_ENDPOINT || 'https://api.taal.com/arc'
      if (arcKey) {
        // Prefer sending ARC Extended Format when prevouts are available
        const arcBody: any = { rawTx: serializedTx }
        try {
          const useExtended = prevouts && prevouts.length > 0 && (process.env.BSV_ARC_EXTENDED_FORMAT !== 'false')
          if (useExtended) {
            arcBody.inputs = prevouts.map(p => ({
              lockingScript: p.lockingScript,
              satoshis: Math.max(0, Number(p.satoshis) || 0),
            }))
          }
        } catch {}
        const arcRes = await fetch(`${arcEndpoint.replace(/\/$/, '')}/v1/tx`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${arcKey}`,
          },
          body: JSON.stringify(arcBody)
        })
        lastArcText = await arcRes.text().catch(() => '')
        if (arcRes.ok) {
          // Try JSON { txid }
          try {
            const parsed = JSON.parse(lastArcText || '{}')
            if (parsed && typeof parsed.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(parsed.txid)) {
              // Optional mirror to WOC
              if (MIRROR_TO_WOC && this.canTakeWocTxRawSlot()) {
                try {
                  const wocNet = WOC_NETWORK
                  fetch(`https://api.whatsonchain.com/v1/bsv/${wocNet}/tx/raw`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ txhex: serializedTx })
                  }).catch(() => {})
                } catch {}
              }
              return parsed.txid
            }
          } catch {}
          // Some ARC deployments return plain string txid
          const txid = (lastArcText || '').replace(/"/g, '').trim()
          if (/^[0-9a-fA-F]{64}$/.test(txid)) {
            if (MIRROR_TO_WOC && this.canTakeWocTxRawSlot()) {
              try {
                const wocNet = WOC_NETWORK
                fetch(`https://api.whatsonchain.com/v1/bsv/${wocNet}/tx/raw`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ txhex: serializedTx })
                }).catch(() => {})
              } catch {}
            }
            return txid
          }
        } else {
          errors.push(`ARC failed (${arcRes.status}): ${lastArcText || arcRes.statusText}`)
        }
      } else {
        errors.push('ARC not configured (BSV_ARC_API_KEY missing)')
      }
    } catch (e) {
      errors.push(`ARC error: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Method 2: GorillaPool mAPI (fallback)
    try {
      const gpEndpoint = (process.env.BSV_GORILLAPOOL_MAPI_ENDPOINT || 'https://mapi.gorillapool.io').replace(/\/$/, '')
      const gpRes = await fetch(`${gpEndpoint}/mapi/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawTx: serializedTx })
      })
      const gpText = await gpRes.text().catch(() => '')
      if (gpRes.ok) {
        try {
          const gpData = JSON.parse(gpText || '{}')
          if (gpData?.payload) {
            const payload = JSON.parse(gpData.payload)
            if (payload?.returnResult === 'success' && typeof payload.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(payload.txid)) {
              // Mirror GorillaPool success to ARC asynchronously to keep mempools in sync
              try {
                const arcKey = process.env.BSV_ARC_API_KEY
                const arcEndpoint = (process.env.BSV_API_ENDPOINT || 'https://api.taal.com/arc').replace(/\/$/, '')
                if (arcKey && MIRROR_TO_ARC) {
                  fetch(`${arcEndpoint}/v1/tx`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${arcKey}` },
                    body: JSON.stringify({ rawTx: serializedTx })
                  }).catch(() => {})
                }
              } catch {}
              return payload.txid
            }
            if (payload?.returnResult === 'failure') {
              errors.push(`GorillaPool rejected: ${payload?.resultDescription || 'Unknown reason'}`)
            }
          }
        } catch {
          // If response isn't standard envelope, try raw string txid
          const txid = (gpText || '').replace(/"/g, '').trim()
          if (/^[0-9a-fA-F]{64}$/.test(txid)) {
            // Mirror GorillaPool success to ARC asynchronously
            try {
              const arcKey = process.env.BSV_ARC_API_KEY
              const arcEndpoint = (process.env.BSV_API_ENDPOINT || 'https://api.taal.com/arc').replace(/\/$/, '')
              if (arcKey && MIRROR_TO_ARC) {
                fetch(`${arcEndpoint}/v1/tx`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${arcKey}` },
                  body: JSON.stringify({ rawTx: serializedTx })
                }).catch(() => {})
              }
            } catch {}
            return txid
          }
        }
      } else {
        errors.push(`GorillaPool failed (${gpRes.status})`)
      }
    } catch (e) {
      errors.push(`GorillaPool error: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Method 3: WhatOnChain (last resort)
    try {
      // Avoid double-broadcasting if we already mirrored
      if (!MIRROR_TO_WOC) {
        const wocNet = WOC_NETWORK
        const wocRes = await fetch(`https://api.whatsonchain.com/v1/bsv/${wocNet}/tx/raw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txhex: serializedTx })
        })
        const wocText = await wocRes.text().catch(() => '')
        if (wocRes.ok) {
          const txid = (wocText || '').replace(/"/g, '').trim()
          if (/^[0-9a-fA-F]{64}$/.test(txid)) return txid
        } else {
          errors.push(`WhatOnChain failed (${wocRes.status})`)
        }
      }
    } catch (e) {
      errors.push(`WhatOnChain error: ${e instanceof Error ? e.message : String(e)}`)
    }

    // If we reach here, all methods failed
    throw new Error(`All broadcast methods failed:\n${errors.join('\n')}`)
  }

  private async scheduleConfirmationCheck(txid: string, streamType: string): Promise<void> {
    // Wait 60 seconds for transaction to propagate and get indexed (increased from 30s)
    setTimeout(async () => {
      try {
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
            // Add to batch instead of logging immediately
            this.txStatusBatch.confirmed.push(txid.substring(0, 12))
          } else {
            // Still in mempool, check again later (increased delay to 2 minutes)
            this.txStatusBatch.pending.push(txid.substring(0, 12))
            setTimeout(() => this.scheduleConfirmationCheck(txid, streamType).catch(() => {}), 120000)
          }
        } else if (response.status === 404) {
          // Transaction not found - might have been rejected or not yet indexed
          this.txStatusBatch.notFound.push(txid.substring(0, 12))
          // Check one more time after 2 minutes (increased from 60s)
          setTimeout(() => this.scheduleConfirmationCheck(txid, streamType).catch(() => {}), 120000)
        }
      } catch (error) {
        // Silently fail - confirmation checking is best-effort
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
      // Apply WoC low-fee factor when enabled so even direct sends use cheap fees
      const feeFactor = WOC_LOW_FEE_ENABLED ? Math.max(WOC_LOW_FEE_FACTOR, 0.01) : 1
      const feePerKb = FEE_RATE_SAT_PER_BYTE * 1000 * feeFactor
      const baseOverhead = 200 // bytes rough baseline
      const estimatedFee = Math.ceil((baseOverhead) * FEE_RATE_SAT_PER_BYTE * feeFactor)
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
    if (this.batchIntervalId) {
      clearInterval(this.batchIntervalId)
      this.batchIntervalId = null
    }
  }
}

// Export singleton instance
export const blockchainService = new BlockchainService()
