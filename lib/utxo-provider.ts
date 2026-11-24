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

// ─── Bitails provider (default) ──────────────────────────────────────────────
// Wallet address UTXO lookups must come from the overlay or an internal/Bitails
// indexer. Bitails pages `/address/{address}/unspent` with from/limit, so a
// wallet holding tens of thousands of dust outputs needs several pages before
// the inventory is complete.
const BITAILS_API_BASE = (process.env.BSV_BITAILS_API_BASE || 'https://api.bitails.io').replace(/\/+$/, '')
const BITAILS_UNSPENT_PAGE_LIMIT = Math.min(
  1000,
  Math.max(1, Math.floor(Number(process.env.BSV_BITAILS_UNSPENT_PAGE_LIMIT || 100))),
)
const BITAILS_UNSPENT_MAX_PAGES = Math.min(
  1000,
  Math.max(1, Math.floor(Number(process.env.BSV_BITAILS_UNSPENT_MAX_PAGES || 50))),
)
const BITAILS_MAX_RETRY_WAIT_MS = Math.max(0, Number(process.env.BSV_BITAILS_MAX_RETRY_WAIT_MS || 3000))
const UTXO_ADDRESS_CONCURRENCY = Math.min(
  8,
  Math.max(1, Math.floor(Number(process.env.BSV_UTXO_ADDRESS_CONCURRENCY || 2))),
)

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

/**
 * Policy gate for WhatsOnChain address UTXO reads.
 *
 * Workspace policy: wallet address UTXO lookups must come from the overlay or a
 * custom internal/Bitails indexer. WhatsOnChain is only permitted as a
 * break-glass path, which requires BOTH an explicit operator opt-in and the
 * global WoC read kill-switch to be clear.
 */
function isWocUtxoReadAllowed(): boolean {
  return process.env.GAIALOG_EMERGENCY_WOC_UTXO === 'true'
    && process.env.GAIALOG_DISABLE_WOC_READS !== 'true'
}

function bitailsHeaders(): HeadersMap {
  const headers: HeadersMap = { Accept: 'application/json' }
  const apiKey = String(process.env.BSV_BITAILS_API_KEY || '').trim()
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Retry-After may be seconds or an HTTP date; cap the wait so callers stay responsive. */
function parseRetryAfterMs(value: string | null): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(BITAILS_MAX_RETRY_WAIT_MS, seconds * 1000)
  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) return Math.min(BITAILS_MAX_RETRY_WAIT_MS, Math.max(0, dateMs - Date.now()))
  return 0
}

type BitailsUnspentRow = {
  txid?: string
  tx_hash?: string
  vout?: number
  tx_pos?: number
  satoshis?: number
  value?: number
  blockheight?: number
  height?: number
  confirmations?: number
}

/**
 * Page `/address/{address}/unspent` until the address is exhausted.
 *
 * Bitails returns `{ scripthash, unspent: [...] }` and pages with from/limit
 * (see lib/wallet-funding-admit.ts). A dust-heavy wallet needs several pages,
 * so paging is capped rather than unbounded: a partial inventory with a loud
 * warning is safer than an unbounded request loop against a third party.
 */
