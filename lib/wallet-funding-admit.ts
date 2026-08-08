/**
 * Wallet Funding Admit
 *
 * After an external top-up, on-chain UTXOs exist but overlay spends do not
 * resume until those outpoints are present in `overlay_admitted_utxos`.
 * Manual recovery (`scripts/recovery-import-onchain-utxos.ts`) still works
 * for full rebuilds; this scheduler covers the common case: fund → confirm
 * → auto-admit → splitter resumes, without stopping workers.
 *
 * Discovery uses Bitails address unspent (not WhatsOnChain wallet history).
 *
 * Safety while workers are live:
 *   - Only inserts brand-new outpoints, or revives `removed=true` rows.
 *   - Never clears locks / mutates live confirmed inventory on conflict.
 *   - Only admits confirmed UTXOs at/above a funding-sized sat floor so
 *     normal split dust is not re-imported from the explorer.
 *
 * Scan strategy (production Aug 2026):
 *   A wallet holding tens of thousands of dust outputs pushes fresh funding
 *   arbitrarily deep into Bitails' unspent pagination, so a fixed-depth
 *   unspent scan silently missed real top-ups. Each cycle:
 *     1. Compare confirmed chain balance vs overlay live sats.
 *        gap < minSats → one cheap balance call, done.
 *     2. History-first: recent address history (newest first) for receives
 *        ≥ minSats, then resolve each tx's unspent outputs to this address.
 *        Recent top-ups land in seconds instead of after paging all dust.
 *     3. Fallback: cursor-resumed unspent pagination with a per-cycle page
 *        budget, continuing until the address is fully swept.
 *
 * Env:
 *   BSV_FUNDING_ADMIT_DISABLED=true          - opt out
 *   BSV_FUNDING_ADMIT_INTERVAL_MS            - default 300_000 (5 min)
 *   BSV_FUNDING_ADMIT_MIN_SATS               - default max(10_000, 2×split)
 *   BSV_FUNDING_ADMIT_MIN_CONFIRMATIONS      - default 1
 *   BSV_FUNDING_ADMIT_PAGES_PER_CYCLE        - default 250 (25,000 outputs)
 *   BSV_FUNDING_ADMIT_PAGE_DELAY_MS          - default 60
 *   BSV_FUNDING_ADMIT_HISTORY_LIMIT          - default 200 recent history rows
 */

import { P2PKH } from '@bsv/sdk'
import { walletManager } from './wallet-manager'
import { getTreasuryTopicForWallet } from './treasury-topics'
import { withOverlayTransaction, refreshTopicCounts } from './overlay-repository'

const ENABLED = process.env.BSV_FUNDING_ADMIT_DISABLED !== 'true'
const INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.BSV_FUNDING_ADMIT_INTERVAL_MS || 300_000),
)
const SPLIT_OUTPUT_SATS = Math.max(
  1,
  Number(process.env.BSV_UTXO_SPLIT_OUTPUT_SATS || 500),
)
const MIN_SATS = Math.max(
  SPLIT_OUTPUT_SATS * 2,
  Number(process.env.BSV_FUNDING_ADMIT_MIN_SATS || 10_000),
)
const MIN_CONFIRMATIONS = Math.max(
  1,
  Number(process.env.BSV_FUNDING_ADMIT_MIN_CONFIRMATIONS || 1),
)
const RESERVE_MIN_SATS = Math.max(
  SPLIT_OUTPUT_SATS * 2,
  Number(process.env.BSV_UTXO_RESERVE_MIN_SATS || 0),
)
const BITAILS_BASE = (process.env.BSV_BITAILS_API_BASE || 'https://api.bitails.io').replace(/\/$/, '')
const PAGE_LIMIT = 100
const PAGES_PER_CYCLE = Math.max(
  10,
  Number(process.env.BSV_FUNDING_ADMIT_PAGES_PER_CYCLE || 250),
)
const PAGE_DELAY_MS = Math.max(0, Number(process.env.BSV_FUNDING_ADMIT_PAGE_DELAY_MS || 60))
const HISTORY_LIMIT = Math.min(
  5000,
  Math.max(20, Number(process.env.BSV_FUNDING_ADMIT_HISTORY_LIMIT || 200)),
)
// When a gap exists and the unspent cursor is mid-sweep, poll again soon
// instead of waiting a full INTERVAL_MS between 25k-output chunks.
const RESUME_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.BSV_FUNDING_ADMIT_RESUME_INTERVAL_MS || 30_000),
)
// A wallet whose overlay inventory is permanently below its chain balance
// (archived phantoms that are actually unspent, sub-minSats dust) would
// otherwise re-sweep the whole address every cycle forever.
const SWEEP_BACKOFF_MS = Math.max(
  INTERVAL_MS,
  Number(process.env.BSV_FUNDING_ADMIT_SWEEP_BACKOFF_MS || 6 * 60 * 60 * 1000),
)

