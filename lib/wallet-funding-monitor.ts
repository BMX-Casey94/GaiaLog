/**
 * Wallet Funding Monitor
 *
 * Periodic, low-cost telemetry that answers a single operationally critical
 * question: **how many days of throughput can each wallet still sustain
 * before it runs out of BSV?**
 *
 * The system is otherwise self-sustaining:
 *   - The DB-backed UTXO splitter (`lib/utxo-maintainer.ts`) refills the
 *     spendable pool from any wallet's larger inputs.
 *   - The confirmation worker promotes unconfirmed change to confirmed.
 *
 * The ONE thing the system cannot do for itself is mint fresh BSV — once a
 * wallet's total satoshi balance falls below "expected throughput × N days",
 * a human has to top it up from cold storage. This monitor exists to give
 * that human at least N days' notice instead of a surprise outage.
 *
 * Behaviour:
 *   - Every BSV_WALLET_FUNDING_CHECK_INTERVAL_MS (default 5 min):
 *     - For each wallet, computes (live UTXOs, total live sats, days runway).
 *     - Logs a single INFO line with the per-wallet snapshot.
 *     - Logs a CRITICAL alert per wallet when its runway < floor (default 7 days).
 *   - Self-throttles CRITICAL alerts to BSV_WALLET_FUNDING_ALERT_INTERVAL_MS
 *     (default 1 hour) per wallet so the operator inbox isn't flooded.
 *
 * Runway calculation:
 *   per_wallet_tps  = BSV_EXPECTED_TX_PER_DAY / wallet_count / 86400
 *   sats_per_tx     = BSV_UTXO_SPLIT_OUTPUT_SATS + ~28 sats fee
 *                     (matches lib/utxo-maintainer.ts SPLIT_FEE estimation)
 *   days_runway     = total_live_sats / (per_wallet_tps * sats_per_tx * 86400)
 *
 * Configurable via env:
 *   BSV_WALLET_FUNDING_CHECK_INTERVAL_MS  - default 300_000 (5 min)
 *   BSV_WALLET_FUNDING_FLOOR_DAYS         - default 7
 *   BSV_WALLET_FUNDING_ALERT_INTERVAL_MS  - default 3_600_000 (1 hour)
 *   BSV_WALLET_FUNDING_DISABLED=true      - opt out entirely
 */

import { walletManager } from './wallet-manager'
import { getInventoryDiagnostic } from './utxo-inventory'

const ENABLED = process.env.BSV_WALLET_FUNDING_DISABLED !== 'true'
const CHECK_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.BSV_WALLET_FUNDING_CHECK_INTERVAL_MS || 300_000),
)
const ALERT_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.BSV_WALLET_FUNDING_ALERT_INTERVAL_MS || 3_600_000),
)
const FLOOR_DAYS = Math.max(
  0.5,
  Number(process.env.BSV_WALLET_FUNDING_FLOOR_DAYS || 7),
)

// Avg sats spent per broadcast = split output + worst-case 1-in / 1-out
// P2PKH fee at 0.1025 sat/byte ≈ 28 sats. Mirrors the math in
// lib/utxo-maintainer.ts so runway estimates align with the real burn rate.
const APPROX_FEE_PER_TX_SATS = 28

let timer: NodeJS.Timeout | null = null
const lastCriticalAlertAt = new Map<number, number>()

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

interface RunwaySnapshot {
  walletIndex: number
  totalLiveUtxos: number
  confirmedLiveUtxos: number
  totalLiveSats: number
  confirmedLiveSats: number
  largestSats: number
  expectedSatsPerDay: number
  daysRunway: number
}

function computeExpectedSatsPerDay(walletCount: number): number {
  const perDay = envInt('BSV_EXPECTED_TX_PER_DAY', 2_000_000)
  const splitOutput = envInt('BSV_UTXO_SPLIT_OUTPUT_SATS', 2000)
  const perTxSats = splitOutput + APPROX_FEE_PER_TX_SATS
  const wallets = Math.max(1, walletCount)
  return Math.ceil((perDay / wallets) * perTxSats)
}

