import { bsvConfig } from './bsv-config'

type HeadersMap = Record<string, string>

const NET = bsvConfig.network === 'mainnet' ? 'main' : 'test'
const UTXO_FETCH_BACKOFF_BASE_MS = Number(process.env.BSV_UTXO_FETCH_BACKOFF_BASE_MS || 250)
const UTXO_FETCH_MAX_RETRIES = Number(process.env.BSV_UTXO_FETCH_MAX_RETRIES || 4)
const UTXO_CACHE_TTL_MS = Math.max(1000, Number(process.env.BSV_UTXO_CACHE_TTL_MS || 10000))
const UTXO_STALE_TTL_MS = Math.max(5000, Number(process.env.BSV_UTXO_STALE_TTL_MS || 120000))
const UTXO_ERROR_COOLDOWN_MS = Math.max(1000, Number(process.env.BSV_UTXO_ERROR_COOLDOWN_MS || 20000))
const UTXO_429_COOLDOWN_MS = Math.max(1000, Number(process.env.BSV_UTXO_429_COOLDOWN_MS || 60000))

type UtxoCacheEntry = {
  fetchedAt: number
  utxos: any[]
  inFlight: Promise<any[]> | null
  cooldownUntil: number
  lastError?: string
}

const utxoCacheByAddress = new Map<string, UtxoCacheEntry>()

function getCacheEntry(address: string): UtxoCacheEntry {
  let entry = utxoCacheByAddress.get(address)
  if (!entry) {
    entry = { fetchedAt: 0, utxos: [], inFlight: null, cooldownUntil: 0 }
    utxoCacheByAddress.set(address, entry)
  }
  return entry
}

function buildHeaders(base?: HeadersMap): HeadersMap {
  const headers: HeadersMap = { ...(base || {}) }
  const wocKey = process.env.WHATSONCHAIN_API_KEY
  if (wocKey) {
    if (wocKey.startsWith('mainnet_') || wocKey.startsWith('testnet_')) {
      headers['Authorization'] = wocKey
    } else {
      headers['woc-api-key'] = wocKey
    }
  }
  return headers
}

function replaceTemplate(template: string, address: string): string {
  return template.replace(/\{address\}/g, address).replace(/\{net\}/g, NET)
}

async function fetchWithRetry(url: string, headers: HeadersMap = {}, maxRetries = UTXO_FETCH_MAX_RETRIES): Promise<Response> {
  let attempt = 0
  while (true) {
    try {
      const res = await fetch(url, { headers })
      if (res.ok) return res
      const status = res.status
      const body = await res.text().catch(() => '')
      const retryable = status === 429 || (status >= 500 && status < 600)
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`${status} ${body || res.statusText}`)
      }
      const retryAfter = res.headers.get('Retry-After')
      const base = retryAfter ? Number(retryAfter) * 1000 : UTXO_FETCH_BACKOFF_BASE_MS * Math.pow(2, attempt)
      const jitter = Math.floor(Math.random() * 100)
      await new Promise(r => setTimeout(r, base + jitter))
      attempt++
    } catch (e) {
      if (attempt >= maxRetries) throw e
      const delay = UTXO_FETCH_BACKOFF_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100)
      await new Promise(r => setTimeout(r, delay))
      attempt++
    }
  }
}

function normaliseUtxoShape(list: any[]): any[] {
  // Pass-through common WOC shape: { tx_hash, tx_pos, value, height?, confirmations? }
  if (list.length > 0 && 'tx_hash' in list[0] && 'tx_pos' in list[0]) return list
  // Map common { txid, vout, satoshis/value } to expected fields
  return list.map((u: any) => ({
    tx_hash: u.tx_hash || u.txid || u.hash || u.txId,
    tx_pos: u.tx_pos ?? u.vout ?? u.outputIndex ?? 0,
    value: u.value ?? u.satoshis ?? u.amountSats ?? 0,
    height: typeof u.height === 'number' ? u.height : (typeof u.blockHeight === 'number' ? u.blockHeight : undefined),
    confirmations: typeof u.confirmations === 'number' ? u.confirmations : undefined,
  }))
}

