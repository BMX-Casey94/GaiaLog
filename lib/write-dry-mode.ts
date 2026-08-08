/**
 * Write Dry Mode ("idle cleanly until refunded")
 *
 * Problem this solves
 * -------------------
 * When every wallet's spendable inventory is exhausted, the collectors used to
 * keep building and broadcasting transactions anyway. Each attempt failed at
 * the broadcaster, was released with only a short cooldown, and was retried by
 * the next worker — producing a log storm, wasted ARC calls, unbounded retry
 * queues, and (worst case) chains of unconfirmed change that later turn into
 * ARC 460 "parent transaction not found" phantoms.
 *
 * The correct behaviour for a funding outage is to go quiet: stop attempting
 * chain writes, keep the process healthy, and resume automatically the moment
 * real spendable inventory exists again (operator top-up admitted by
 * `lib/wallet-funding-admit.ts`, or a manual recovery import).
 *
 * Detection
 * ---------
 * Gating on UTXO *counts* is unsafe: a wallet can hold hundreds of thousands
 * of sub-fee dust rows and still be unable to fund a single write. We
 * therefore gate on the *largest single spendable UTXO* per wallet, since a
 * BSV write is funded from one input:
 *
 *   dry  ⟺  max(largest usable UTXO across all wallets) < MIN_INPUT_SATS
 *
 * `MIN_INPUT_SATS` defaults to the maintainer's split output size, which is
 * exactly the denomination the system mints for writes. When
 * BSV_UTXO_MIN_CONFIRMATIONS > 0 the confirmed-only figure is used, matching
 * the spend policy.
 *
 * Entering dry mode requires the condition to hold for two consecutive checks
 * (no flapping while the splitter is mid-cycle). Exiting is immediate on the
 * first healthy observation so throughput resumes fast after a top-up.
 *
 * Env
 * ---
 *   BSV_WRITE_DRY_MODE_DISABLED=true   - opt out (writes always attempted)
 *   BSV_WRITE_DRY_CHECK_INTERVAL_MS    - default 30_000
 *   BSV_WRITE_DRY_MIN_INPUT_SATS       - default BSV_UTXO_SPLIT_OUTPUT_SATS
 *   BSV_WRITE_DRY_LOG_INTERVAL_MS      - default 600_000 (10 min while dry)
 */

import { walletManager } from './wallet-manager'
import { getInventoryDiagnostic } from './utxo-inventory'
import { getMinSpendConfirmations } from './utxo-spend-policy'

const ENABLED = process.env.BSV_WRITE_DRY_MODE_DISABLED !== 'true'
const CHECK_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.BSV_WRITE_DRY_CHECK_INTERVAL_MS || 30_000),
)
const LOG_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.BSV_WRITE_DRY_LOG_INTERVAL_MS || 600_000),
)

function minInputSats(): number {
  const explicit = Number(process.env.BSV_WRITE_DRY_MIN_INPUT_SATS)
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  const splitOutput = Number(process.env.BSV_UTXO_SPLIT_OUTPUT_SATS)
  return Number.isFinite(splitOutput) && splitOutput > 0 ? Math.floor(splitOutput) : 500
}

export interface DryModeWalletSnapshot {
  walletIndex: number
  largestSats: number
  largestConfirmedSats: number
  totalLiveSats: number
  usable: boolean
}

export interface DryModeState {
  enabled: boolean
  dry: boolean
  sinceMs: number | null
  minInputSats: number
  confirmedOnly: boolean
  largestUsableSats: number
  suppressedWrites: number
  lastCheckedAt: number | null
  wallets: DryModeWalletSnapshot[]
}

// globalThis-pinned so Next.js dev-mode module reloads cannot produce two
// independent gates disagreeing about whether writes are allowed.
const _g = globalThis as any
if (!_g.__GAIALOG_WRITE_DRY_STATE__) {
  _g.__GAIALOG_WRITE_DRY_STATE__ = {
    dry: false,
    sinceMs: null as number | null,
    consecutiveDryChecks: 0,
    suppressedWrites: 0,
    lastCheckedAt: null as number | null,
    lastLoggedAt: 0,
    largestUsableSats: 0,
    wallets: [] as DryModeWalletSnapshot[],
  }
}
const state: {
  dry: boolean
  sinceMs: number | null
  consecutiveDryChecks: number
  suppressedWrites: number
  lastCheckedAt: number | null
  lastLoggedAt: number
  largestUsableSats: number
  wallets: DryModeWalletSnapshot[]
} = _g.__GAIALOG_WRITE_DRY_STATE__

let timer: NodeJS.Timeout | null = null
let running = false

/**
 * Hot-path check used by the collectors and the queue. Never touches the
 * database — it only reads the cached verdict refreshed by the poller, so it
 * is safe to call per item.
 */
export function isWritePausedForFunding(): boolean {
  if (!ENABLED) return false
  return state.dry === true
}

export function recordSuppressedWrites(count: number = 1): void {
  if (count > 0) state.suppressedWrites += count
}

export function getDryModeState(): DryModeState {
  return {
    enabled: ENABLED,
    dry: state.dry,
    sinceMs: state.sinceMs,
    minInputSats: minInputSats(),
    confirmedOnly: getMinSpendConfirmations() > 0,
    largestUsableSats: state.largestUsableSats,
    suppressedWrites: state.suppressedWrites,
    lastCheckedAt: state.lastCheckedAt,
    wallets: state.wallets,
  }
}

