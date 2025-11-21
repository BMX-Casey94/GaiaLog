import * as bsv from 'bsv'
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
// DB write via repositories (Postgres)
import { upsertTxLog } from './repositories'
import { bsvConfig } from './bsv-config'
import { APP_NAME } from './constants'

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
const WOC_MIRROR_MAX_RPS = 3
const MIN_SPEND_CONF = Number(process.env.BSV_MIN_SPEND_CONFIRMATIONS || 1)
const REFRESH_THRESHOLD = Number(process.env.BSV_UTXO_REFRESH_THRESHOLD || 10)

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
      const response = await fetch(
        `https://api.whatsonchain.com/v1/bsv/${WOC_NETWORK}/address/${this.address}/balance`
      )

      if (!response.ok) {
        throw new Error(`Failed to fetch balance: ${response.statusText}`)
      }

      const data = await response.json()
      const confirmedSats = (data && typeof data.confirmed === 'number') ? data.confirmed : 0
      // Return balance in BSV (float) for display, but use UTXOs for spend checks
      const balanceBsv = confirmedSats / 100000000
      return balanceBsv
    } catch (error) {
      console.error('Error fetching wallet balance:', error)
      throw error
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
        
        // Try to get balance for diagnostics
        let balance: number | undefined
        try {
          const tempWallet = new BSVWallet(wif)
          balance = await tempWallet.getBalance()
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

      // Attach corporate verification fields: db_source_hash (if provided) and payload_sha256
      let payloadWithHashes = payloadWithAscii
      try {
        const { sha256CanonicalHex, stringifyCanonical } = await import('./utils')
        const canon = stringifyCanonical(payloadWithAscii)
        const digest = await sha256CanonicalHex(payloadWithAscii)
        const providedDbHash = (data as any)?.payload?.source_hash
        payloadWithHashes = {
          ...((JSON.parse(canon) as any) || payloadWithAscii),
          payload_sha256: digest,
          ...(providedDbHash ? { db_source_hash: providedDbHash } : {}),
        }
      } catch {}

      const providerValue = (data as any)?.payload?.source || 'unknown'
      const base: any = {
        app: APP_NAME,
        data_type: data.stream,
        timestamp: data.timestamp,
        payload: payloadWithHashes,
      }
      // Omit provider for advanced_metrics payloads (per request)
      if (data.stream !== 'advanced_metrics') {
        base.provider = providerValue
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
      const transaction = new (bsv as any).Transaction()
        .from(bitcoreUtxos)
        .addOutput(new bsv.Transaction.Output({
          script: opReturnScript,
          satoshis: useTrueReturn ? 1 : 0,
        }))
        .change(address)
        .feePerKb(FEE_RATE_SAT_PER_BYTE * 1000)
      const signingKey = (bsv as any).PrivateKey.fromWIF(wif)
      transaction.sign(signingKey)

      // Broadcast transaction
      // Prevent double-use of the same cached UTXOs across rapid sends
      let reservedKeys: string[] = []
      try {
        if (ENABLE_UTXO_POOL) {
          reservedKeys = bitcoreUtxos.map((i: any) => `${i.txId}:${i.outputIndex}`)
          this.markUtxosUsed(reservedKeys)
        }
        const txid = await this.broadcastTransaction(transaction.serialize())

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
      try {
        if (bsvConfig.logging.level === 'debug') {
          console.log(`🔁 UTXO cache refreshed: ${cache!.utxos.length} entries for ${address}`)
        }
      } catch {}
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
        ? raw.filter((u: any) => ((u.confirmations || 0) >= MIN_SPEND_CONF) || (u.height && u.height > 0))
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
      .filter((u: any) => ((u.confirmations || 0) >= MIN_SPEND_CONF) || (typeof u.height === 'number' ? u.height > 0 : true))
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
      .filter((u: any) => ((u.confirmations || 0) >= MIN_SPEND_CONF) || (u.height && u.height > 0))
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
          const byHeight = typeof u.height === 'number' ? u.height > 0 : true
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

  private async broadcastTransaction(serializedTx: string): Promise<string> {
    try {
      // Prefer ARC when configured
      const arcKey = process.env.BSV_ARC_API_KEY
      const arcEndpoint = process.env.BSV_API_ENDPOINT || 'https://api.taal.com/arc'
      if (arcKey) {
        try {
          const arcRes = await fetch(`${arcEndpoint.replace(/\/$/, '')}/v1/tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${arcKey}`,
            },
            body: JSON.stringify({ rawTx: serializedTx })
          })
          const arcText = await arcRes.text()
          if (arcRes.ok) {
            try {
              const parsed = JSON.parse(arcText)
              if (parsed && typeof parsed.txid === 'string') {
                // Optional secondary mirror to WOC, disabled by default
                if (MIRROR_TO_WOC) {
                  try {
                    const now = Date.now()
                    this.wocMirrorTimestamps = this.wocMirrorTimestamps.filter(t => now - t < 1000)
                    if (this.wocMirrorTimestamps.length < WOC_MIRROR_MAX_RPS) {
                      this.wocMirrorTimestamps.push(now)
                      const wocNet = WOC_NETWORK
                      fetch(`https://api.whatsonchain.com/v1/bsv/${wocNet}/tx/raw`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ txhex: serializedTx })
                      }).catch(() => {})
                    }
                  } catch {}
                }
                return parsed.txid
              }
            } catch {}
            const txid = arcText.replace(/"/g, '').trim()
            // Optional WOC mirror for string txid response as well
            if (MIRROR_TO_WOC) {
              try {
                const now = Date.now()
                this.wocMirrorTimestamps = this.wocMirrorTimestamps.filter(t => now - t < 1000)
                if (this.wocMirrorTimestamps.length < WOC_MIRROR_MAX_RPS) {
                  this.wocMirrorTimestamps.push(now)
                  const wocNet = WOC_NETWORK
                  fetch(`https://api.whatsonchain.com/v1/bsv/${wocNet}/tx/raw`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ txhex: serializedTx })
                  }).catch(() => {})
                }
              } catch {}
            }
            return txid
          }
          console.warn('ARC broadcast failed, falling back to GorillaPool:', arcText)
        } catch (e) {
          console.warn('ARC broadcast error, falling back to GorillaPool:', e)
        }
      }

      // No fallback - let the transaction fail and be re-queued
      throw new Error(`ARC broadcast failed: ${arcText}`)
    } catch (error) {
      console.error('Error broadcasting transaction:', error)
      throw error
    }
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
      const feePerKb = FEE_RATE_SAT_PER_BYTE * 1000
      const baseOverhead = 200 // bytes rough baseline
      const estimatedFee = Math.ceil((baseOverhead) * FEE_RATE_SAT_PER_BYTE)
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
      const txid = await this.broadcastTransaction(tx.serialize())
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
