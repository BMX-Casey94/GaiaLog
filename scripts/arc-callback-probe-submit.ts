/**
 * ARC Callback Probe — submitter
 *
 * Diagnostic only. Submits a raw transaction to TAAL ARC with the callback
 * registration headers set, so scripts/arc-callback-probe-server.ts can record
 * whether ARC's callbacker actually delivers anything.
 *
 * SAFETY — read before running:
 *
 *   This script never loads a wallet key, never signs, and never builds a
 *   transaction. It only forwards raw hex you point it at. That boundary is
 *   deliberate: a broadcast probe must not be able to spend treasury funds.
 *
 *   Default mode (--txid) resubmits a transaction that is ALREADY on-chain.
 *   Resubmitting an already-mined transaction cannot double-spend: its inputs are
 *   already spent by that exact transaction, so ARC deduplicates via
 *   GetOrInsertStatus and returns the stored status. Nothing is spent, no fee is
 *   paid, and no new UTXO state is created.
 *
 *   The trade-off is that a deduplicated resubmission may not re-register the
 *   callback, so silence is inconclusive rather than proof of absence. If the
 *   safe mode returns no callback, escalate to --raw with a genuinely new
 *   transaction produced by your existing tooling.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 * 1. Generate a token and start the capture server (see that script's header):
 *      openssl rand -hex 32
 *
 * 2. Safe mode — resubmit a known mined txid, batched callbacks, full updates:
 *      npx tsx scripts/arc-callback-probe-submit.ts \
 *        --callback-url https://probe.example.com/arc-callback \
 *        --token <token> \
 *        --txid <64-hex-txid> \
 *        --batch --full
 *
 * 3. Definitive mode — submit a genuinely new signed transaction:
 *      npx tsx scripts/arc-callback-probe-submit.ts \
 *        --callback-url https://probe.example.com/arc-callback \
 *        --token <token> \
 *        --raw <raw-tx-hex>
 *
 * Flags:
 *   --callback-url  Public HTTPS URL ARC should POST status updates to (required)
 *   --token         Value for X-CallbackToken; ARC returns it as Authorization: Bearer
 *   --txid          Fetch this transaction's raw hex and resubmit it (safe mode)
 *   --raw           Submit this raw hex directly (definitive mode)
 *   --batch         Set X-CallbackBatch: true (up to 50 callbacks per POST)
 *   --full          Set X-FullStatusUpdates: true (adds SEEN_ON_NETWORK,
 *                   SEEN_IN_ORPHAN_MEMPOOL, DOUBLE_SPEND_ATTEMPTED; without it
 *                   ARC only fires on status >= REJECTED(110), i.e. REJECTED,
 *                   MINED_IN_STALE_BLOCK and MINED)
 *   --endpoint      Override the ARC base URL (default: $BSV_API_ENDPOINT or TAAL)
 *   --dry-run       Print the exact request that would be sent, then stop
 */

import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