async function snapshotWallet(walletIndex: number, expectedSatsPerDay: number): Promise<RunwaySnapshot | null> {
  try {
    const diag = await getInventoryDiagnostic(walletIndex)
    const days = expectedSatsPerDay > 0 ? diag.totalLiveSats / expectedSatsPerDay : Infinity
    return {
      walletIndex,
      totalLiveUtxos: diag.totalLiveUtxos,
      confirmedLiveUtxos: diag.confirmedLiveUtxos,
      totalLiveSats: diag.totalLiveSats,
      confirmedLiveSats: diag.confirmedLiveSats,
      largestSats: diag.largestSats,
      expectedSatsPerDay,
      daysRunway: Number.isFinite(days) ? Math.round(days * 10) / 10 : Infinity,
    }
  } catch (err) {
    console.warn(
      `[funding-monitor] W${walletIndex + 1} snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

function maybeAlertCritical(snap: RunwaySnapshot): void {
  if (!Number.isFinite(snap.daysRunway)) return
  if (snap.daysRunway >= FLOOR_DAYS) {
    // Runway healthy — clear any prior alert throttle so we re-alert
    // promptly if the wallet drops back under floor later.
    lastCriticalAlertAt.delete(snap.walletIndex)
    return
  }
  const lastAt = lastCriticalAlertAt.get(snap.walletIndex) || 0
  if (Date.now() - lastAt < ALERT_INTERVAL_MS) return
  lastCriticalAlertAt.set(snap.walletIndex, Date.now())

  const address = walletManager.getWalletAddress(snap.walletIndex) || `(unknown wallet ${snap.walletIndex})`
  const bsv = (snap.totalLiveSats / 1e8).toFixed(8)
  console.error(
    `🚨 [CRITICAL] WALLET FUNDING LOW: W${snap.walletIndex + 1} (${address}) has ` +
      `${snap.daysRunway.toFixed(1)} days of runway remaining ` +
      `(${snap.totalLiveSats.toLocaleString()} sats / ${bsv} BSV across ${snap.totalLiveUtxos} UTXOs, ` +
      `burning ~${snap.expectedSatsPerDay.toLocaleString()} sats/day at the configured throughput). ` +
      `Floor: ${FLOOR_DAYS} days. ` +
      `ACTION: send fresh BSV to ${address} from your funding wallet now to avoid an outage. ` +
      `Re-alerts every ${Math.round(ALERT_INTERVAL_MS / 60_000)} min until balance is restored.`,
  )
}

async function runCycle(): Promise<void> {
  const walletCount = Math.max(0, walletManager.getWalletCount())
  if (walletCount === 0) return

  const expectedSatsPerDay = computeExpectedSatsPerDay(walletCount)

  const snapshots = await Promise.all(
    Array.from({ length: walletCount }, (_, i) => snapshotWallet(i, expectedSatsPerDay)),
  )

  const lines: string[] = []
  for (const snap of snapshots) {
    if (!snap) continue
    maybeAlertCritical(snap)
    const runwayStr = Number.isFinite(snap.daysRunway) ? `${snap.daysRunway}d` : '∞'
    const status = !Number.isFinite(snap.daysRunway)
      ? 'idle'
      : snap.daysRunway < FLOOR_DAYS
      ? 'CRITICAL'
      : snap.daysRunway < FLOOR_DAYS * 2
      ? 'warn'
      : 'ok'
    lines.push(
      `W${snap.walletIndex + 1}=[${status} runway=${runwayStr} ` +
        `utxos=${snap.totalLiveUtxos} (${snap.confirmedLiveUtxos} confirmed) ` +
        `sats=${snap.totalLiveSats.toLocaleString()} largest=${snap.largestSats.toLocaleString()}]`,
    )
  }
  if (lines.length > 0) {
    console.log(
      `💰 [funding-monitor] floor=${FLOOR_DAYS}d burn≈${expectedSatsPerDay.toLocaleString()} sats/day/wallet  ` +
        lines.join('  '),
    )
  }
}

export function startWalletFundingMonitor(): void {
  if (!ENABLED) {
    console.log('[funding-monitor] disabled via BSV_WALLET_FUNDING_DISABLED')
    return
  }
  if (timer) return
  // Stagger first run by 30s so it doesn't pile onto the maintainer's first
  // pass (which itself logs an inventory snapshot on startup).
  setTimeout(() => {
    void runCycle()
    timer = setInterval(() => { void runCycle() }, CHECK_INTERVAL_MS)
  }, 30_000)
  console.log(
    `💰 [funding-monitor] started: intervalMs=${CHECK_INTERVAL_MS} floorDays=${FLOOR_DAYS} ` +
      `alertIntervalMs=${ALERT_INTERVAL_MS}`,
  )
}

export function stopWalletFundingMonitor(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