let timer: NodeJS.Timeout | null = null
let running = false

// Per-address scan progress. Persisting the cursor across cycles keeps each
// cycle's Bitails load bounded while still guaranteeing a full sweep of an
// address holding hundreds of thousands of outputs.
interface ScanState {
  cursor: number
  lastSweepAt: number
  lastSweepBalanceSats: number
}
const scanStateByAddress = new Map<string, ScanState>()

function getScanState(address: string): ScanState {
  let st = scanStateByAddress.get(address)
  if (!st) {
    st = { cursor: 0, lastSweepAt: 0, lastSweepBalanceSats: -1 }
    scanStateByAddress.set(address, st)
  }
  return st
}

interface BitailsUnspent {
  txid: string
  vout: number
  satoshis: number
  confirmations?: number
  blockheight?: number
}

function buildP2PKHHex(address: string): string {
  return new P2PKH().lock(address).toHex().toLowerCase()
}

/** Bitails output status: exists/false and mempool/false are unspent. */
function isBitailsUnspent(status: unknown): boolean {
  if (typeof status === 'string') {
    if (status === 'exists/false' || status === 'mempool/false') return true
    if (status === 'exists/true' || status === 'mempool/true' || status === 'unknown') return false
    return status === 'exists' || status === 'mempool'
  }
  if (status && typeof status === 'object') {
    const o = status as { spent?: boolean; status?: string }
    if (typeof o.spent === 'boolean') return !o.spent
    return isBitailsUnspent(o.status)
  }
  return false
}

function isAdmittableFunding(u: BitailsUnspent): boolean {
  const sats = Number(u.satoshis)
  const conf = Number(u.confirmations ?? 0)
  return (
    Number.isFinite(sats) &&
    sats >= MIN_SATS &&
    Number.isFinite(conf) &&
    conf >= MIN_CONFIRMATIONS &&
    typeof u.txid === 'string' &&
    u.txid.length === 64 &&
    Number.isInteger(Number(u.vout)) &&
    Number(u.vout) >= 0
  )
}

async function bitailsJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BITAILS_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`Bitails ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`)
  }
  return (await res.json()) as T
}

/** Confirmed on-chain balance in satoshis (single request). */
async function fetchConfirmedBalance(address: string): Promise<number> {
  const body = await bitailsJson<{ confirmed?: number; unconfirmed?: number }>(
    `/address/${encodeURIComponent(address)}/balance`,
  )
  const confirmed = Number(body?.confirmed)
  return Number.isFinite(confirmed) ? confirmed : 0
}

