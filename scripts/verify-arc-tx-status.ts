#!/usr/bin/env tsx
/**
 * Verifies ARC txStatus classification and derived helpers.
 *
 * Run with: npx tsx scripts/verify-arc-tx-status.ts
 */

import {
  classifyArcTxStatus,
  changeIsSpendable,
  changeAcquirableAt,
  inputMayBeReleased,
  explorerBadge,
  explorerCardBadge,
  type ArcPhase,
} from '../lib/arc-tx-status'
import { buildArcStatusRow } from '../lib/arc-broadcast-status'

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

assert(changeAcquirableAt('seen') === 'now', "changeAcquirableAt(seen) should be 'now'")
assert(changeAcquirableAt('mined') === 'now', "changeAcquirableAt(mined) should be 'now'")
assert(changeAcquirableAt('orphan') === 'infinity', "changeAcquirableAt(orphan) should be 'infinity'")
assert(changeAcquirableAt('pending') === 'infinity', "changeAcquirableAt(pending) should be 'infinity'")
assert(changeAcquirableAt('reorg') === 'infinity', "changeAcquirableAt(reorg) should be 'infinity'")
assert(changeAcquirableAt('rejected') === 'infinity', "changeAcquirableAt(rejected) should be 'infinity'")
assert(changeAcquirableAt(null) === 'grace', "changeAcquirableAt(null) should be 'grace'")

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

{
  const badge = explorerCardBadge({ phase: null, confirmed: false, blockHeight: 0 })
  assert(badge.label === 'Pending', `null-phase card badge label expected Pending, got ${badge.label}`)
  assert(
    badge.title.toLowerCase().includes('unverified'),
    `null-phase card badge title should contain unverified, got ${JSON.stringify(badge.title)}`,
  )
}
{
  const badge = explorerCardBadge({ phase: 'seen', confirmed: false, blockHeight: 0 })
  assert(badge.label === 'In mempool', `seen card badge expected In mempool, got ${badge.label}`)
}
{
  const badge = explorerCardBadge({ phase: 'pending', confirmed: false, blockHeight: 0 })
  assert(badge.label === 'Pending', `pending card badge expected Pending, got ${badge.label}`)
  assert(
    !badge.title.toLowerCase().includes('unverified'),
    `pending card badge title must not contain unverified, got ${JSON.stringify(badge.title)}`,
  )
}
{
  const badge = explorerCardBadge({ phase: 'orphan', confirmed: false, blockHeight: 0 })
  assert(badge.label === 'Pending', `orphan card badge expected Pending, got ${badge.label}`)
}
{
  const badge = explorerCardBadge({ phase: null, confirmed: true, blockHeight: 0 })
  assert(badge.label === 'Confirmed', `confirmed null-phase card badge expected Confirmed, got ${badge.label}`)
}
{
  const badge = explorerCardBadge({ phase: 'reorg', confirmed: true, blockHeight: 10 })
  assert(badge.label === 'Reorg', `reorg card badge expected Reorg, got ${badge.label}`)
}
{
  const badge = explorerCardBadge({ phase: 'rejected', confirmed: false, blockHeight: 0 })
  assert(badge.label === 'Rejected', `rejected card badge expected Rejected, got ${badge.label}`)
}
{
  const badge = explorerCardBadge({ phase: 'mined', confirmed: false, blockHeight: 0 })
  assert(badge.label === 'Confirmed', `mined card badge expected Confirmed, got ${badge.label}`)
}

{
  const row = buildArcStatusRow(null, null)
  assert(row.txStatus === '', `buildArcStatusRow(null) txStatus expected '', got ${JSON.stringify(row.txStatus)}`)
  assert(row.phase === 'pending', `buildArcStatusRow(null) phase expected pending, got ${row.phase}`)
}
{
  const row = buildArcStatusRow('SEEN_IN_ORPHAN_MEMPOOL', 'taal_arc')
  assert(row.phase === 'orphan', `buildArcStatusRow(SEEN_IN_ORPHAN_MEMPOOL) expected orphan, got ${row.phase}`)
}
{
  const row = buildArcStatusRow('SEEN_ON_NETWORK', 'taal_arc')
  assert(row.phase === 'seen', `buildArcStatusRow(SEEN_ON_NETWORK) expected seen, got ${row.phase}`)
}
{
  const row = buildArcStatusRow('MINED', 'taal_arc')
  assert(row.phase === 'mined', `buildArcStatusRow(MINED) expected mined, got ${row.phase}`)
}
{
  const row = buildArcStatusRow('MINED_IN_STALE_BLOCK', 'taal_arc')
  assert(row.phase === 'reorg', `buildArcStatusRow(MINED_IN_STALE_BLOCK) expected reorg, got ${row.phase}`)
}

console.log('arc-tx-status: ok')
process.exit(0)
