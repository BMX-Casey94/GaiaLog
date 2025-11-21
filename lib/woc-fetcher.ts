/**
 * WhatsOnChain (WoC) data fetcher with wallet rotation and rate limiting
 * Respects 3 RPS limit by using a simple in-memory throttle
 */

import { PrivateKey } from '@bsv/sdk'
import { bsvConfig } from './bsv-config'

const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY

// Simple rate limiter: track last request time per wallet
const lastRequestByWallet = new Map<string, number>()
const MIN_REQUEST_INTERVAL_MS = 350 // ~3 RPS = 333ms, use 350ms for safety

// Round-robin index for wallet selection
let walletRoundRobinIndex = 0

/**
 * Get all configured wallet addresses (derived from private keys)
 */
export function getAllWalletAddresses(): string[] {
  const addresses: string[] = []
  for (const wif of bsvConfig.wallets.privateKeys) {
    if (!wif || wif.length === 0) continue
    try {
      const key = PrivateKey.fromWif(wif)
      const addr = key.toPublicKey().toAddress().toString()
      addresses.push(addr)
    } catch {
      // Skip invalid WIFs
    }
  }
  return addresses
}

/**
 * Get the next wallet address in round-robin fashion
 */
export function getNextWalletAddress(): string | null {
  const addresses = getAllWalletAddresses()
  if (addresses.length === 0) return null
  
  const addr = addresses[walletRoundRobinIndex % addresses.length]
  walletRoundRobinIndex = (walletRoundRobinIndex + 1) % addresses.length
  return addr
}

/**
 * Rate-limited fetch from WoC API
 */
async function fetchWoC(url: string, walletAddr: string): Promise<Response> {
  const now = Date.now()
  const lastRequest = lastRequestByWallet.get(walletAddr) || 0
  const elapsed = now - lastRequest
  
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    // Throttle: wait until we can make the request
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed))
  }
  
  lastRequestByWallet.set(walletAddr, Date.now())
  
  const headers: Record<string, string> = {}
  // WoC API key is optional - can use Authorization header or woc-api-key
  if (WHATSONCHAIN_API_KEY) {
    // Try both header formats (WoC supports both)
    if (WHATSONCHAIN_API_KEY.startsWith('mainnet_') || WHATSONCHAIN_API_KEY.startsWith('testnet_')) {
      headers['Authorization'] = WHATSONCHAIN_API_KEY
    } else {
      headers['woc-api-key'] = WHATSONCHAIN_API_KEY
    }
  }
  
  // Add timeout to prevent hanging
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000) // 10s timeout
  
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    clearTimeout(timeoutId)
    return response
  } catch (error: any) {
    clearTimeout(timeoutId)
    if (error.name === 'AbortError') {
      throw new Error('Request timeout after 10s')
    }
    throw error
  }
}

/**
 * Fetch recent transactions for a wallet address
 * For wallets with 500k+ transactions, we use a different strategy:
 * 1. Try /history endpoint (may return empty for very large wallets)
 * 2. Fallback: Query recent blocks and check for our address
 */
