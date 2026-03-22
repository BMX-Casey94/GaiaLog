/**
 * GorillaPool ARC → TAAL ARC → WhatsOnChain raw-tx broadcast (shared by UTXO maintainer and split-utxos script).
 * Split / maintainer path accepts SEEN_IN_ORPHAN_MEMPOOL as OK (same as legacy maintainer behaviour).
 */

const NET = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY || ''
const GORILLAPOOL_ARC_ENDPOINT = (process.env.BSV_GORILLAPOOL_ARC_ENDPOINT || 'https://arc.gorillapool.io').replace(
  /\/$/,
  '',
)
const TAAL_ARC_ENDPOINT = (process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/$/, '')
const ARC_KEY = process.env.BSV_ARC_API_KEY || ''

const ARC_OK_STATUSES = new Set([
  'SEEN_ON_NETWORK',
  'MINED',
  'ACCEPTED',
  'STORED',
  'RECEIVED',
  'ANNOUNCED_TO_NETWORK',
  'SEEN_IN_ORPHAN_MEMPOOL',
])

const ARC_REJECT_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'REJECTED',
  'INVALID',
  'EVICTED',
])

function parseArcResponse(responseText: string, providerLabel: string): string | null {
  try {
    const parsed = JSON.parse(responseText || '{}')
    const txid = typeof parsed.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(parsed.txid)
      ? parsed.txid
      : null
    const status = typeof parsed.txStatus === 'string' ? parsed.txStatus : ''

    if (txid && ARC_REJECT_STATUSES.has(status)) {
      const extra = parsed.extraInfo ? ` (${String(parsed.extraInfo).substring(0, 80)})` : ''
      console.warn(`⚠️  ARC (${providerLabel}): TX rejected — txStatus=${status}${extra}`)
      return null
    }
    if (txid && (ARC_OK_STATUSES.has(status) || !status)) return txid
    if (txid) {
      console.warn(`⚠️  ARC (${providerLabel}): Unknown txStatus="${status}" — accepting cautiously`)
      return txid
    }
  } catch {}
  const plain = (responseText || '').replace(/"/g, '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(plain)) return plain
  return null
}

/**
 * Broadcast a signed raw hex transaction (split TXs, tooling). Tries GorillaPool, then TAAL, then WoC.
 */
export async function broadcastSplitTransactionRaw(rawHex: string): Promise<string> {
  const errors: string[] = []

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const gpApiKey = process.env.BSV_GORILLAPOOL_API_KEY
    if (gpApiKey) headers.Authorization = `Bearer ${gpApiKey}`
    const res = await fetch(`${GORILLAPOOL_ARC_ENDPOINT}/v1/tx`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rawTx: rawHex }),
    })
    const text = await res.text().catch(() => '')
    if (res.ok) {
      const txid = parseArcResponse(text, 'GorillaPool')
      if (txid) return txid
      errors.push(`GorillaPool ARC: rejected — ${text.substring(0, 200)}`)
    } else {
      errors.push(`GorillaPool ARC ${res.status}: ${text.substring(0, 200)}`)
    }
  } catch (e) {
    errors.push(`GorillaPool ARC error: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ARC_KEY) headers.Authorization = `Bearer ${ARC_KEY}`
    const res = await fetch(`${TAAL_ARC_ENDPOINT}/v1/tx`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rawTx: rawHex }),
    })
    const text = await res.text().catch(() => '')
    if (res.ok) {
      const txid = parseArcResponse(text, 'TAAL')
      if (txid) return txid
      errors.push(`TAAL ARC: rejected — ${text.substring(0, 200)}`)
    } else {
      errors.push(`TAAL ARC ${res.status}: ${text.substring(0, 200)}`)
    }
  } catch (e) {
    errors.push(`TAAL ARC error: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (WHATSONCHAIN_API_KEY) headers['woc-api-key'] = WHATSONCHAIN_API_KEY
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${NET}/tx/raw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ txhex: rawHex }),
    })
    const text = await res.text().catch(() => '')
    if (res.ok) {
      const txid = text.replace(/"/g, '').trim()
      if (/^[0-9a-fA-F]{64}$/.test(txid)) return txid
      errors.push(`WoC returned unexpected body: ${text.substring(0, 200)}`)
    } else {
      errors.push(`WoC broadcast ${res.status}: ${text.substring(0, 200)}`)
    }
  } catch (e) {
    errors.push(`WoC broadcast error: ${e instanceof Error ? e.message : String(e)}`)
  }

  const allErrors = errors.join('\n')
  if (allErrors.includes('too-long-mempool-chain')) {
    throw new Error('MEMPOOL_CHAIN_LIMIT')
  }
  throw new Error(`All split broadcast methods failed:\n${allErrors}`)
}