async function evaluate(): Promise<void> {
  const walletCount = Math.max(0, walletManager.getWalletCount())
  if (walletCount === 0) return

  const floor = minInputSats()
  const confirmedOnly = getMinSpendConfirmations() > 0

  const snapshots: DryModeWalletSnapshot[] = []
  let failures = 0

  for (let walletIndex = 0; walletIndex < walletCount; walletIndex++) {
    try {
      const diag = await getInventoryDiagnostic(walletIndex)
      const largestUsable = confirmedOnly ? diag.largestConfirmedSats : diag.largestSats
      snapshots.push({
        walletIndex,
        largestSats: diag.largestSats,
        largestConfirmedSats: diag.largestConfirmedSats,
        totalLiveSats: diag.totalLiveSats,
        usable: largestUsable >= floor,
      })
    } catch (err) {
      failures++
      console.warn(
        `[write-dry-mode] W${walletIndex + 1} inventory check failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Never gate writes on our own inability to read the database. A DB blip
  // must not silently halt the whole pipeline — let the broadcast path fail
  // loudly instead.
  if (snapshots.length === 0) {
    state.consecutiveDryChecks = 0
    return
  }

  state.lastCheckedAt = Date.now()
  state.wallets = snapshots
  state.largestUsableSats = snapshots.reduce(
    (max, s) => Math.max(max, confirmedOnly ? s.largestConfirmedSats : s.largestSats),
    0,
  )

  const anyUsable = snapshots.some((s) => s.usable)

  if (anyUsable) {
    state.consecutiveDryChecks = 0
    if (state.dry) {
      const outageMs = state.sinceMs ? Date.now() - state.sinceMs : 0
      console.log(
        `▶️  [write-dry-mode] CLEARED: spendable inventory restored ` +
          `(largest=${state.largestUsableSats.toLocaleString()} sats ≥ floor=${floor.toLocaleString()}). ` +
          `Outage lasted ${Math.round(outageMs / 60_000)} min; ` +
          `${state.suppressedWrites.toLocaleString()} write attempts were suppressed. Resuming writes.`,
      )
      state.dry = false
      state.sinceMs = null
      state.suppressedWrites = 0
    }
    return
  }

  // Partial read (some wallets errored) is not enough evidence to halt.
  if (failures > 0 && snapshots.length < walletCount) {
    state.consecutiveDryChecks = 0
    return
  }

  state.consecutiveDryChecks++
  if (!state.dry && state.consecutiveDryChecks < 2) return

  if (!state.dry) {
    state.dry = true
    state.sinceMs = Date.now()
    state.suppressedWrites = 0
    state.lastLoggedAt = Date.now()
    const detail = snapshots
      .map(
        (s) =>
          `W${s.walletIndex + 1}=[largest=${(confirmedOnly ? s.largestConfirmedSats : s.largestSats).toLocaleString()} ` +
          `total=${s.totalLiveSats.toLocaleString()}]`,
      )
      .join(' ')
    console.error(
      `⏸️  [write-dry-mode] ENGAGED: no wallet holds a spendable UTXO ≥ ${floor.toLocaleString()} sats ` +
        `(confirmedOnly=${confirmedOnly}). ${detail}. ` +
        `Chain writes are now suppressed instead of failing in a retry loop. ` +
        `ACTION: fund a wallet with a single confirmed UTXO; funding-admit will admit it and writes resume automatically.`,
    )
    return
  }

  // Already dry — throttled reminder so the outage stays visible in logs.
  if (Date.now() - state.lastLoggedAt >= LOG_INTERVAL_MS) {
    state.lastLoggedAt = Date.now()
    const outageMs = state.sinceMs ? Date.now() - state.sinceMs : 0
    console.error(
      `⏸️  [write-dry-mode] still dry after ${Math.round(outageMs / 60_000)} min ` +
        `(largest=${state.largestUsableSats.toLocaleString()} sats < floor=${floor.toLocaleString()}, ` +
        `${state.suppressedWrites.toLocaleString()} writes suppressed). Awaiting funding.`,
    )
  }
}

async function runCycle(): Promise<void> {
  if (running) return
  running = true
  try {
    await evaluate()
  } catch (err) {
    console.warn(
      `[write-dry-mode] cycle failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    running = false
  }
}

export function startWriteDryModeMonitor(): void {
  if (!ENABLED) {
    console.log('[write-dry-mode] disabled via BSV_WRITE_DRY_MODE_DISABLED')
    return
  }
  if (timer) return
  // Evaluate once up front so a process that boots into a dry wallet does not
  // spend its first cycle hammering the broadcasters.
  void runCycle()
  timer = setInterval(() => {
    void runCycle()
  }, CHECK_INTERVAL_MS)
  console.log(
    `🛟 [write-dry-mode] started: intervalMs=${CHECK_INTERVAL_MS} minInputSats=${minInputSats()} ` +
      `confirmedOnly=${getMinSpendConfirmations() > 0}`,
  )
}

export function stopWriteDryModeMonitor(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
