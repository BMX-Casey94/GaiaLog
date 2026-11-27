/**
 * ARC / broadcaster transaction status classification.
 *
 * Two call sites matter and they have genuinely different semantics:
 *
 *   - `arc` (ARC status endpoint, `GET /v1/tx/{txid}`): a status here is a
 *     point-in-time observation of ARC's own view. ARC can still mine a
 *     transaction it has flagged `DOUBLE_SPEND_ATTEMPTED` — the competing
 *     spend may lose. Releasing inputs on that report double-spends.
 *   - `broadcaster` (the `X-TxStatus` returned from a broadcast attempt): a
 *     terminal rejection from the broadcaster means the transaction will never
 *     be relayed by that node. Inputs can be released.
 *
 * Hence `DOUBLE_SPEND_ATTEMPTED` classifies as `pending` for ARC and
 * `rejected` for a broadcaster. Everything else is identical.
 */

export type ArcPhase =
  | 'rejected'
  | 'orphan'
  | 'pending'
  | 'seen'
  | 'mined'
  | 'immutable'
  | 'reorg'

/** Where a status string came from. Defaults to `arc` (the cautious choice). */
export type ArcStatusProvider = 'broadcaster' | 'arc' | 'woc'

const REJECTED_EXACT = new Set([
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'EVICTED',
])

/**
 * Statuses meaning "ARC holds the transaction and may still mine it".
 * Checked before the reject set so a caller cannot accidentally have them
 * treated as terminal.
 */
const PENDING_EXACT = new Set([
  'STORED',
  'RECEIVED',
  'ACCEPTED',
  'ANNOUNCED_TO_NETWORK',
  'REQUESTED_BY_NETWORK',
  'SENT_TO_NETWORK',
  'UNKNOWN',
  'PENDING_RETRY',
])

const SEEN_EXACT = new Set([
  'SEEN_ON_NETWORK',
  'ACCEPTED_BY_NETWORK',
  'SEEN_MULTIPLE_NODES',
  // STUMP = sub-tree of the merkle path. ARC only builds a proof for a
  // transaction it has seen; the change output is spendable.
  'STUMP_PROCESSING',
])

const CONFIRMED_EXACT = new Map<string, ArcPhase>([
  ['MINED', 'mined'],
  // IMMUTABLE means the block is buried past any realistic reorg. Terminal.
  ['IMMUTABLE', 'immutable'],
])

export function classifyArcTxStatus(
  status: string | null | undefined,
  provider: ArcStatusProvider = 'arc',
): ArcPhase {
  if (status == null) {
    return 'pending'
  }
  const trimmed = status.trim()
  if (trimmed === '') {
    return 'pending'
  }

  if (trimmed === 'SEEN_IN_ORPHAN_MEMPOOL') {
    return 'orphan'
  }
  if (trimmed === 'MINED_IN_STALE_BLOCK') {
    return 'reorg'
  }

  const confirmed = CONFIRMED_EXACT.get(trimmed)
  if (confirmed) {
    return confirmed
  }

  if (SEEN_EXACT.has(trimmed)) {
    return 'seen'
  }

  if (trimmed === 'DOUBLE_SPEND_ATTEMPTED') {
    // Only a broadcaster rejection is terminal. ARC reporting a competing
    // spend is not evidence that this transaction lost: hold the inputs.
    // 'woc' never reports this status, so it takes the cautious branch.
    return provider === 'broadcaster' ? 'rejected' : 'pending'
  }

  if (REJECTED_EXACT.has(trimmed)) {
    return 'rejected'
  }
  if (PENDING_EXACT.has(trimmed)) {
    return 'pending'
  }
  if (trimmed.toUpperCase().includes('ORPHAN')) {
    return 'rejected'
  }

  return 'pending'
}

export type ArcFollowUp = 'hold' | 'unlock-change' | 'confirm' | 'reorg' | 'release'

export function arcFollowUp(phase: ArcPhase): ArcFollowUp {
  switch (phase) {
    case 'orphan':
    case 'pending':
      return 'hold'
    case 'seen':
      return 'unlock-change'
    case 'mined':
    case 'immutable':
      return 'confirm'
    case 'reorg':
      return 'reorg'
    case 'rejected':
      return 'release'
  }
}

