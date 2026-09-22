#!/usr/bin/env tsx
/**
 * Verifies ARC txStatus classification and derived helpers.
 *
 * Run with: npx tsx scripts/verify-arc-tx-status.ts
 */

import {
  classifyArcTxStatus,
  changeIsSpendable,
  inputMayBeReleased,
  explorerBadge,
  type ArcPhase,
} from '../lib/arc-tx-status'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function assertPhase(status: string | null | undefined, expected: ArcPhase): void {
  const actual = classifyArcTxStatus(status)
  assert(
    actual === expected,
    `classifyArcTxStatus(${JSON.stringify(status)}) expected ${expected}, got ${actual}`,
  )
}

function assertBadge(
  phase: ArcPhase,
  expected: { label: string; title: string },
): void {
  const badge = explorerBadge(phase)
  assert(
    badge.label === expected.label && badge.title === expected.title,
    `explorerBadge('${phase}') expected ${JSON.stringify(expected)}, got ${JSON.stringify(badge)}`,
  )
}

assertPhase(null, 'pending')
assertPhase(undefined, 'pending')
assertPhase('', 'pending')
assertPhase('   ', 'pending')

assertPhase('DOUBLE_SPEND_ATTEMPTED', 'rejected')
assertPhase('REJECTED', 'rejected')
assertPhase('INVALID', 'rejected')
assertPhase('MALFORMED', 'rejected')
assertPhase('EVICTED', 'rejected')
assertPhase('TX_ORPHANED', 'rejected')

assertPhase('SEEN_IN_ORPHAN_MEMPOOL', 'orphan')

assertPhase('MINED_IN_STALE_BLOCK', 'reorg')

assertPhase('MINED', 'mined')
assertPhase('  MINED  ', 'mined')

assertPhase('SEEN_ON_NETWORK', 'seen')
assertPhase('ACCEPTED_BY_NETWORK', 'seen')

assertPhase('STORED', 'pending')
assertPhase('RECEIVED', 'pending')
assertPhase('ACCEPTED', 'pending')
assertPhase('ANNOUNCED_TO_NETWORK', 'pending')
assertPhase('REQUESTED_BY_NETWORK', 'pending')
assertPhase('SENT_TO_NETWORK', 'pending')
assertPhase('UNKNOWN', 'pending')
assertPhase('seen_on_network', 'pending')
assertPhase('SOME_FUTURE_STATUS', 'pending')

assert(changeIsSpendable('seen') === true, 'changeIsSpendable(seen) should be true')
assert(changeIsSpendable('mined') === true, 'changeIsSpendable(mined) should be true')
assert(changeIsSpendable('pending') === false, 'changeIsSpendable(pending) should be false')
assert(changeIsSpendable('rejected') === false, 'changeIsSpendable(rejected) should be false')
assert(changeIsSpendable('orphan') === false, 'changeIsSpendable(orphan) should be false')
assert(changeIsSpendable('reorg') === false, 'changeIsSpendable(reorg) should be false')

assert(inputMayBeReleased('rejected') === true, 'inputMayBeReleased(rejected) should be true')
assert(inputMayBeReleased('orphan') === false, 'inputMayBeReleased(orphan) should be false')
assert(inputMayBeReleased('pending') === false, 'inputMayBeReleased(pending) should be false')
assert(inputMayBeReleased('seen') === false, 'inputMayBeReleased(seen) should be false')
assert(inputMayBeReleased('mined') === false, 'inputMayBeReleased(mined) should be false')
assert(inputMayBeReleased('reorg') === false, 'inputMayBeReleased(reorg) should be false')

assertBadge('rejected', {
  label: 'Rejected',
  title: 'The broadcaster rejected this transaction.',
})
assertBadge('orphan', {
  label: 'Pending',
  title:
    'Stored by the broadcaster while a parent transaction was missing. The input stays locked.',
})
assertBadge('pending', {
  label: 'Pending',
  title: 'Accepted by the broadcaster. Not yet seen propagating on the network.',
})
assertBadge('seen', {
  label: 'In mempool',
  title: 'Seen propagating on the network. Not yet in a block.',
})
assertBadge('mined', {
  label: 'Confirmed',
  title: 'Included in a block.',
})
assertBadge('reorg', {
  label: 'Reorg',
  title: 'This transaction was mined in a block that is no longer canonical.',
})

console.log('arc-tx-status: ok')
process.exit(0)