/** Sats this wallet already accounts for in the overlay inventory. */
async function fetchOverlayLiveSats(walletIndex: number): Promise<number> {
  return withOverlayTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = 20000`)
    const res = await client.query<{ sats: string }>(
      `SELECT COALESCE(SUM(satoshis), 0)::text AS sats
         FROM overlay_admitted_utxos
        WHERE wallet_index = $1
          AND removed = false`,
      [walletIndex],
    )
    return Number(res.rows[0]?.sats || '0')
  })
}

/**
 * Page through unspents from `startFrom`, returning funding-sized candidates
 * plus the cursor to resume from. Stops at the per-cycle page budget so one
 * bloated address cannot monopolise the cycle or hammer Bitails.
 */
async function scanUnspentForFunding(
  address: string,
  startFrom: number,
): Promise<{ candidates: BitailsUnspent[]; nextCursor: number; reachedEnd: boolean; scanned: number }> {
  const candidates: BitailsUnspent[] = []
  let from = Math.max(0, startFrom)
  let scanned = 0

  for (let page = 0; page < PAGES_PER_CYCLE; page++) {
    const body = await bitailsJson<{ unspent?: BitailsUnspent[] }>(
      `/address/${encodeURIComponent(address)}/unspent?from=${from}&limit=${PAGE_LIMIT}`,
    )
    const rows = Array.isArray(body.unspent) ? body.unspent : []
    scanned += rows.length
    for (const u of rows) {
      if (isAdmittableFunding(u)) candidates.push(u)
    }
    if (rows.length < PAGE_LIMIT) {
      return { candidates, nextCursor: 0, reachedEnd: true, scanned }
    }
    from += rows.length
    if (PAGE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS))
  }

  return { candidates, nextCursor: from, reachedEnd: false, scanned }
}

interface HistoryRow {
  txid?: string
  inputSatoshis?: number
  outputSatoshis?: number
  time?: number
  blockheight?: number
}

/**
 * Fast path for recent top-ups. Bitails address history is newest-first and
 * tags receives via `outputSatoshis`, so a 0.2 BSV funding TX shows up in the
 * first page long before unspent pagination reaches it behind 40k+ dust rows.
 */
async function discoverFundingViaHistory(address: string): Promise<BitailsUnspent[]> {
  const scriptHex = buildP2PKHHex(address)
  const raw = await bitailsJson<unknown>(
    `/address/${encodeURIComponent(address)}/history?limit=${HISTORY_LIMIT}`,
  )

  let histories: HistoryRow[] = []
  if (Array.isArray(raw)) {
    // Shape A: [ { address, histories: [...] } ]  or  [ { txid, outputSatoshis, ... } ]
    if (raw.length > 0 && raw[0] && typeof raw[0] === 'object' && 'histories' in (raw[0] as object)) {
      histories = ((raw[0] as { histories?: HistoryRow[] }).histories || []) as HistoryRow[]
    } else {
      histories = raw as HistoryRow[]
    }
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as { histories?: HistoryRow[] }).histories)) {
    histories = (raw as { histories: HistoryRow[] }).histories
  }

  const received = histories.filter((h) => {
    const out = Number(h.outputSatoshis || 0)
    return Number.isFinite(out) && out >= MIN_SATS && typeof h.txid === 'string' && h.txid.length === 64
  })
  if (received.length === 0) return []

  const candidates: BitailsUnspent[] = []
  const seen = new Set<string>()

  // Cap how many funding-sized receives we resolve per cycle — recent top-ups
  // are almost always in the first handful of rows.
  for (const h of received.slice(0, 25)) {
    const txid = String(h.txid).toLowerCase()
    let tx: {
      confirmations?: number
      outputs?: Array<{ index?: number; satoshis?: number; script?: string }>
      outputsCount?: number
      partialOutputs?: boolean
    }
    try {
      tx = await bitailsJson(`/tx/${txid}`)
    } catch {
      continue
    }
    const confirmations = Number(tx.confirmations ?? 0)
    if (!Number.isFinite(confirmations) || confirmations < MIN_CONFIRMATIONS) continue

    let outputs = Array.isArray(tx.outputs) ? tx.outputs : []
    if ((tx.partialOutputs || outputs.length === 0) && Number(tx.outputsCount || 0) > 0) {
      try {
        const count = Math.min(50, Number(tx.outputsCount))
        outputs = await bitailsJson(`/tx/${txid}/outputs/0/${count}`)
      } catch {
        continue
      }
    }

    for (const o of outputs) {
      const vout = Number(o.index)
      const satoshis = Number(o.satoshis)
      const script = String(o.script || '').toLowerCase()
      if (!Number.isInteger(vout) || vout < 0) continue
      if (!Number.isFinite(satoshis) || satoshis < MIN_SATS) continue
      if (script && script !== scriptHex) continue

      const key = `${txid}:${vout}`
      if (seen.has(key)) continue

      let unspent = false
      try {
        const status = await bitailsJson<{ status?: string; spent?: boolean } | string>(
          `/tx/${txid}/output/${vout}/status`,
        )
        unspent = isBitailsUnspent(status)
      } catch {
        continue
      }
      if (!unspent) continue

      seen.add(key)
      candidates.push({ txid, vout, satoshis, confirmations })
    }
  }

  return candidates
}

async function admitCandidates(
  walletIndex: number,
  address: string,
  candidates: BitailsUnspent[],
): Promise<{ admitted: number; revived: number }> {
  if (candidates.length === 0) return { admitted: 0, revived: 0 }

  const topic = getTreasuryTopicForWallet(walletIndex)
  const outputScript = buildP2PKHHex(address)

  return withOverlayTransaction(async (client) => {
    let admitted = 0
    let revived = 0

    for (const u of candidates) {
      const txid = u.txid.toLowerCase()
      const vout = Number(u.vout)
      const satoshis = Number(u.satoshis)
      const role = satoshis >= RESERVE_MIN_SATS ? 'reserve' : 'pool'

      const existing = await client.query<{ removed: boolean; locked: boolean }>(
        `SELECT removed, locked
           FROM overlay_admitted_utxos
          WHERE topic = $1 AND txid = $2 AND vout = $3
          LIMIT 1`,
        [topic, txid, vout],
      )

      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO overlay_admitted_utxos
             (topic, txid, vout, satoshis, output_script, raw_tx, beef,
              confirmed, wallet_index, utxo_role, locked, locked_by, locked_at,
              removed, removed_at, spending_txid, acquirable_at)
           VALUES ($1, $2, $3, $4, $5, NULL, NULL::jsonb,
                   true, $6, $7, false, NULL, NULL,
                   false, NULL, NULL, now())`,
          [topic, txid, vout, satoshis, outputScript, walletIndex, role],
        )
        await refreshTopicCounts(client, topic, 1)
        admitted++
        console.log(
          `💰 [funding-admit] W${walletIndex + 1} admitted ${txid}:${vout} ` +
            `sats=${satoshis.toLocaleString()} role=${role}`,
        )
        continue
      }

      const row = existing.rows[0]
      if (row.removed === true) {
        const upd = await client.query(
          `UPDATE overlay_admitted_utxos
              SET satoshis = $4,
                  output_script = $5,
                  confirmed = true,
                  wallet_index = $6,
                  utxo_role = $7,
                  locked = false,
                  locked_by = NULL,
                  locked_at = NULL,
                  removed = false,
                  removed_at = NULL,
                  spending_txid = NULL,
                  acquirable_at = now()
            WHERE topic = $1 AND txid = $2 AND vout = $3 AND removed = true`,
          [topic, txid, vout, satoshis, outputScript, walletIndex, role],
        )
        if ((upd.rowCount || 0) > 0) {
          await refreshTopicCounts(client, topic, 1)
          revived++
          console.log(
            `💰 [funding-admit] W${walletIndex + 1} revived ${txid}:${vout} ` +
              `sats=${satoshis.toLocaleString()} role=${role}`,
          )
        }
      }
      void row.locked
    }

    return { admitted, revived }
  })
}

