/**
 * Overlay treasury inventory telemetry, drift detection, and throttled ops logging.
 */

import { walletManager } from './wallet-manager'
import { getTreasuryTopicForWallet } from './spend-source'
import { getWalletInventorySummary } from './utxo-inventory'
import { getMinSpendConfirmations, getQueueGateMinConfirmations } from './utxo-spend-policy'

const lastDriftLogAt = new Map<string, number>()
const DRIFT_LOG_INTERVAL_MS = Math.max(30_000, Number(process.env.BSV_UTXO_DRIFT_LOG_INTERVAL_MS || 120_000))

function shouldLog(key: string): boolean {
  const now = Date.now()
  const last = lastDriftLogAt.get(key) || 0
  if (now - last < DRIFT_LOG_INTERVAL_MS) return false
  lastDriftLogAt.set(key, now)
  return true
}

export interface TreasuryOverlayInventoryRow {
  walletIndex: number
  walletLabel: string
  topic: string
  totalSpendable: number
  confirmedSpendable: number
  totalReserve: number
  confirmedReserve: number
  lockedPool: number
  lockedReserve: number
  error?: string
}

/**
 * Parallel-safe counts per wallet (overlay or legacy spend source).
 */
export async function fetchTreasuryOverlayInventorySnapshot(): Promise<TreasuryOverlayInventoryRow[]> {
  const count = Math.max(0, walletManager.getWalletCount())

  const rows = await Promise.all(
    Array.from({ length: count }, async (_, walletIndex) => {
      const topic = getTreasuryTopicForWallet(walletIndex)
      const label = `W${walletIndex + 1}`
      try {
        const summary = await getWalletInventorySummary(walletIndex)
        return {
          walletIndex,
          walletLabel: label,
          topic,
          totalSpendable: summary.totalPool,
          confirmedSpendable: summary.confirmedPool,
          totalReserve: summary.totalReserve,
          confirmedReserve: summary.confirmedReserve,
          lockedPool: summary.lockedPool,
          lockedReserve: summary.lockedReserve,
        } satisfies TreasuryOverlayInventoryRow
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          walletIndex,
          walletLabel: label,
          topic,
          totalSpendable: 0,
          confirmedSpendable: 0,
          totalReserve: 0,
          confirmedReserve: 0,
          lockedPool: 0,
          lockedReserve: 0,
          error: message,
        } satisfies TreasuryOverlayInventoryRow
      }
    }),
  )

  return rows.sort((a, b) => a.walletIndex - b.walletIndex)
}

/** When spend path requires confirmed UTXOs but overlay only has unconfirmed rows. */
export function logOverlayUnconfirmedOnlyBlocked(walletIndex: number, totalAny: number, minSpend: number): void {
  if (totalAny <= 0 || minSpend <= 0) return
  const key = `block-w${walletIndex}`
  if (!shouldLog(key)) return
  console.warn(
    `[UTXO policy] W${walletIndex + 1}: overlay reports ${totalAny} spendable UTXO(s) (any confirmation) but 0 with confirmed=true. ` +
      `BSV_MIN_SPEND_CONFIRMATIONS=${minSpend} requires confirmed rows. Options: set BSV_MIN_SPEND_CONFIRMATIONS=0 to spend unconfirmed (operational risk), ` +
      `or fix overlay confirmation sync (block height / admitted_utxos.confirmed).`,
  )
}

/** When listSpendable returned empty but count says rows exist (stale cache or parsing issue). */
export function logOverlayEmptyListDrift(walletIndex: number, totalAny: number): void {
  const key = `empty-list-w${walletIndex}`
  if (!shouldLog(key)) return
  console.warn(
    `[UTXO drift] W${walletIndex + 1}: listSpendable returned 0 rows but countSpendable(confirmedOnly=false)=${totalAny}. ` +
      `Retrying once after cache bust. If this repeats, inspect overlay /lookup responses and BSV_SPEND_SOURCE_LIST_LIMIT.`,
  )
}

/**
 * Periodic maintainer-friendly summary: unconfirmed-only inventory when totals > 0.
 */
export async function logTreasuryOverlayInventorySummary(): Promise<void> {
  const mode = String(process.env.BSV_SPEND_SOURCE_MODE || '').toLowerCase()
  if (mode !== 'overlay') return

  try {
    const rows = await fetchTreasuryOverlayInventorySnapshot()
    const minSpend = getMinSpendConfirmations()
    const gateMin = getQueueGateMinConfirmations()

    for (const r of rows) {
      if (r.error) {
        if (shouldLog(`inv-err-${r.walletIndex}`)) {
          console.warn(`[UTXO inventory] ${r.walletLabel} (${r.topic}): count failed — ${r.error}`)
        }
        continue
      }
      if (r.totalSpendable === 0) continue

      if (r.confirmedSpendable === 0 && r.totalSpendable > 0) {
        if (shouldLog(`inv-unconf-${r.walletIndex}`)) {
          console.log(
            `[UTXO inventory] ${r.walletLabel}: pool=${r.totalSpendable} row(s), reserve=${r.totalReserve}, 0 pool rows marked confirmed in DB. ` +
              `minSpendConf=${minSpend}, queueGateMinConf=${gateMin}. ` +
              (minSpend === 0
                ? 'Spends may use unconfirmed rows (BSV_MIN_SPEND_CONFIRMATIONS=0).'
                : 'Spends require confirmed rows — writes may stall until confirmation sync catches up.'),
          )
        }
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (shouldLog('inv-fatal')) {
      console.warn(`[UTXO inventory] snapshot failed: ${message}`)
    }
  }
}
