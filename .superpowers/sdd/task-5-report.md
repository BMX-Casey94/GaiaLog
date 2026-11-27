# Task 5 Report — Poll ARC for open broadcasts, and stop the timeout from deleting readings

## Status
DONE

## Commit
`2c3b2f149146e58270f543dcf354b5e567b36696` on branch `feat/arc-broadcast-status`

Message: `feat(arc): poll broadcast status and stop deleting unconfirmed readings`

## Files modified
- `lib/arc-tx-status.ts` — added `ArcFollowUp`, `arcFollowUp`, and `shouldPersistArcPhase` per the phase rules. Explorer card badges and spend-time `acquirable_at` helpers unchanged.
- `scripts/verify-arc-tx-status.ts` — asserts follow-up mapping and persist rules.
- `lib/arc-status-poller.ts` — new poller: oldest open ARC rows, serial GETs with 200ms gap, 429 cooldown, transport bumps `updated_at`, persist + `arcFollowUp` for seen/mined/reorg/release (no explorer deletes).
- `scripts/run-workers.ts` — starts/stops the poller beside the confirmation worker.
- `lib/blockchain.ts` — `enqueueConfirmationCheck` no-ops; `processConfirmationChecks` clears the heap; removed `cleanUpFailedTx` and the `removeUnconfirmedReading` import.
- `lib/confirmation-worker.ts` — both candidate queries exclude ARC-owned txids unless the poller is disabled or `arc_broadcast_status` is missing (`42P01` remembered for the process lifetime).

## Verification
Command: `npx tsx scripts/verify-arc-tx-status.ts`

Output:
```
arc-tx-status: ok
```

Exit code: 0

## Scope
Did not change explorer card labels or spend-time `acquirable_at` rules. Did not build an ARC callback receiver. Did not run `db:migrate`. Did not push.

## Concerns
None. Historical explorer rows without an ARC broadcast row still rely on the confirmation worker.