async function admitWalletFunding(walletIndex: number, address: string): Promise<{ admitted: number; revived: number }> {
  const [balanceSats, overlaySats] = await Promise.all([
    fetchConfirmedBalance(address),
    fetchOverlayLiveSats(walletIndex),
  ])
  const gapSats = balanceSats - overlaySats
  const state = getScanState(address)

  if (gapSats < MIN_SATS) {
    state.cursor = 0
    return { admitted: 0, revived: 0 }
  }

  // Mid-sweep always continues; a fresh sweep only starts if the chain balance
  // moved or the previous sweep has aged out.
  const sweepAgedOut = Date.now() - state.lastSweepAt >= SWEEP_BACKOFF_MS
  const balanceMoved = balanceSats !== state.lastSweepBalanceSats
  if (state.cursor === 0 && !sweepAgedOut && !balanceMoved) {
    return { admitted: 0, revived: 0 }
  }

  // 1) History-first — finds recent top-ups without paging the dust pile.
  try {
    const fromHistory = await discoverFundingViaHistory(address)
    if (fromHistory.length > 0) {
      console.log(
        `💰 [funding-admit] W${walletIndex + 1} history-hit: ${fromHistory.length} funding candidate(s) ` +
          `for gap=${gapSats.toLocaleString()} sats ` +
          `(chain=${balanceSats.toLocaleString()} overlay=${overlaySats.toLocaleString()})`,
      )
      const result = await admitCandidates(walletIndex, address, fromHistory)
      if (result.admitted > 0 || result.revived > 0) {
        // Funding landed — drop any mid-sweep cursor; next cycle re-checks gap.
        state.cursor = 0
        return result
      }
    }
  } catch (err) {
    console.warn(
      `⚠️  [funding-admit] W${walletIndex + 1} history scan failed: ` +
        `${err instanceof Error ? err.message : String(err)} — falling back to unspent pagination`,
    )
  }

  // 2) Fallback: cursor-resumed unspent pagination (covers older funding not
  //    present in the recent history window).
  const cursor = state.cursor
  const scan = await scanUnspentForFunding(address, cursor)
  state.cursor = scan.nextCursor
  if (scan.reachedEnd) {
    state.lastSweepAt = Date.now()
    state.lastSweepBalanceSats = balanceSats
  }
  console.log(
    `💰 [funding-admit] W${walletIndex + 1} gap=${gapSats.toLocaleString()} sats ` +
      `(chain=${balanceSats.toLocaleString()} overlay=${overlaySats.toLocaleString()}) — ` +
      `scanned ${scan.scanned.toLocaleString()} outputs from ${cursor.toLocaleString()}, ` +
      `${scan.candidates.length} funding candidate(s)` +
      `${scan.reachedEnd ? ', sweep complete' : `, resuming at ${scan.nextCursor.toLocaleString()}`}`,
  )

  return admitCandidates(walletIndex, address, scan.candidates)
}

