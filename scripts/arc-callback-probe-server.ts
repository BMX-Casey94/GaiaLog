/**
 * ARC Callback Probe — capture server
 *
 * Diagnostic only. Stands up a throwaway HTTP endpoint that records, verbatim,
 * anything ARC's callbacker POSTs to it. Use with scripts/arc-callback-probe-submit.ts
 * to answer one question: does TAAL's ARC deployment actually run the `callbacker`
 * microservice, or does it only serve the synchronous submit/query API?
 *
 * TAAL documents `arc.taal.com/v1` and defers to the canonical ARC spec, which
 * defines X-CallbackUrl / X-CallbackToken / X-CallbackBatch. But `callbacker` is a
 * separately deployed service in ARC, so support cannot be assumed from the spec.
 * This probe settles it empirically before any production code depends on it.
 *
 * What it verifies:
 *   - whether a callback arrives at all, and how long after submission
 *   - whether ARC sends `Authorization: Bearer <X-CallbackToken>` as the spec claims
 *     (this is the ONLY authentication available on the real receiver, so confirming
 *      it arrives is a prerequisite for trusting the endpoint at all)
 *   - the exact payload shape: single {txid, txStatus, ...} vs batched {count, callbacks[]}
 *   - which optional fields are actually populated (merklePath / blockHash / blockHeight)
 *   - whether MINED is followed by further transitions (MINED_IN_STALE_BLOCK on reorg)
 *
 * This server is deliberately dumb: it always answers 200 so ARC does not retry,
 * mutates no database, and imports nothing from lib/. It cannot affect production.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 * Local capture (then front it with TLS, see below):
 *   npx tsx scripts/arc-callback-probe-server.ts --token <token> --port 8791
 *
 * Bind publicly on a VPS (only if the port is firewalled to TAAL or short-lived):
 *   npx tsx scripts/arc-callback-probe-server.ts --token <token> --host 0.0.0.0 --port 8791
 *
 * Generate a token first:
 *   openssl rand -hex 32
 *
 * ARC requires the callback URL to be reachable from ARC, and its callbacker
 * enforces an operator-configured deny-list on callback URLs. Use a public
 * HTTPS URL. Either front this process with nginx/Caddy, or use a tunnel:
 *   cloudflared tunnel --url http://127.0.0.1:8791
 *
 * Captures are appended as JSONL to --out (default ./arc-callback-probe.jsonl)
 * so the evidence survives the process.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'

function getArg(flag: string): string | undefined {
  const i = process.argv.findIndex(a => a === flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

const TOKEN = getArg('--token') || process.env.ARC_CALLBACK_PROBE_TOKEN || ''
const PORT = Math.max(1, Number(getArg('--port') || process.env.ARC_CALLBACK_PROBE_PORT || 8791))
const HOST = getArg('--host') || '127.0.0.1'
const OUT_FILE = path.resolve(getArg('--out') || './arc-callback-probe.jsonl')
const QUIET = hasFlag('--quiet')

/** Constant-time compare so the probe models what the real receiver must do. */
function tokenMatches(presented: string, expected: string): boolean {
  if (!expected) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function redact(token: string): string {
  if (!token) return '(none)'
  if (token.length <= 8) return `${token.slice(0, 2)}…`
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`
}

type CallbackEntry = {
  timestamp?: string
  txid?: string
  txStatus?: string
  extraInfo?: string
  competingTxs?: string[]
  merklePath?: string
  blockHash?: string
  blockHeight?: number
}

/** ARC sends either a single Callback or, with X-CallbackBatch, {count, callbacks[]}. */
function extractCallbacks(body: unknown): { shape: string; entries: CallbackEntry[] } {
  if (!body || typeof body !== 'object') return { shape: 'unparseable', entries: [] }
  const obj = body as Record<string, unknown>

  if (Array.isArray(obj.callbacks)) {
    return { shape: 'batched', entries: obj.callbacks as CallbackEntry[] }
  }
  if (Array.isArray(body)) {
    return { shape: 'bare-array', entries: body as CallbackEntry[] }
  }
  if (typeof obj.txid === 'string' || typeof obj.txStatus === 'string') {
    return { shape: 'single', entries: [obj as CallbackEntry] }
  }
  return { shape: 'unrecognised', entries: [] }
}

function describeFields(entry: CallbackEntry): string {
  const present: string[] = []
  const absent: string[] = []
  for (const field of ['timestamp', 'txid', 'txStatus', 'extraInfo', 'competingTxs', 'merklePath', 'blockHash', 'blockHeight'] as const) {
    const value = entry[field]
    if (value === undefined || value === null || value === '') absent.push(field)
    else present.push(field)
  }
  return `present=[${present.join(', ')}] absent=[${absent.join(', ')}]`
}

const startedAt = Date.now()
let captureCount = 0
const statusesByTxid = new Map<string, string[]>()

const app = express()

// Capture the exact bytes. Do NOT let a JSON body parser reshape or reject the
// payload before it is recorded — an unparseable body is itself a finding.
app.use(express.text({ type: '*/*', limit: '5mb' }))

// Catch-all via `use` rather than `all('*')`: Express 5 routes through
// path-to-regexp v8, which rejects a bare '*' as a malformed parameter name.
app.use((req, res) => {
  const receivedAt = new Date()
  captureCount += 1

  const rawBody = typeof req.body === 'string' ? req.body : ''
  const authHeader = String(req.get('authorization') || '')
  const presentedToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : ''

  const authPresent = authHeader.length > 0
  const authIsBearer = presentedToken.length > 0
  const authValid = authIsBearer && tokenMatches(presentedToken, TOKEN)

  let parsed: unknown = null
  let parseError: string | null = null
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e)
  }

  const { shape, entries } = extractCallbacks(parsed)
  for (const entry of entries) {
    if (entry.txid && entry.txStatus) {
      const seen = statusesByTxid.get(entry.txid) || []
      seen.push(entry.txStatus)
      statusesByTxid.set(entry.txid, seen)
    }
  }

  const record = {
    capture: captureCount,
    receivedAt: receivedAt.toISOString(),
    secondsSinceStart: Math.round((receivedAt.getTime() - startedAt) / 1000),
    method: req.method,
    url: req.originalUrl,
    remoteAddress: req.socket.remoteAddress,
    headers: req.headers,
    auth: {
      headerPresent: authPresent,
      isBearer: authIsBearer,
      matchesExpectedToken: authValid,
    },
    contentType: req.get('content-type') || null,
    bodyBytes: Buffer.byteLength(rawBody, 'utf8'),
    shape,
    parseError,
    entryCount: entries.length,
    rawBody,
  }

  try {
    fs.appendFileSync(OUT_FILE, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (e) {
    console.error(`⚠️  Failed to append capture to ${OUT_FILE}: ${e instanceof Error ? e.message : e}`)
  }

  if (!QUIET) {
    console.log('')
    console.log(`━━━ capture #${captureCount} @ ${receivedAt.toISOString()} (+${record.secondsSinceStart}s) ━━━`)
    console.log(`  ${req.method} ${req.originalUrl} from ${record.remoteAddress}`)
    console.log(`  content-type: ${record.contentType || '(none)'}  bytes: ${record.bodyBytes}`)
    console.log(
      `  Authorization: present=${authPresent} bearer=${authIsBearer} tokenMatch=${authValid}` +
        (authIsBearer && !authValid ? `  ⚠️  presented ${redact(presentedToken)}` : ''),
    )
    console.log(`  user-agent: ${req.get('user-agent') || '(none)'}`)
    console.log(`  payload shape: ${shape}${parseError ? ` (JSON parse failed: ${parseError})` : ''}  entries: ${entries.length}`)

    entries.forEach((entry, idx) => {
      console.log(
        `    [${idx}] txStatus=${entry.txStatus || '?'} txid=${(entry.txid || '?').substring(0, 16)}…` +
          (entry.blockHeight != null ? ` height=${entry.blockHeight}` : '') +
          (entry.merklePath ? ` merklePath=${String(entry.merklePath).length} chars` : ''),
      )
      console.log(`         ${describeFields(entry)}`)
      if (entry.extraInfo) console.log(`         extraInfo: ${String(entry.extraInfo).substring(0, 200)}`)
      if (entry.competingTxs?.length) console.log(`         competingTxs: ${entry.competingTxs.length}`)
    })

    if (!entries.length && rawBody) {
      console.log(`  raw body: ${rawBody.substring(0, 500)}`)
    }
  }

  // Always 200: a non-2xx would make ARC retry and muddy the timing evidence.
  res.status(200).json({ ok: true })
})

