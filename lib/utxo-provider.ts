import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import { AuthFetch } from '@bsv/sdk/auth'
import { ProtoWallet } from '@bsv/sdk/wallet'
import { bsvConfig } from './bsv-config'
import { getOverlayClientAuthConfig } from './overlay-config'
import { walletManager } from './wallet-manager'

type HeadersMap = Record<string, string>
type GetUnspentOptions = {
  allowDegradedStale?: boolean
  confirmedOnly?: boolean
}

const NET = bsvConfig.network === 'mainnet' ? 'main' : 'test'
const DEFAULT_TOPIC_PREFIX = 'TREASURY'
const DEFAULT_TOPIC_VERSION = 'v1'
const DEFAULT_OVERLAY_PROVIDER_ID = 'donations-lookup'
const UTXO_FETCH_BACKOFF_BASE_MS = Number(process.env.BSV_UTXO_FETCH_BACKOFF_BASE_MS || 250)
const UTXO_FETCH_MAX_RETRIES = Number(process.env.BSV_UTXO_FETCH_MAX_RETRIES || 4)
const UTXO_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.BSV_UTXO_FETCH_TIMEOUT_MS || 15000))
const UTXO_CACHE_TTL_MS = Math.max(1000, Number(process.env.BSV_UTXO_CACHE_TTL_MS || 10000))
const UTXO_STALE_TTL_MS = Math.max(5000, Number(process.env.BSV_UTXO_STALE_TTL_MS || 120000))
const UTXO_DEGRADED_STALE_TTL_MS = Math.max(UTXO_STALE_TTL_MS, Number(process.env.BSV_UTXO_DEGRADED_STALE_TTL_MS || 15 * 60 * 1000))
const UTXO_ERROR_COOLDOWN_MS = Math.max(1000, Number(process.env.BSV_UTXO_ERROR_COOLDOWN_MS || 20000))
const UTXO_429_COOLDOWN_MS = Math.max(1000, Number(process.env.BSV_UTXO_429_COOLDOWN_MS || 60000))
const UTXO_DEGRADED_LOG_INTERVAL_MS = Math.max(10000, Number(process.env.BSV_UTXO_DEGRADED_LOG_INTERVAL_MS || 60000))
const OVERLAY_UTXO_LIST_LIMIT = Math.max(1, Number(process.env.BSV_OVERLAY_UTXO_LIST_LIMIT || 10000))

type OverlayLookupConfig = {
  providerId: string
  lookupUrl: string | null
  lookupHeaders: HeadersMap
  timeoutMs: number
  maxRetries: number
  utxoListLimit: number
}

type UtxoCacheEntry = {
  fetchedAt: number
  utxos: any[]
  inFlight: Promise<any[]> | null
  cooldownUntil: number
  lastError?: string
  lastDegradedLogAt?: number
}

const utxoCacheByAddress = new Map<string, UtxoCacheEntry>()
let overlayAuthFetchSingleton: AuthFetch | null | undefined

function getCacheEntry(address: string): UtxoCacheEntry {
  let entry = utxoCacheByAddress.get(address)
  if (!entry) {
    entry = { fetchedAt: 0, utxos: [], inFlight: null, cooldownUntil: 0, lastDegradedLogAt: 0 }
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

function parseHeadersJson(value: string | undefined): HeadersMap {
  if (!value || value.trim() === '') return {}
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).map(([key, val]) => [String(key), String(val)])
    )
  } catch {
    return {}
  }
}

function normaliseTopicPrefix(value: string | undefined): string {
  const safe = String(value || DEFAULT_TOPIC_PREFIX).trim()
  return safe ? safe.toUpperCase() : DEFAULT_TOPIC_PREFIX
}

function normaliseTopicVersion(value: string | undefined): string {
  const safe = String(value || DEFAULT_TOPIC_VERSION).trim()
  return safe || DEFAULT_TOPIC_VERSION
}

function buildTreasuryTopic(walletIndex: number): string {
  const safeIndex = Math.max(0, Math.floor(walletIndex))
  const prefix = normaliseTopicPrefix(process.env.BSV_OVERLAY_TOPIC_PREFIX)
  const version = normaliseTopicVersion(process.env.BSV_OVERLAY_TOPIC_VERSION)
  return `${prefix}:${version}:W${safeIndex + 1}`
}

