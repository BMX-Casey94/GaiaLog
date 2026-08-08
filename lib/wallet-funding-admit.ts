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
 * Env:
 *   BSV_FUNDING_ADMIT_DISABLED=true          - opt out
 *   BSV_FUNDING_ADMIT_INTERVAL_MS            - default 300_000 (5 min)
 *   BSV_FUNDING_ADMIT_MIN_SATS               - default max(10_000, 2×split)
 *   BSV_FUNDING_ADMIT_MIN_CONFIRMATIONS      - default 1
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

let timer: NodeJS.Timeout | null = null
let running = false

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

async function fetchBitailsUnspent(address: string): Promise<BitailsUnspent[]> {
  const out: BitailsUnspent[] = []
  let from = 0
  for (;;) {
    const url = `${BITAILS_BASE}/address/${encodeURIComponent(address)}/unspent?from=${from}&limit=${PAGE_LIMIT}`
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      throw new Error(`Bitails ${res.status} for ${address}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = (await res.json()) as { unspent?: BitailsUnspent[] }
    const page = Array.isArray(body.unspent) ? body.unspent : []
    out.push(...page)
    if (page.length < PAGE_LIMIT) break
    from += page.length
    if (from > 10_000) break
  }
  return out
}

async function admitWalletFunding(walletIndex: number, address: string): Promise<{ admitted: number; revived: number }> {
  const discovered = await fetchBitailsUnspent(address)
  const candidates = discovered.filter((u) => {
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
  })
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
      `minConf=${MIN_CONFIRMATIONS} source=bitails`,
  )
}

export function stopWalletFundingAdmit(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