function getArg(flag: string): string | undefined {
  const i = process.argv.findIndex(a => a === flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function redact(token: string): string {
  if (!token) return '(none)'
  if (token.length <= 8) return `${token.slice(0, 2)}…`
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`
}

const CALLBACK_URL = getArg('--callback-url') || ''
const TOKEN = getArg('--token') || process.env.ARC_CALLBACK_PROBE_TOKEN || ''
const TXID = getArg('--txid') || ''
const RAW = getArg('--raw') || ''
const BATCH = hasFlag('--batch')
const FULL = hasFlag('--full')
const DRY_RUN = hasFlag('--dry-run')
const ARC_ENDPOINT = (getArg('--endpoint') || process.env.BSV_API_ENDPOINT || 'https://arc.taal.com').replace(/\/$/, '')
const ARC_KEY = process.env.BSV_ARC_API_KEY || ''

// Mainnet only, per project policy. Single-tx lookups are permitted; bulk
// address lookups are not, and this script performs none.
const WOC_NETWORK = 'main'

async function fetchRawHexForTxid(txid: string): Promise<string> {
  const headers: Record<string, string> = { Accept: 'text/plain' }
  const wocKey = process.env.WHATSONCHAIN_API_KEY
  if (wocKey) {
    if (wocKey.startsWith('mainnet_') || wocKey.startsWith('testnet_')) headers['Authorization'] = wocKey
    else headers['woc-api-key'] = wocKey
  }

  const url = `https://api.whatsonchain.com/v1/bsv/${WOC_NETWORK}/tx/${txid}/hex`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    throw new Error(`Could not fetch raw hex for ${txid}: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  }
  const hex = (await res.text()).replace(/"/g, '').trim()
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 100) {
    throw new Error(`Unexpected raw hex response for ${txid}: ${hex.substring(0, 120)}`)
  }
  return hex
}

function fail(message: string): never {
  console.error(`✖ ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  if (!CALLBACK_URL) {
    fail('--callback-url is required. It must be an HTTPS URL reachable from ARC (not localhost).')
  }
  if (!/^https:\/\//i.test(CALLBACK_URL)) {
    console.warn('⚠️  --callback-url is not HTTPS. ARC validates callback URLs against an')
    console.warn('    operator deny-list and may reject this with HTTP 400.')
  }
  if (!TXID && !RAW) {
    fail('Supply either --txid <already-mined txid> (safe) or --raw <hex> (definitive).')
  }
  if (TXID && RAW) {
    fail('Supply only one of --txid or --raw.')
  }
  if (TXID && !/^[0-9a-fA-F]{64}$/.test(TXID)) {
    fail('--txid must be 64 hex characters.')
  }
  if (RAW && !/^[0-9a-fA-F]+$/.test(RAW)) {
    fail('--raw must be hex.')
  }
  if (!TOKEN) {
    console.warn('⚠️  No --token supplied. ARC will omit the Authorization header on the')
    console.warn('    callback, so you cannot verify the bearer-token mechanism this run.')
  }

  const rawHex = RAW || (await fetchRawHexForTxid(TXID))
  if (TXID) {
    console.log(`Fetched raw hex for ${TXID.substring(0, 16)}… (${rawHex.length / 2} bytes)`)
    console.log('Mode: SAFE resubmission of an already-broadcast transaction — nothing is spent.')
  } else {
    console.log(`Mode: DEFINITIVE submission of caller-supplied raw hex (${rawHex.length / 2} bytes).`)
    console.log('This broadcasts a real transaction. Ensure you intend to spend its inputs.')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-CallbackUrl': CALLBACK_URL,
  }
  if (ARC_KEY) headers['Authorization'] = `Bearer ${ARC_KEY}`
  if (TOKEN) headers['X-CallbackToken'] = TOKEN
  if (BATCH) headers['X-CallbackBatch'] = 'true'
  if (FULL) headers['X-FullStatusUpdates'] = 'true'

  const url = `${ARC_ENDPOINT}/v1/tx`
  const body = JSON.stringify({ rawTx: rawHex })

  console.log('')
  console.log('Request:')
  console.log(`  POST ${url}`)
  for (const [key, value] of Object.entries(headers)) {
    const shown = key === 'Authorization' ? `Bearer ${redact(ARC_KEY)}` : key === 'X-CallbackToken' ? redact(value) : value
    console.log(`    ${key}: ${shown}`)
  }
  console.log(`  body: {"rawTx":"…${rawHex.length / 2} bytes…"}`)

  if (!ARC_KEY) {
    console.log('')
    console.log('⚠️  BSV_ARC_API_KEY is not set. TAAL ARC may reject an unauthenticated submit.')
  }

  if (DRY_RUN) {
    console.log('')
    console.log('--dry-run set; not sending.')
    return
  }

  console.log('')
  const startedAt = Date.now()
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) })
  const text = await res.text().catch(() => '')
  const elapsed = Date.now() - startedAt

  console.log(`Response: HTTP ${res.status} in ${elapsed}ms`)

  let parsed: any = null
  try {
    parsed = JSON.parse(text)
  } catch {
    console.log(`  body (non-JSON): ${text.substring(0, 400)}`)
  }

  if (parsed) {
    console.log(`  txid:      ${parsed.txid || '(none)'}`)
    console.log(`  txStatus:  ${parsed.txStatus || '(none)'}`)
    console.log(`  status:    ${parsed.status ?? '(none)'}`)
    console.log(`  title:     ${parsed.title || '(none)'}`)
    if (parsed.blockHeight != null) console.log(`  blockHeight: ${parsed.blockHeight}`)
    if (parsed.extraInfo) console.log(`  extraInfo: ${String(parsed.extraInfo).substring(0, 300)}`)
    if (parsed.detail) console.log(`  detail:    ${String(parsed.detail).substring(0, 300)}`)
  }

  console.log('')
  if (!res.ok) {
    console.log('Submission was rejected. Note that ARC error codes 460–475 describe the')
    console.log('transaction, not the callback. A 400 mentioning the callback URL means ARC')
    console.log('refused the URL itself (deny-list) — fix that before concluding anything')
    console.log('about callbacker support.')
    process.exitCode = 1
    return
  }

  const status = String(parsed?.txStatus || '')
  console.log('Submission accepted. What to expect on the capture server:')
  if (status === 'MINED') {
    console.log('  txStatus is already MINED. If ARC re-registered the callback on this')
    console.log('  deduplicated resubmission, a MINED callback should arrive within seconds.')
    console.log('  Silence here is INCONCLUSIVE — rerun with --raw and a fresh transaction.')
  } else {
    console.log(`  txStatus is ${status || 'unknown'}. Callbacks fire on status >= REJECTED(110),`)
    console.log('  so expect nothing until the transaction is mined (up to ~10 minutes, longer')
    console.log('  if blocks are slow). Leave the capture server running.')
    if (FULL) {
      console.log('  --full was set, so SEEN_ON_NETWORK should arrive much sooner than MINED.')
    } else {
      console.log('  Add --full next time if you want early propagation statuses too.')
    }
  }
  if (BATCH) {
    console.log('  --batch was set, so callbacks arrive as {count, callbacks[]} at ~5s intervals.')
  }
}

main().catch((error) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