function getWalletIndexForAddress(address: string): number | null {
  const addresses = walletManager.getAllWalletAddresses()
  const index = addresses.findIndex(candidate => candidate === address)
  return index >= 0 ? index : null
}

function getOverlayLookupConfig(): OverlayLookupConfig {
  const sharedHeaders = parseHeadersJson(process.env.BSV_OVERLAY_HEADERS_JSON)
  return {
    providerId: String(process.env.BSV_OVERLAY_PROVIDER_ID || DEFAULT_OVERLAY_PROVIDER_ID).trim() || DEFAULT_OVERLAY_PROVIDER_ID,
    lookupUrl: String(process.env.BSV_OVERLAY_LOOKUP_URL || '').trim() || null,
    lookupHeaders: {
      ...sharedHeaders,
      ...parseHeadersJson(process.env.BSV_OVERLAY_LOOKUP_HEADERS_JSON),
    },
    timeoutMs: Math.max(1000, Number(process.env.BSV_OVERLAY_TIMEOUT_MS || 15000)),
    maxRetries: Math.max(0, Number(process.env.BSV_OVERLAY_MAX_RETRIES || 3)),
    utxoListLimit: OVERLAY_UTXO_LIST_LIMIT,
  }
}

function getOverlayAuthFetch(): AuthFetch | null {
  if (overlayAuthFetchSingleton !== undefined) return overlayAuthFetchSingleton

  const authConfig = getOverlayClientAuthConfig()
  if (authConfig.mode !== 'brc104') {
    overlayAuthFetchSingleton = null
    return overlayAuthFetchSingleton
  }

  if (!authConfig.identityWif) {
    throw new Error('BSV_OVERLAY_CLIENT_IDENTITY_WIF is required when BSV_OVERLAY_AUTH_MODE=brc104')
  }

  overlayAuthFetchSingleton = new AuthFetch(
    new ProtoWallet(SDKPrivateKey.fromWif(authConfig.identityWif)) as any,
  )
  return overlayAuthFetchSingleton
}

function assertOverlayAuthHeadersSupported(headers: HeadersMap): void {
  const authFetch = getOverlayAuthFetch()
  if (!authFetch) return

  for (const key of Object.keys(headers)) {
    const safe = key.toLowerCase()
    if (safe === 'authorization' || safe === 'content-type' || safe.startsWith('x-bsv-')) continue
    throw new Error(
      `Unsupported overlay header "${key}" for BRC-104 requests. Use "authorization" or "x-bsv-*" headers only.`,
    )
  }
}

function safeParseJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function postOverlayLookupWithRetry(
  url: string,
  headers: HeadersMap,
  body: unknown,
  timeoutMs: number,
  maxRetries: number,
): Promise<any> {
  let attempt = 0
  let lastError: Error | null = null

  while (attempt <= maxRetries) {
    try {
      const requestHeaders = {
        'content-type': 'application/json',
        ...headers,
      }
      assertOverlayAuthHeadersSupported(requestHeaders)
      const authFetch = getOverlayAuthFetch()
      const response = authFetch
        ? await new Promise<Response>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new Error(`Overlay lookup timed out after ${timeoutMs}ms`))
            }, timeoutMs)

            authFetch.fetch(url, {
              method: 'POST',
              headers: requestHeaders,
              body,
            })
              .then((value) => {
                clearTimeout(timeoutId)
                resolve(value)
              })
              .catch((error) => {
                clearTimeout(timeoutId)
                reject(error)
              })
          })
        : await (async () => {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
            try {
              return await fetch(url, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(body),
                signal: controller.signal,
              })
            } finally {
              clearTimeout(timeoutId)
            }
          })()

      const text = await response.text().catch(() => '')
      if (response.ok) return text ? safeParseJson(text) : {}

      lastError = new Error(`HTTP ${response.status} ${text || response.statusText}`.trim())
      if (!(response.status === 429 || response.status >= 500) || attempt >= maxRetries) {
        throw lastError
      }
    } catch (error) {
      if (!lastError) lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt >= maxRetries) throw lastError
      const delay = Math.min(5000, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 100)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    attempt += 1
  }

  throw lastError || new Error('Overlay lookup failed')
}

