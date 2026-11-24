#!/usr/bin/env tsx
/**
 * Verifies ARC txStatus classification and derived helpers.
 *
 * Run with: npx tsx scripts/verify-arc-tx-status.ts
 */

import {
  arcBroadcastPhaseForDb,
  classifyArcTxStatus,
  changeIsSpendable,
  changeAcquirableAt,
  inputMayBeReleased,
  explorerBadge,
  explorerCardBadge,
  arcFollowUp,
  phaseIsConfirmed,
  shouldPersistArcPhase,
  type ArcPhase,
  type ArcFollowUp,
  type ArcStatusProvider,
} from '../lib/arc-tx-status'
import { buildArcStatusRow } from '../lib/arc-broadcast-status'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function assertPhase(
  status: string | null | undefined,
  expected: ArcPhase,
  provider?: ArcStatusProvider,
): void {
  const actual = provider === undefined
    ? classifyArcTxStatus(status)
    : classifyArcTxStatus(status, provider)
  const label = provider === undefined
    ? `classifyArcTxStatus(${JSON.stringify(status)})`
    : `classifyArcTxStatus(${JSON.stringify(status)}, '${provider}')`
  assert(actual === expected, `${label} expected ${expected}, got ${actual}`)
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

// ─── Unrecognised / empty input ──────────────────────────────────────────────

assertPhase(null, 'pending')
assertPhase(undefined, 'pending')
assertPhase('', 'pending')
assertPhase('   ', 'pending')

// ─── Rejections ──────────────────────────────────────────────────────────────

assertPhase('REJECTED', 'rejected')
assertPhase('INVALID', 'rejected')
assertPhase('MALFORMED', 'rejected')
assertPhase('EVICTED', 'rejected')
assertPhase('TX_ORPHANED', 'rejected')

// ─── Provider-dependent DOUBLE_SPEND_ATTEMPTED ───────────────────────────────

// Default provider is 'arc': a competing spend is not proof this tx lost.
assertPhase('DOUBLE_SPEND_ATTEMPTED', 'pending')
assertPhase('DOUBLE_SPEND_ATTEMPTED', 'pending', 'arc')
// A broadcaster's terminal rejection is final; inputs may be released.
assertPhase('DOUBLE_SPEND_ATTEMPTED', 'rejected', 'broadcaster')
// WoC never reports this status; the cautious branch wins.
assertPhase('DOUBLE_SPEND_ATTEMPTED', 'pending', 'woc')
// Whitespace must not change the outcome.
assertPhase('  DOUBLE_SPEND_ATTEMPTED  ', 'pending', 'arc')
assertPhase('  DOUBLE_SPEND_ATTEMPTED  ', 'rejected', 'broadcaster')

// ─── Provider must not affect other statuses ─────────────────────────────────

for (const provider of ['arc', 'broadcaster', 'woc'] as const) {
  assertPhase('MINED', 'mined', provider)
  assertPhase('IMMUTABLE', 'immutable', provider)
  assertPhase('REJECTED', 'rejected', provider)
  assertPhase('SEEN_ON_NETWORK', 'seen', provider)
  assertPhase('SEEN_IN_ORPHAN_MEMPOOL', 'orphan', provider)
  assertPhase('MINED_IN_STALE_BLOCK', 'reorg', provider)
  assertPhase('STORED', 'pending', provider)
}

// ─── Orphan / reorg ──────────────────────────────────────────────────────────

assertPhase('SEEN_IN_ORPHAN_MEMPOOL', 'orphan')
assertPhase('MINED_IN_STALE_BLOCK', 'reorg')

// ─── Confirmed family ────────────────────────────────────────────────────────

assertPhase('MINED', 'mined')
assertPhase('  MINED  ', 'mined')
assertPhase('IMMUTABLE', 'immutable')
assertPhase('  immutable  ', 'pending') // wrong case is unrecognised, not confirmed

// ─── Seen family ─────────────────────────────────────────────────────────────

assertPhase('SEEN_ON_NETWORK', 'seen')
assertPhase('ACCEPTED_BY_NETWORK', 'seen')
assertPhase('SEEN_MULTIPLE_NODES', 'seen')
assertPhase('STUMP_PROCESSING', 'seen')

// ─── Pending family ──────────────────────────────────────────────────────────

assertPhase('STORED', 'pending')
assertPhase('RECEIVED', 'pending')
assertPhase('ACCEPTED', 'pending')
assertPhase('ANNOUNCED_TO_NETWORK', 'pending')
assertPhase('REQUESTED_BY_NETWORK', 'pending')
assertPhase('SENT_TO_NETWORK', 'pending')
assertPhase('PENDING_RETRY', 'pending')
assertPhase('UNKNOWN', 'pending')
assertPhase('seen_on_network', 'pending')
assertPhase('SOME_FUTURE_STATUS', 'pending')

// ─── arcFollowUp ─────────────────────────────────────────────────────────────

function assertFollowUp(phase: ArcPhase, expected: ArcFollowUp): void {
  const actual = arcFollowUp(phase)
  assert(actual === expected, `arcFollowUp('${phase}') expected ${expected}, got ${actual}`)
}

assertFollowUp('orphan', 'hold')
assertFollowUp('pending', 'hold')
assertFollowUp('seen', 'unlock-change')
assertFollowUp('mined', 'confirm')
assertFollowUp('immutable', 'confirm')
assertFollowUp('reorg', 'reorg')
assertFollowUp('rejected', 'release')

// ─── phaseIsConfirmed ────────────────────────────────────────────────────────

assert(phaseIsConfirmed('mined') === true, 'phaseIsConfirmed(mined) should be true')
assert(phaseIsConfirmed('immutable') === true, 'phaseIsConfirmed(immutable) should be true')
assert(phaseIsConfirmed('seen') === false, 'phaseIsConfirmed(seen) should be false')
assert(phaseIsConfirmed('rejected') === false, 'phaseIsConfirmed(rejected) should be false')

// ─── shouldPersistArcPhase ───────────────────────────────────────────────────

assert(shouldPersistArcPhase('pending', 'rejected') === true, 'shouldPersist rejected → true')
assert(shouldPersistArcPhase('mined', 'reorg') === true, 'shouldPersist mined→reorg → true')
assert(shouldPersistArcPhase('mined', 'pending') === false, 'shouldPersist mined→pending → false')
assert(shouldPersistArcPhase('mined', 'seen') === false, 'shouldPersist mined→seen → false')
assert(shouldPersistArcPhase('mined', 'immutable') === true, 'shouldPersist mined→immutable → true')
assert(shouldPersistArcPhase('seen', 'pending') === false, 'shouldPersist seen→pending → false')
assert(shouldPersistArcPhase('seen', 'orphan') === false, 'shouldPersist seen→orphan → false')
assert(shouldPersistArcPhase('seen', 'immutable') === true, 'shouldPersist seen→immutable → true')
assert(shouldPersistArcPhase('reorg', 'pending') === false, 'shouldPersist reorg→pending → false')
assert(shouldPersistArcPhase('reorg', 'seen') === false, 'shouldPersist reorg→seen → false')
assert(shouldPersistArcPhase('reorg', 'mined') === true, 'shouldPersist reorg→mined → true')
assert(shouldPersistArcPhase('reorg', 'reorg') === true, 'shouldPersist reorg→reorg → true')
assert(shouldPersistArcPhase('reorg', 'rejected') === true, 'shouldPersist reorg→rejected → true')
assert(shouldPersistArcPhase('reorg', 'immutable') === true, 'shouldPersist reorg→immutable → true')
assert(shouldPersistArcPhase('pending', 'seen') === true, 'shouldPersist pending→seen → true')
assert(shouldPersistArcPhase('seen', 'mined') === true, 'shouldPersist seen→mined → true')
assert(shouldPersistArcPhase('orphan', 'pending') === true, 'shouldPersist orphan→pending → true')

// Immutable is terminal: nothing downgrades it, not even a reorg report.
assert(shouldPersistArcPhase('immutable', 'pending') === false, 'shouldPersist immutable→pending → false')
assert(shouldPersistArcPhase('immutable', 'seen') === false, 'shouldPersist immutable→seen → false')
assert(shouldPersistArcPhase('immutable', 'orphan') === false, 'shouldPersist immutable→orphan → false')
assert(shouldPersistArcPhase('immutable', 'reorg') === false, 'shouldPersist immutable→reorg → false')
assert(shouldPersistArcPhase('immutable', 'rejected') === false, 'shouldPersist immutable→rejected → false')
assert(shouldPersistArcPhase('immutable', 'immutable') === true, 'shouldPersist immutable→immutable → true')
assert(shouldPersistArcPhase('immutable', 'mined') === true, 'shouldPersist immutable→mined → true')

// Rejected is terminal unless the chain confirms it.
assert(shouldPersistArcPhase('rejected', 'pending') === false, 'shouldPersist rejected→pending → false')
assert(shouldPersistArcPhase('rejected', 'orphan') === false, 'shouldPersist rejected→orphan → false')
assert(shouldPersistArcPhase('rejected', 'seen') === false, 'shouldPersist rejected→seen → false')
assert(shouldPersistArcPhase('rejected', 'rejected') === false, 'shouldPersist rejected→rejected → false')
assert(shouldPersistArcPhase('rejected', 'reorg') === false, 'shouldPersist rejected→reorg → false')
assert(shouldPersistArcPhase('rejected', 'mined') === true, 'shouldPersist rejected→mined → true')
assert(shouldPersistArcPhase('rejected', 'immutable') === true, 'shouldPersist rejected→immutable → true')

// ─── changeIsSpendable ──────────────────────────────────────────────────────

assert(changeIsSpendable('seen') === true, 'changeIsSpendable(seen) should be true')
assert(changeIsSpendable('mined') === true, 'changeIsSpendable(mined) should be true')
assert(changeIsSpendable('immutable') === true, 'changeIsSpendable(immutable) should be true')
assert(changeIsSpendable('pending') === false, 'changeIsSpendable(pending) should be false')
assert(changeIsSpendable('rejected') === false, 'changeIsSpendable(rejected) should be false')
assert(changeIsSpendable('orphan') === false, 'changeIsSpendable(orphan) should be false')
assert(changeIsSpendable('reorg') === false, 'changeIsSpendable(reorg) should be false')

// ─── changeAcquirableAt ─────────────────────────────────────────────────────

assert(changeAcquirableAt('seen') === 'now', "changeAcquirableAt(seen) should be 'now'")
assert(changeAcquirableAt('mined') === 'now', "changeAcquirableAt(mined) should be 'now'")
assert(changeAcquirableAt('immutable') === 'now', "changeAcquirableAt(immutable) should be 'now'")
assert(changeAcquirableAt('orphan') === 'infinity', "changeAcquirableAt(orphan) should be 'infinity'")
assert(changeAcquirableAt('pending') === 'infinity', "changeAcquirableAt(pending) should be 'infinity'")
assert(changeAcquirableAt('reorg') === 'infinity', "changeAcquirableAt(reorg) should be 'infinity'")
assert(changeAcquirableAt('rejected') === 'infinity', "changeAcquirableAt(rejected) should be 'infinity'")
assert(changeAcquirableAt(null) === 'grace', "changeAcquirableAt(null) should be 'grace'")

// ─── inputMayBeReleased ─────────────────────────────────────────────────────

assert(inputMayBeReleased('rejected') === true, 'inputMayBeReleased(rejected) should be true')
assert(inputMayBeReleased('orphan') === false, 'inputMayBeReleased(orphan) should be false')
assert(inputMayBeReleased('pending') === false, 'inputMayBeReleased(pending) should be false')
assert(inputMayBeReleased('seen') === false, 'inputMayBeReleased(seen) should be false')
assert(inputMayBeReleased('mined') === false, 'inputMayBeReleased(mined) should be false')
assert(inputMayBeReleased('immutable') === false, 'inputMayBeReleased(immutable) should be false')
assert(inputMayBeReleased('reorg') === false, 'inputMayBeReleased(reorg) should be false')

// ─── arcBroadcastPhaseForDb (CHECK constraint on arc_broadcast_status) ──────

assert(
  arcBroadcastPhaseForDb('immutable') === 'mined',
  `arcBroadcastPhaseForDb(immutable) should be 'mined', got '${arcBroadcastPhaseForDb('immutable')}'`,
)
for (const phase of ['rejected', 'orphan', 'pending', 'seen', 'mined', 'reorg'] as const) {
  assert(
    arcBroadcastPhaseForDb(phase) === phase,
    `arcBroadcastPhaseForDb(${phase}) should be unchanged`,
  )
}

// ─── Badges ─────────────────────────────────────────────────────────────────

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
assertBadge('immutable', {
  label: 'Confirmed',
  title: 'Buried in a block. This transaction can no longer be reorganised.',
})
assertBadge('reorg', {
  label: 'Reorg',
  title: 'This transaction was mined in a block that is no longer canonical.',
})

// ─── explorerCardBadge ──────────────────────────────────────────────────────

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
  const badge = explorerCardBadge({ phase: 'immutable', confirmed: false, blockHeight: 0 })
  assert(badge.label === 'Confirmed', `immutable card badge expected Confirmed, got ${badge.label}`)
  assert(
    badge.title.toLowerCase().includes('reorganised'),
    `immutable card badge title should say it cannot be reorganised, got ${JSON.stringify(badge.title)}`,
  )
}

// ─── buildArcStatusRow ─────────────────────────────────────────────────────

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
{
  const row = buildArcStatusRow('IMMUTABLE', 'taal_arc')
  assert(row.phase === 'immutable', `buildArcStatusRow(IMMUTABLE) expected immutable, got ${row.phase}`)
}
{
  // buildArcStatusRow calls classifyArcTxStatus with the default ('arc')
  // provider: a competing spend is not terminal here.
  const row = buildArcStatusRow('DOUBLE_SPEND_ATTEMPTED', 'taal_arc')
  assert(
    row.phase === 'pending',
    `buildArcStatusRow(DOUBLE_SPEND_ATTEMPTED) expected pending on the arc provider, got ${row.phase}`,
  )
}

console.log('arc-tx-status: ok')
process.exit(0)