async function fetchBitailsUnspent(address: string, options: GetUnspentOptions): Promise<any[]> {
  const collected: any[] = []
  // Dedupe by outpoint: if the indexer ever ignores `from` and repeats a page,
  // stopping at the page budget must not hand the spend path two entries for
  // one coin.
  const seenOutpoints = new Set<string>()
  let from = 0
  let truncated = false

  for (let page = 0; page < BITAILS_UNSPENT_MAX_PAGES; page++) {
    const url = `${BITAILS_API_BASE}/address/${encodeURIComponent(address)}/unspent?from=${from}&limit=${BITAILS_UNSPENT_PAGE_LIMIT}`
    let attempt = 0
    let rows: BitailsUnspentRow[] = []

    while (true) {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error(`UTXO_FETCH_TIMEOUT:${UTXO_FETCH_TIMEOUT_MS}`)),
        UTXO_FETCH_TIMEOUT_MS,
      )
      try {
        const res = await fetch(url, { headers: bitailsHeaders(), signal: controller.signal })
          .finally(() => clearTimeout(timeout))

        if (!res.ok) {
          const body = await res.text().catch(() => '')
          const retryable = res.status === 429 || (res.status >= 500 && res.status < 600)
          if (!retryable || attempt >= UTXO_FETCH_MAX_RETRIES) {
            // The "NNN " prefix is what the caller's cooldown logic parses.
            throw new Error(`${res.status} Bitails unspent failed: ${(body || res.statusText).slice(0, 200)}`)
          }
          const wait = parseRetryAfterMs(res.headers.get('Retry-After'))
            || (UTXO_FETCH_BACKOFF_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100))
          attempt += 1
          await sleep(wait)
          continue
        }

        const payload = await res.json().catch(() => null)
        const list = Array.isArray(payload)
          ? payload
          : (Array.isArray((payload as any)?.unspent)
            ? (payload as any).unspent
            : (Array.isArray((payload as any)?.utxos) ? (payload as any).utxos : []))
        rows = list as BitailsUnspentRow[]
        break
      } catch (error) {
        clearTimeout(timeout)
        const err = error instanceof Error ? error : new Error(String(error))
        // 429/5xx already exhausted their retries above; network/timeout errors retry here.
        if (attempt >= UTXO_FETCH_MAX_RETRIES || /^\d{3}\b/.test(err.message)) throw err
        attempt += 1
        await sleep(UTXO_FETCH_BACKOFF_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100))
      }
    }

    for (const row of rows) {
      const txid = String(row?.txid || row?.tx_hash || '')
      if (!/^[0-9a-fA-F]{64}$/.test(txid)) continue
      const vout = Number(row?.vout ?? row?.tx_pos ?? 0)
      if (!Number.isInteger(vout) || vout < 0) continue
      const value = Number(row?.satoshis ?? row?.value ?? 0)
      if (!Number.isFinite(value) || value < 0) continue

      const height = Number(row?.blockheight ?? row?.height ?? 0)
      const confirmedHeight = Number.isFinite(height) && height > 0 ? height : undefined
      const rawConfirmations = Number(row?.confirmations)
      // Bitails reports confirmations on mined outputs. When absent but a block
      // height is known, treat it as at least one confirmation rather than
      // reporting a mined output as unspent-but-unconfirmed.
      const confirmations = Number.isFinite(rawConfirmations) && rawConfirmations > 0
        ? Math.floor(rawConfirmations)
        : (confirmedHeight ? 1 : 0)

      if (options.confirmedOnly === true && confirmations <= 0) continue

      const outpoint = `${txid}:${vout}`
      if (seenOutpoints.has(outpoint)) continue
      seenOutpoints.add(outpoint)

      collected.push({
        tx_hash: txid,
        tx_pos: vout,
        value,
        height: confirmedHeight,
        confirmations,
      })
    }

    if (rows.length < BITAILS_UNSPENT_PAGE_LIMIT) {
      truncated = false
      break
    }
    from += rows.length
    truncated = page === BITAILS_UNSPENT_MAX_PAGES - 1
  }

  if (truncated) {
    console.warn(
      `[UTXO Provider] Bitails unspent pagination capped at ${BITAILS_UNSPENT_MAX_PAGES} page(s) ` +
        `(${collected.length} output(s)) for ${address.substring(0, 10)}...; ` +
        `raise BSV_BITAILS_UNSPENT_MAX_PAGES if this wallet holds more.`,
    )
  }

  return collected
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
    const requestedProvider = (process.env.BSV_UTXO_PROVIDER || 'bitails').trim().toLowerCase()
    // Optional custom template for ARC or other indexers: supports {address} and {net}
    const customTemplate = process.env.BSV_UTXO_ENDPOINT_TEMPLATE || process.env.BSV_ARC_UTXO_URL_TEMPLATE || ''
    const customHeadersJson = process.env.BSV_UTXO_HEADERS_JSON || ''
    let lastError: Error | null = null
    const wocPath = options.confirmedOnly ? 'confirmed/unspent' : 'unspent/all'
    const overlayWalletIndex = getWalletIndexForAddress(address)
    const overlayPreferred = overlayWalletIndex != null && String(process.env.BSV_SPEND_SOURCE_MODE || '').trim().toLowerCase() === 'overlay'

    // WoC is a break-glass path only. Refuse the request and fall back to
    // Bitails when the policy gate is closed.
    let provider = requestedProvider
    if (provider === 'woc' && !isWocUtxoReadAllowed()) {
      const blockedBy = process.env.GAIALOG_DISABLE_WOC_READS === 'true'
        ? 'GAIALOG_DISABLE_WOC_READS=true'
        : 'GAIALOG_EMERGENCY_WOC_UTXO is not "true"'
      console.error(
        `[UTXO Provider] POLICY VIOLATION: WoC address UTXO lookup requested for ${address.substring(0, 10)}... ` +
          `but ${blockedBy}. Wallet address UTXO lookups must come from the overlay or a Bitails/internal indexer. ` +
          `Falling back to the bitails provider.`,
      )
      provider = 'bitails'
    }

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

      if (provider === 'woc') {
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
      }

      if (provider !== 'bitails') {
        console.warn(
          `[UTXO Provider] Unsupported BSV_UTXO_PROVIDER="${requestedProvider}"; using the bitails provider. ` +
            `Supported values: bitails, custom, arc (with BSV_UTXO_ENDPOINT_TEMPLATE), woc (emergency only).`,
        )
      }

      const normalized = await fetchBitailsUnspent(address, options)
      cache.utxos = normalized
      cache.fetchedAt = Date.now()
      cache.cooldownUntil = 0
      cache.lastError = undefined
      if (normalized.length > 0 || bsvConfig.logging.level === 'debug') {
        console.log(`[UTXO Provider] Bitails returned ${normalized.length} UTXO(s) for ${address.substring(0, 10)}...`)
      }
      return normalized
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (overlayPreferred) {
        console.error(`[UTXO Provider] Overlay lookup failed for ${address.substring(0, 10)}...:`, lastError.message)
      } else if (provider !== 'woc' && provider !== 'bitails') {
        // Custom/ARC indexers may be down; Bitails is the sanctioned fallback.
        try {
          const normalized = await fetchBitailsUnspent(address, options)
          cache.utxos = normalized
          cache.fetchedAt = Date.now()
          cache.cooldownUntil = 0
          cache.lastError = undefined
          console.log(`[UTXO Provider] Fallback to Bitails returned ${normalized.length} UTXO(s) for ${address.substring(0, 10)}...`)
          return normalized
        } catch (fallbackError) {
          console.error(`[UTXO Provider] Both ${provider} and Bitails fallback failed for ${address.substring(0, 10)}...:`, fallbackError)
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

/**
 * Fetch UTXOs for several addresses.
 *
 * Concurrency is bounded (default 2) rather than unbounded: each address fans
 * out into one or more paginated indexer requests, so a `Promise.all` over a
 * large wallet set turns one caller into a burst that trips the indexer's rate
 * limiter for every other consumer on the box.
 */
export async function getUnspentForAddresses(addresses: string[]): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {}
  const queue = Array.from(new Set((addresses || []).filter(addr => typeof addr === 'string' && addr.length > 0)))
  if (queue.length === 0) return out

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= queue.length) return
      const addr = queue[index]
      try {
        out[addr] = await getUnspentForAddress(addr)
      } catch {
        out[addr] = []
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(UTXO_ADDRESS_CONCURRENCY, queue.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return out
}