const server = app.listen(PORT, HOST, () => {
  console.log('ARC callback probe — capture server')
  console.log(`  listening:     http://${HOST}:${PORT}`)
  console.log(`  expected token: ${redact(TOKEN)}`)
  console.log(`  capture log:   ${OUT_FILE}`)
  if (!TOKEN) {
    console.log('')
    console.log('  ⚠️  No --token supplied. Callbacks will still be captured, but the probe')
    console.log('      cannot verify that ARC returns the token as a bearer credential —')
    console.log('      which is the single most important thing to confirm before the real')
    console.log('      receiver relies on it for authentication.')
  }
  console.log('')
  console.log('  Waiting for callbacks. Ctrl+C to stop and print a summary.')
})

function printSummary(): void {
  console.log('')
  console.log('━━━ summary ━━━')
  console.log(`  uptime:            ${Math.round((Date.now() - startedAt) / 1000)}s`)
  console.log(`  callbacks received: ${captureCount}`)
  console.log(`  capture log:        ${OUT_FILE}`)

  if (captureCount === 0) {
    console.log('')
    console.log('  RESULT: no callbacks received.')
    console.log('  This is NOT yet proof that TAAL runs no callbacker. Rule out first:')
    console.log('    - was the callback URL reachable from the public internet (not localhost)?')
    console.log('    - did the submit step return 2xx, and did ARC echo no callback-URL rejection?')
    console.log('      (ARC validates X-CallbackUrl against an operator deny-list and will 400)')
    console.log('    - was the transaction already MINED before submission? A deduplicated')
    console.log('      resubmission may not re-register the callback — retry with a fresh tx.')
    console.log('    - ARC callbacks fire on status >= REJECTED(110) by default, so an')
    console.log('      unmined tx produces nothing until it is mined. Wait a block (~10 min).')
    return
  }

  console.log('')
  console.log('  RESULT: TAAL ARC delivered callbacks. Per-transaction status sequences:')
  for (const [txid, statuses] of statusesByTxid) {
    console.log(`    ${txid.substring(0, 20)}… → ${statuses.join(' → ')}`)
  }
  console.log('')
  console.log('  Next: confirm from the captures above that Authorization arrived as a')
  console.log('  bearer token with tokenMatch=true. If it did not, the production receiver')
  console.log('  cannot authenticate ARC by token alone and needs another control.')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    printSummary()
    server.close(() => process.exit(0))
    // Don't hang if a keep-alive connection is open.
    setTimeout(() => process.exit(0), 1000)
  })
}