/** `mined` and `immutable` are both final confirmations. */
export function phaseIsConfirmed(phase: ArcPhase): boolean {
  return phase === 'mined' || phase === 'immutable'
}

export function shouldPersistArcPhase(previous: ArcPhase, next: ArcPhase): boolean {
  // Immutable is buried past any realistic reorg: nothing downgrades it, not
  // even a reorg report (which would set acquirable_at back to 'infinity' and
  // make genuinely spendable inventory disappear).
  if (previous === 'immutable') {
    return next === 'mined' || next === 'immutable'
  }

  // Mined can only be replaced by another confirmation or a reorg — a lagging
  // `seen`/`pending` poll must never undo it.
  if (previous === 'mined') {
    return next === 'mined' || next === 'immutable' || next === 'reorg'
  }

  // A broadcaster-rejected transaction is terminal; re-polling must not
  // resurrect it to pending/orphan. On-chain evidence is the only override.
  if (previous === 'rejected') {
    return next === 'mined' || next === 'immutable'
  }

  if (next === 'rejected' || next === 'reorg') return true
  if (previous === 'seen' && (next === 'pending' || next === 'orphan')) return false
  if (previous === 'reorg' && next !== 'mined' && next !== 'immutable') return false
  return true
}

/**
 * `arc_broadcast_status.phase` has a CHECK constraint
 * (db/migrations/0032_arc_broadcast_status.sql) that predates the
 * `immutable` phase: ('rejected','orphan','pending','seen','mined','reorg').
 * Persist `immutable` as `mined` — same meaning for every reader, and it keeps
 * the row out of the poller's open-batch index exactly like a mined row.
 */
export function arcBroadcastPhaseForDb(phase: ArcPhase): ArcPhase {
  return phase === 'immutable' ? 'mined' : phase
}

export function changeIsSpendable(phase: ArcPhase): boolean {
  return phase === 'seen' || phase === 'mined' || phase === 'immutable'
}

export function changeAcquirableAt(phase: ArcPhase | null): 'now' | 'infinity' | 'grace' {
  if (phase === null) return 'grace'
  if (phase === 'seen' || phase === 'mined' || phase === 'immutable') return 'now'
  return 'infinity'
}

export function inputMayBeReleased(phase: ArcPhase): boolean {
  return phase === 'rejected'
}

export function explorerBadge(phase: ArcPhase): { label: string; title: string } {
  switch (phase) {
    case 'rejected':
      return {
        label: 'Rejected',
        title: 'The broadcaster rejected this transaction.',
      }
    case 'orphan':
      return {
        label: 'Pending',
        title:
          'Stored by the broadcaster while a parent transaction was missing. The input stays locked.',
      }
    case 'pending':
      return {
        label: 'Pending',
        title: 'Accepted by the broadcaster. Not yet seen propagating on the network.',
      }
    case 'seen':
      return {
        label: 'In mempool',
        title: 'Seen propagating on the network. Not yet in a block.',
      }
    case 'mined':
      return {
        label: 'Confirmed',
        title: 'Included in a block.',
      }
    case 'immutable':
      return {
        label: 'Confirmed',
        title: 'Buried in a block. This transaction can no longer be reorganised.',
      }
    case 'reorg':
      return {
        label: 'Reorg',
        title: 'This transaction was mined in a block that is no longer canonical.',
      }
  }
}

/** Badge for explorer cards from stored ARC phase + confirmation flags. */
export function explorerCardBadge(input: {
  phase: ArcPhase | null
  confirmed: boolean
  blockHeight: number
}): { label: string; title: string } {
  const { phase, confirmed, blockHeight } = input
  if (phase === 'reorg') return explorerBadge('reorg')
  if (phase === 'rejected') return explorerBadge('rejected')
  if (phase === 'immutable') return explorerBadge('immutable')
  if (confirmed || blockHeight > 0 || phase === 'mined') return explorerBadge('mined')
  if (phase === 'seen' || phase === 'orphan' || phase === 'pending') {
    return explorerBadge(phase)
  }
  return {
    label: 'Pending',
    title: 'Broadcast recorded. Network visibility is unverified.',
  }
}