export async function getUnspentForAddress(address: string): Promise<any[]> {
  const now = Date.now()
  const cache = getCacheEntry(address)
  if (cache.inFlight) return cache.inFlight
  if (cache.utxos.length > 0 && (now - cache.fetchedAt) <= UTXO_CACHE_TTL_MS) {
    return cache.utxos
  }
  if (cache.cooldownUntil > now) {
    if (cache.utxos.length > 0 && (now - cache.fetchedAt) <= UTXO_STALE_TTL_MS) {
      if (bsvConfig.logging.level === 'debug') {
        console.log(`[UTXO Provider] Using stale cached UTXOs for ${address.substring(0, 10)}... during cooldown`)
      }
      return cache.utxos
    }
    return []
  }

  const fetchPromise = (async (): Promise<any[]> => {
  const provider = (process.env.BSV_UTXO_PROVIDER || 'woc').toLowerCase()
  // Optional custom template for ARC or other indexers: supports {address} and {net}
  const customTemplate = process.env.BSV_UTXO_ENDPOINT_TEMPLATE || process.env.BSV_ARC_UTXO_URL_TEMPLATE || ''
  const customHeadersJson = process.env.BSV_UTXO_HEADERS_JSON || ''
  let lastError: Error | null = null
  
  try {
    if (provider === 'custom' || (provider === 'arc' && customTemplate)) {
      const headers: HeadersMap = (() => {
        try { return JSON.parse(customHeadersJson || '{}') } catch { return {} }
      })()
      // If using ARC with bearer, allow fallback to BSV_ARC_API_KEY
      if (!headers['Authorization'] && process.env.BSV_ARC_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.BSV_ARC_API_KEY}`
      }
      const url = replaceTemplate(customTemplate, address)
      const res = await fetchWithRetry(url, headers)
      const data = await res.json().catch(() => [])
      const normalized = Array.isArray(data) ? normaliseUtxoShape(data) : []
      cache.utxos = normalized
      cache.fetchedAt = Date.now()
      cache.cooldownUntil = 0
      cache.lastError = undefined
      if (normalized.length > 0 || bsvConfig.logging.level === 'debug') {
        console.log(`[UTXO Provider] ${provider} returned ${normalized.length} UTXO(s) for ${address.substring(0, 10)}...`)
      }
      return normalized
    }

    // Default: WhatsOnChain
    const url = `https://api.whatsonchain.com/v1/bsv/${NET}/address/${address}/unspent`
    const res = await fetchWithRetry(url, buildHeaders())
    const data = await res.json().catch(() => [])
    const normalized = Array.isArray(data) ? normaliseUtxoShape(data) : []
    cache.utxos = normalized
    cache.fetchedAt = Date.now()
    cache.cooldownUntil = 0
    cache.lastError = undefined
    
    // Log if we got empty results (might indicate an issue)
    if (normalized.length === 0) {
      console.log(`[UTXO Provider] WhatsOnChain returned 0 UTXOs for ${address.substring(0, 10)}... (status: ${res.status})`)
    } else if (bsvConfig.logging.level === 'debug') {
      console.log(`[UTXO Provider] WhatsOnChain returned ${normalized.length} UTXO(s) for ${address.substring(0, 10)}...`)
    }
    
    return normalized
  } catch (e) {
    lastError = e instanceof Error ? e : new Error(String(e))
    // On provider failure, attempt a single fallback to WOC unless we already used WOC
    if (provider !== 'woc') {
      try {
        const url = `https://api.whatsonchain.com/v1/bsv/${NET}/address/${address}/unspent`
        const res = await fetchWithRetry(url, buildHeaders())
        const data = await res.json().catch(() => [])
        const normalized = Array.isArray(data) ? normaliseUtxoShape(data) : []
        cache.utxos = normalized
        cache.fetchedAt = Date.now()
        cache.cooldownUntil = 0
        cache.lastError = undefined
        console.log(`[UTXO Provider] Fallback to WOC returned ${normalized.length} UTXO(s) for ${address.substring(0, 10)}...`)
        return normalized
      } catch (fallbackError) {
        console.error(`[UTXO Provider] Both ${provider} and WOC fallback failed for ${address.substring(0, 10)}...:`, fallbackError)
      }
    } else {
      console.error(`[UTXO Provider] Failed to fetch UTXOs for ${address.substring(0, 10)}...:`, lastError.message)
    }
    const msg = lastError?.message || ''
    const statusMatch = msg.match(/^(\d{3})\b/)
    const statusCode = statusMatch ? Number(statusMatch[1]) : 0
    const cooldown = statusCode === 429 ? UTXO_429_COOLDOWN_MS : UTXO_ERROR_COOLDOWN_MS
    cache.cooldownUntil = Date.now() + cooldown
    cache.lastError = msg

    if (cache.utxos.length > 0 && (Date.now() - cache.fetchedAt) <= UTXO_STALE_TTL_MS) {
      console.warn(`[UTXO Provider] Using stale UTXO cache for ${address.substring(0, 10)}... after fetch failure (${msg})`)
      return cache.utxos
    }
    return []
  }
  })().finally(() => {
    cache.inFlight = null
  })
  cache.inFlight = fetchPromise
  return fetchPromise
}

export async function getUnspentForAddresses(addresses: string[]): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {}
  await Promise.all(addresses.map(async (addr) => {
    try { out[addr] = await getUnspentForAddress(addr) } catch { out[addr] = [] }
  }))
  return out
}