function extractLookupItems(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.outputs)) return payload.outputs
  if (Array.isArray(payload?.items)) return payload.items
  if (Array.isArray(payload?.results)) return payload.results
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function isOverlayUtxoConfirmed(item: any): boolean {
  if (typeof item?.confirmed === 'boolean') return item.confirmed
  const confirmations = Number(item?.confirmations || 0)
  const height = typeof item?.height === 'number'
    ? item.height
    : (typeof item?.blockHeight === 'number' ? item.blockHeight : null)
  return confirmations > 0 || (height != null && height > 0)
}

function normaliseOverlayUtxos(payload: any): any[] {
  return extractLookupItems(payload)
    .map((item: any) => {
      const confirmed = isOverlayUtxoConfirmed(item)
      const height = typeof item?.height === 'number'
        ? item.height
        : (typeof item?.blockHeight === 'number' ? item.blockHeight : (confirmed ? 1 : 0))
      return {
        tx_hash: String(item?.tx_hash || item?.txid || item?.hash || ''),
        tx_pos: Number(item?.tx_pos ?? item?.vout ?? item?.outputIndex ?? 0),
        value: Number(item?.value ?? item?.satoshis ?? item?.amountSats ?? 0),
        height,
        confirmations: confirmed ? Math.max(1, Number(item?.confirmations || 1)) : 0,
        script: typeof item?.outputScript === 'string'
          ? item.outputScript
          : (typeof item?.lockingScript === 'string' ? item.lockingScript : undefined),
        rawTx: typeof item?.rawTx === 'string' ? item.rawTx : undefined,
        proof: item?.proof ?? item?.beef ?? undefined,
      }
    })
    .filter((item: any) => item.tx_hash.length > 0)
}

async function getOverlayUtxosForAddress(address: string, options: GetUnspentOptions = {}): Promise<any[] | null> {
  const spendSourceMode = String(process.env.BSV_SPEND_SOURCE_MODE || '').trim().toLowerCase()
  if (spendSourceMode !== 'overlay') return null

  const walletIndex = getWalletIndexForAddress(address)
  if (walletIndex == null) return null

  const overlay = getOverlayLookupConfig()
  if (!overlay.lookupUrl) {
    throw new Error('Overlay lookup URL not configured for treasury wallet UTXO lookup')
  }

  const payload = await postOverlayLookupWithRetry(
    overlay.lookupUrl,
    overlay.lookupHeaders,
    {
      provider: overlay.providerId,
      query: {
        topic: buildTreasuryTopic(walletIndex),
        minSatoshis: 0,
        limit: overlay.utxoListLimit,
        order: 'desc',
        excludeReserved: false,
        confirmedOnly: options.confirmedOnly === true,
      },
      countOnly: false,
      includeTotal: true,
    },
    overlay.timeoutMs,
    overlay.maxRetries,
  )

  return normaliseOverlayUtxos(payload)
}

function replaceTemplate(template: string, address: string): string {
  return template.replace(/\{address\}/g, address).replace(/\{net\}/g, NET)
}

async function fetchWithRetry(url: string, headers: HeadersMap = {}, maxRetries = UTXO_FETCH_MAX_RETRIES): Promise<Response> {
  let attempt = 0
  while (true) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error(`UTXO_FETCH_TIMEOUT:${UTXO_FETCH_TIMEOUT_MS}`)), UTXO_FETCH_TIMEOUT_MS)
      const res = await fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(timeout))
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

function extractUtxoList(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.result)) return payload.result
  return []
}

function maybeUseCachedUtxos(address: string, cache: UtxoCacheEntry, now: number, reason: string, options: GetUnspentOptions = {}): any[] | null {
  if (cache.utxos.length === 0 || cache.fetchedAt <= 0) return null
  const ageMs = now - cache.fetchedAt
  const maxAgeMs = options.allowDegradedStale ? UTXO_DEGRADED_STALE_TTL_MS : UTXO_STALE_TTL_MS
  if (ageMs > maxAgeMs) return null

  if (ageMs <= UTXO_STALE_TTL_MS) {
    if (bsvConfig.logging.level === 'debug') {
      console.log(`[UTXO Provider] Using stale cached UTXOs for ${address.substring(0, 10)}... (${reason})`)
    }
    return cache.utxos
  }

  if (!options.allowDegradedStale) return null

  const lastLogAt = cache.lastDegradedLogAt || 0
  if ((now - lastLogAt) >= UTXO_DEGRADED_LOG_INTERVAL_MS) {
    console.warn(`[UTXO Provider] Using degraded stale UTXO cache for ${address.substring(0, 10)}... (${cache.utxos.length} cached, age=${Math.round(ageMs / 1000)}s, reason=${reason})`)
    cache.lastDegradedLogAt = now
  }
  return cache.utxos
}

