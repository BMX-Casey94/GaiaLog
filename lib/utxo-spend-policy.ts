/**
 * Central UTXO confirmation policy for GaiaLog.
 * Keep queue gate, maintainer inventory, and spend path aligned via documented env vars.
 */

/** Minimum confirmations required to *spend* in writeToChain (0 = allow unconfirmed overlay rows). */
export function getMinSpendConfirmations(): number {
  const n = Number(process.env.BSV_MIN_SPEND_CONFIRMATIONS ?? 0)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

/**
 * Queue maintainer / pause gate: when counting "confirmed" UTXOs for backpressure.
 * Default 1 if unset (conservative). Explicit 0 allows counting unconfirmed overlay rows.
 */
export function getQueueGateMinConfirmations(): number {
  const raw = process.env.BSV_UTXO_MIN_CONFIRMATIONS
  if (raw === undefined || String(raw).trim() === '') return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 1
  return Math.floor(n)
}

/** Splitter inventory and legacy "confirmed" filtering use the same threshold as the queue gate. */
export function getMaintainerMinConfirmations(): number {
  return getQueueGateMinConfirmations()
}