export async function fetchWalletTransactions(
  network: 'main' | 'test',
  walletAddr: string,
  maxResults: number = 50
): Promise<{ tx_hash: string; height: number }[]> {
  const base = `https://api.whatsonchain.com/v1/bsv/${network}/address/${walletAddr}`
  const allTxids = new Set<string>()
  
  // Strategy 1: Try /unspent first (fastest, single API call)
  // This works well for wallets with recent UTXOs
  try {
    const unspentRes = await fetchWoC(`${base}/unspent`, walletAddr)
    if (unspentRes.ok) {
      const unspent: any[] = await unspentRes.json()
      if (Array.isArray(unspent) && unspent.length > 0) {
        unspent.forEach((u: any) => {
          if (u.tx_hash) allTxids.add(u.tx_hash)
        })
        console.log(`[WoC] Got ${allTxids.size} transaction IDs from /unspent for ${walletAddr.substring(0, 10)}...`)
      }
    }
  } catch (error: any) {
    console.log(`[WoC] /unspent failed: ${error.message}`)
  }
  
  // Strategy 2: If /unspent didn't give us enough, try /history to get more
  // This helps when wallets have spent most UTXOs
  if (allTxids.size < maxResults) {
    try {
      const listRes = await fetchWoC(`${base}/history`, walletAddr)
      if (listRes.ok) {
        const txsRaw: any = await listRes.json()
        const txs: string[] = Array.isArray(txsRaw)
          ? (txsRaw[0]?.tx_hash ? txsRaw.map((t: any) => t.tx_hash) : (typeof txsRaw[0] === 'string' ? txsRaw : []))
          : []
        
        txs.forEach((txid: string) => {
          if (txid && typeof txid === 'string') allTxids.add(txid)
        })
        console.log(`[WoC] Combined with /history: now have ${allTxids.size} total transaction IDs for ${walletAddr.substring(0, 10)}...`)
      }
    } catch (error: any) {
      console.log(`[WoC] /history failed: ${error.message}`)
    }
  }
  
  // Strategy 3: If still not enough, try /txs endpoint
  if (allTxids.size < maxResults) {
    try {
      const txsRes = await fetchWoC(`${base}/txs`, walletAddr)
      if (txsRes.ok) {
        const txsRaw: any = await txsRes.json()
        const txs: string[] = Array.isArray(txsRaw)
          ? (txsRaw[0]?.tx_hash ? txsRaw.map((t: any) => t.tx_hash) : (typeof txsRaw[0] === 'string' ? txsRaw : []))
          : []
        
        txs.forEach((txid: string) => {
          if (txid && typeof txid === 'string') allTxids.add(txid)
        })
        console.log(`[WoC] Combined with /txs: now have ${allTxids.size} total transaction IDs for ${walletAddr.substring(0, 10)}...`)
      }
    } catch (error: any) {
      console.log(`[WoC] /txs failed: ${error.message}`)
    }
  }
  
  // Convert to array and return
  if (allTxids.size > 0) {
    const txArray = Array.from(allTxids).slice(0, maxResults).map(txid => ({
      tx_hash: txid,
      height: 0,
    }))
    console.log(`[WoC] Returning ${txArray.length} transaction IDs for ${walletAddr.substring(0, 10)}...`)
    return txArray
  }
  
  // For very large wallets (500k+), block search is too slow
  // Return empty and let the caller handle it
  console.log(`[WoC] No transactions found via fast endpoints for ${walletAddr.substring(0, 10)}... (wallet may have 500k+ transactions)`)
  return []
}

/**
 * Fetch and decode a transaction's OP_RETURN data
 */
