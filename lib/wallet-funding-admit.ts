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
 *   arbitrarily deep into Bitails' unspent pagination, so the previous
 *   fixed 10,000-output scan silently missed real top-ups and the wallet
 *   stayed STARVED while holding BSV on-chain. Instead of paging every
 *   cycle, each cycle compares the address' confirmed on-chain balance with
 *   the sats this wallet already has in `overlay_admitted_utxos`:
 *     gap < minSats  → nothing missing, one cheap balance call, done.
 *     gap ≥ minSats  → page through unspents from a persisted cursor with a
 *                      per-cycle page budget, admitting funding-sized
 *                      outputs, resuming next cycle until the address is
 *                      fully swept.
 *
 * Env:
 *   BSV_FUNDING_ADMIT_DISABLED=true          - opt out
 *   BSV_FUNDING_ADMIT_INTERVAL_MS            - default 300_000 (5 min)
 *   BSV_FUNDING_ADMIT_MIN_SATS               - default max(10_000, 2×split)
 *   BSV_FUNDING_ADMIT_MIN_CONFIRMATIONS      - default 1
 *   BSV_FUNDING_ADMIT_PAGES_PER_CYCLE        - default 250 (25,000 outputs)
 *   BSV_FUNDING_ADMIT_PAGE_DELAY_MS          - default 60
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

async function admitWalletFunding(walletIndex: number, address: string): Promise<{ admitted: number; revived: number }> {
  const [balanceSats, overlaySats] = await Promise.all([
    fetchConfirmedBalance(address),
    fetchOverlayLiveSats(walletIndex),
  ])
  const gapSats = balanceSats - overlaySats
  const state = getScanState(address)

  if (gapSats < MIN_SATS) {
    // Inventory already accounts for the chain balance — no scan required.
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

  const candidates = scan.candidates
  if (candidates.length === 0) {
    return { admitted: 0, revived: 0 }
  }

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
        // Revive archived funding only; do not touch live locked inventory.
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
      // Live row (locked or not): leave alone — workers own it.
      void row.locked
    }

    return { admitted, revived }
  })
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
  setTimeout(() => {
    void runCycle()
    timer = setInterval(() => {
      void runCycle()
    }, INTERVAL_MS)
  }, 90_000)
  console.log(
    `💰 [funding-admit] started: intervalMs=${INTERVAL_MS} minSats=${MIN_SATS} ` +
      `minConf=${MIN_CONFIRMATIONS} pagesPerCycle=${PAGES_PER_CYCLE} source=bitails`,
  )
}

export function stopWalletFundingAdmit(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
