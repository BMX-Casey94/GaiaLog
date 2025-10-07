import { bsvConfig } from './bsv-config'

type HeadersMap = Record<string, string>

const NET = bsvConfig.network === 'mainnet' ? 'main' : 'test'

function buildHeaders(base?: HeadersMap): HeadersMap {
  const headers: HeadersMap = { ...(base || {}) }
  const wocKey = process.env.WHATSONCHAIN_API_KEY
  if (wocKey) headers['woc-api-key'] = wocKey
  return headers
}

function replaceTemplate(template: string, address: string): string {
  return template.replace(/\{address\}/g, address).replace(/\{net\}/g, NET)
}

async function fetchWithRetry(url: string, headers: HeadersMap = {}, maxRetries = 4): Promise<Response> {
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
      const base = retryAfter ? Number(retryAfter) * 1000 : 250 * Math.pow(2, attempt)
      const jitter = Math.floor(Math.random() * 100)
      await new Promise(r => setTimeout(r, base + jitter))
      attempt++
    } catch (e) {
      if (attempt >= maxRetries) throw e
      const delay = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 100)
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
  const provider = (process.env.BSV_UTXO_PROVIDER || 'woc').toLowerCase()
  // Optional custom template for ARC or other indexers: supports {address} and {net}
  const customTemplate = process.env.BSV_UTXO_ENDPOINT_TEMPLATE || process.env.BSV_ARC_UTXO_URL_TEMPLATE || ''
  const customHeadersJson = process.env.BSV_UTXO_HEADERS_JSON || ''
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
      return Array.isArray(data) ? normaliseUtxoShape(data) : []
    }

    // Default: WhatsOnChain
    const url = `https://api.whatsonchain.com/v1/bsv/${NET}/address/${address}/unspent`
    const res = await fetchWithRetry(url, buildHeaders())
    const data = await res.json().catch(() => [])
    return Array.isArray(data) ? normaliseUtxoShape(data) : []
  } catch (e) {
    // On provider failure, attempt a single fallback to WOC unless we already used WOC
    if (provider !== 'woc') {
      try {
        const url = `https://api.whatsonchain.com/v1/bsv/${NET}/address/${address}/unspent`
        const res = await fetchWithRetry(url, buildHeaders())
        const data = await res.json().catch(() => [])
        return Array.isArray(data) ? normaliseUtxoShape(data) : []
      } catch {}
    }
    return []
  }
}

export async function getUnspentForAddresses(addresses: string[]): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {}
  await Promise.all(addresses.map(async (addr) => {
    try { out[addr] = await getUnspentForAddress(addr) } catch { out[addr] = [] }
  }))
  return out
}