function anyMidSweep(): boolean {
  for (const st of scanStateByAddress.values()) {
    if (st.cursor > 0) return true
  }
  return false
}

function scheduleNext(delayMs: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void runCycle().finally(() => {
      // Mid-sweep resumes quickly; idle wallets keep the long interval.
      scheduleNext(anyMidSweep() ? RESUME_INTERVAL_MS : INTERVAL_MS)
    })
  }, delayMs)
}

async function runCycle(): Promise<void> {
  if (running) return
  running = true
  try {
    if (!walletManager.isReady()) return
    const wallets = walletManager.getAllWalletInfo()
    let totalAdmitted = 0
    let totalRevived = 0
    for (const w of wallets) {
      try {
        const address = w.address || walletManager.getWalletAddress(w.index)
        if (!address) continue
        const { admitted, revived } = await admitWalletFunding(w.index, address)
        totalAdmitted += admitted
        totalRevived += revived
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`⚠️  [funding-admit] W${w.index + 1} failed: ${msg}`)
      }
    }
    if (totalAdmitted > 0 || totalRevived > 0) {
      console.log(
        `💰 [funding-admit] cycle done: admitted=${totalAdmitted} revived=${totalRevived} ` +
          `(minSats=${MIN_SATS} minConf=${MIN_CONFIRMATIONS})`,
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`⚠️  [funding-admit] cycle failed: ${msg}`)
  } finally {
    running = false
  }
}

export function startWalletFundingAdmit(): void {
  if (!ENABLED) {
    console.log('[funding-admit] disabled via BSV_FUNDING_ADMIT_DISABLED')
    return
  }
  if (timer) return
  // Stagger after funding-monitor (30s) so Bitails + DB load do not stack.
  scheduleNext(90_000)
  console.log(
    `💰 [funding-admit] started: intervalMs=${INTERVAL_MS} resumeMs=${RESUME_INTERVAL_MS} ` +
      `minSats=${MIN_SATS} minConf=${MIN_CONFIRMATIONS} pagesPerCycle=${PAGES_PER_CYCLE} ` +
      `historyLimit=${HISTORY_LIMIT} source=bitails`,
  )
}

export function stopWalletFundingAdmit(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
