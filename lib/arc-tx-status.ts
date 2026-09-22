export type ArcPhase = 'rejected' | 'orphan' | 'pending' | 'seen' | 'mined' | 'reorg'

const REJECTED_EXACT = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'EVICTED',
])

const PENDING_EXACT = new Set([
  'STORED',
  'RECEIVED',
  'ACCEPTED',
  'ANNOUNCED_TO_NETWORK',
  'REQUESTED_BY_NETWORK',
  'SENT_TO_NETWORK',
  'UNKNOWN',
])

const SEEN_EXACT = new Set(['SEEN_ON_NETWORK', 'ACCEPTED_BY_NETWORK'])

export function classifyArcTxStatus(status: string | null | undefined): ArcPhase {
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
  if (trimmed === 'MINED') {
    return 'mined'
  }
  if (SEEN_EXACT.has(trimmed)) {
    return 'seen'
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
      return 'confirm'
    case 'reorg':
      return 'reorg'
    case 'rejected':
      return 'release'
  }
}

export function shouldPersistArcPhase(previous: ArcPhase, next: ArcPhase): boolean {
  if (next === 'rejected' || next === 'reorg') return true
  if (previous === 'mined' && next !== 'mined') return false
  if (previous === 'seen' && (next === 'pending' || next === 'orphan')) return false
  if (previous === 'reorg' && next !== 'mined') return false
  return true
}

export function changeIsSpendable(phase: ArcPhase): boolean {
  return phase === 'seen' || phase === 'mined'
}

export function changeAcquirableAt(phase: ArcPhase | null): 'now' | 'infinity' | 'grace' {
  if (phase === null) return 'grace'
  if (phase === 'seen' || phase === 'mined') return 'now'
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
  if (confirmed || blockHeight > 0 || phase === 'mined') return explorerBadge('mined')
  if (phase === 'seen' || phase === 'orphan' || phase === 'pending') {
    return explorerBadge(phase)
  }
  return {
    label: 'Pending',
    title: 'Broadcast recorded. Network visibility is unverified.',
  }
}