export async function fetchTxOpReturn(
  network: 'main' | 'test',
  txid: string,
  walletAddr: string
): Promise<{ data_type: string; payload: any; timestamp: number; provider?: string } | null> {
  const txRes = await fetchWoC(`https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}`, walletAddr)
  if (!txRes.ok) return null
  
  const j = await txRes.json()
  const vout = Array.isArray(j?.vout) ? j.vout : []
  
  // Try to find OP_RETURN output - check both asm and hex
  let opret: any = null
  let scriptHex: string | null = null
  
  for (const o of vout) {
    const asm = String(o?.scriptPubKey?.asm || '')
    const hex = String(o?.scriptPubKey?.hex || '')
    
    if (asm.includes('OP_RETURN') || hex.startsWith('006a') || hex.startsWith('516a')) {
      opret = o
      scriptHex = hex || null
      break
    }
  }
  
  if (!opret) return null
  
  // Parse from ASM if available, otherwise try hex
  let pushes: string[] = []
  let tagHex = ''
  let dataHex = ''
  
  if (opret.scriptPubKey?.asm) {
    const parts = String(opret.scriptPubKey.asm).split(' ')
    const idx = parts.indexOf('OP_RETURN')
    if (idx >= 0) {
      pushes = parts.slice(idx + 1)
      if (pushes.length >= 3) {
        tagHex = pushes[0]
        dataHex = pushes[2]
      }
    }
  }
  
  // Fallback: try parsing from hex directly
  if (!tagHex && scriptHex) {
    try {
      const { parsePushes } = await import('./opreturn-validator')
      const parsed = parsePushes(scriptHex)
      if (parsed.pushes.length >= 3) {
        tagHex = parsed.pushes[0].toString('hex')
        dataHex = parsed.pushes[2].toString('hex')
      }
    } catch {
      // Continue with ASM parsing
    }
  }
  
  if (!tagHex || !dataHex) return null
  
  // Check tag
  try {
    const tag = Buffer.from(tagHex, 'hex').toString('utf8')
    if (tag !== 'GaiaLog') return null
  } catch {
    return null
  }
  
  // Check for optional encoding flag
  const extras = pushes.slice(3)
  const encodingHex = Buffer.from('encoding=gzip', 'utf8').toString('hex')
  const isGzip = extras.some(e => {
    try {
      return Buffer.from(e, 'hex').toString('utf8') === 'encoding=gzip'
    } catch {
      return false
    }
  })
  
  try {
    const raw = Buffer.from(dataHex, 'hex')
    const { gunzipSync } = await import('zlib')
    const bytes = isGzip ? gunzipSync(raw) : raw
    const txt = bytes.toString('utf8')
    const parsed = JSON.parse(txt)
    
    return {
      data_type: parsed?.data_type || '',
      payload: parsed?.payload || {},
      timestamp: parsed?.timestamp || Date.now(),
      provider: parsed?.provider,
    }
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[WoC] Failed to decode OP_RETURN for ${txid.substring(0, 12)}...:`, error.message)
    }
    return null
  }
}

/**
 * Find the latest transaction of a specific data_type across all wallets
 */
export async function findLatestByType(
  network: 'main' | 'test',
  dataType: 'air_quality' | 'water_levels' | 'seismic_activity' | 'advanced_metrics',
  maxCandidatesPerWallet: number = 20 // Increased to 20 to find all data types (still fast)
): Promise<{ data_type: string; payload: any; timestamp: number; provider?: string; txid: string } | null> {
  const addresses = getAllWalletAddresses()
  if (addresses.length === 0) {
    console.warn('[WoC] No wallet addresses found - check BSV_WALLET_*_PRIVATE_KEY env vars')
    return null
  }
  
  // Map of data_type variations (handle legacy/alternate names)
  const dataTypeVariations: Record<string, string[]> = {
    'air_quality': ['air_quality'],
    'water_levels': ['water_levels', 'water'], // Handle both
    'seismic_activity': ['seismic_activity', 'seismic'],
    'advanced_metrics': ['advanced_metrics'],
  }
  
  const validTypes = dataTypeVariations[dataType] || [dataType]
  
  // Search wallets in order, but stop as soon as we find a match
  // This minimizes API calls and prevents timeout
  for (const addr of addresses) {
    try {
      // Get transactions (limited to avoid timeout)
      const txs = await fetchWalletTransactions(network, addr, maxCandidatesPerWallet)
      if (txs.length === 0) {
        console.log(`[WoC] No transactions found for wallet ${addr.substring(0, 10)}...`)
        continue
      }
      
      // Only check first 25 transactions (early exit to save time)
      const candidates = txs.slice(0, maxCandidatesPerWallet)
      console.log(`[WoC] Checking ${candidates.length} transactions from wallet ${addr.substring(0, 10)}... for type ${dataType}`)
      
      // Check transactions one by one, stop on first match
      for (const t of candidates) {
        try {
          const decoded = await fetchTxOpReturn(network, t.tx_hash, addr)
          if (decoded) {
            // Check if data_type matches (including variations)
            if (validTypes.includes(decoded.data_type)) {
              console.log(`[WoC] Found ${dataType} transaction: ${t.tx_hash.substring(0, 12)}...`)
              return {
                ...decoded,
                txid: t.tx_hash,
              }
            }
          }
        } catch (err) {
          // Skip individual transaction errors, continue searching
          continue
        }
      }
    } catch (error: any) {
      // Continue to next wallet on error
      console.warn(`[WoC] Fetch error for wallet ${addr.substring(0, 10)}...:`, error.message)
      continue
    }
  }
  
  console.log(`[WoC] No ${dataType} transactions found across ${addresses.length} wallet(s)`)
  return null
}