export async function getUnspentForAddress(address: string, options: GetUnspentOptions = {}): Promise<any[]> {
  const now = Date.now()
  const cache = getCacheEntry(address)
  if (cache.inFlight) return cache.inFlight
  if (cache.utxos.length > 0 && (now - cache.fetchedAt) <= UTXO_CACHE_TTL_MS) {
    return cache.utxos
  }
  if (cache.cooldownUntil > now) {
    const stale = maybeUseCachedUtxos(address, cache, now, 'provider cooldown', options)
    if (stale) return stale
    return []
  }

  const fetchPromise = (async (): Promise<any[]> => {
    const provider = (process.env.BSV_UTXO_PROVIDER || 'woc').toLowerCase()
    // Optional custom template for ARC or other indexers: supports {address} and {net}
    const customTemplate = process.env.BSV_UTXO_ENDPOINT_TEMPLATE || process.env.BSV_ARC_UTXO_URL_TEMPLATE || ''
    const customHeadersJson = process.env.BSV_UTXO_HEADERS_JSON || ''
    let lastError: Error | null = null
    const wocPath = options.confirmedOnly ? 'confirmed/unspent' : 'unspent/all'
    const overlayWalletIndex = getWalletIndexForAddress(address)
    const overlayPreferred = overlayWalletIndex != null && String(process.env.BSV_SPEND_SOURCE_MODE || '').trim().toLowerCase() === 'overlay'

    try {
      if (overlayPreferred) {
        const overlayUtxos = await getOverlayUtxosForAddress(address, options)
        if (overlayUtxos) {
          cache.utxos = overlayUtxos
          cache.fetchedAt = Date.now()
          cache.cooldownUntil = 0
          cache.lastError = undefined
          if (overlayUtxos.length > 0 || bsvConfig.logging.level === 'debug') {
            console.log(`[UTXO Provider] Overlay returned ${overlayUtxos.length} UTXO(s) for ${address.substring(0, 10)}...`)
          }
          return overlayUtxos
        }
      }

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
        const normalized = normaliseUtxoShape(extractUtxoList(data))
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
      const url = `https://api.whatsonchain.com/v1/bsv/${NET}/address/${address}/${wocPath}`
      const res = await fetchWithRetry(url, buildHeaders())
      const data = await res.json().catch(() => [])
      const normalized = normaliseUtxoShape(extractUtxoList(data))
      cache.utxos = normalized
      cache.fetchedAt = Date.now()
      cache.cooldownUntil = 0
      cache.lastError = undefined

      // Log if we got empty results (might indicate an issue)
      if (normalized.length === 0) {
        console.log(`[UTXO Provider] WhatsOnChain returned 0 UTXOs for ${address.substring(0, 10)}... (status: ${res.status}, path=${wocPath})`)
      } else if (bsvConfig.logging.level === 'debug') {
        console.log(`[UTXO Provider] WhatsOnChain returned ${normalized.length} UTXO(s) for ${address.substring(0, 10)}... (path=${wocPath})`)
      }

      return normalized
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (overlayPreferred) {
        console.error(`[UTXO Provider] Overlay lookup failed for ${address.substring(0, 10)}...:`, lastError.message)
      } else if (provider !== 'woc') {
        try {
          const url = `https://api.whatsonchain.com/v1/bsv/${NET}/address/${address}/${wocPath}`
          const res = await fetchWithRetry(url, buildHeaders())
          const data = await res.json().catch(() => [])
          const normalized = normaliseUtxoShape(extractUtxoList(data))
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

      const stale = maybeUseCachedUtxos(address, cache, Date.now(), `fetch failure: ${msg || 'unknown'}`, options)
      if (stale) return stale
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













