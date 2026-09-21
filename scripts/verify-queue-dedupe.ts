#!/usr/bin/env tsx
import dotenv from 'dotenv'

// Load env before the db module; imports are hoisted so it must be dynamic.
dotenv.config({ path: '.env.local' })
dotenv.config()

/**
 * Verifies the two properties that stop a reading being broadcast twice, and the
 * dedupe that stops a restart re-inserting work that is already queued.
 *
 * This runs against the real database rather than a mock, because both
 * properties are enforced by SQL predicates and not by application logic:
 * `ON CONFLICT (id) DO NOTHING` for the insert, and `WHERE status = 'queued'`
 * for the claim. A unit test with a fake database would prove nothing about
 * either — the bug being fixed was precisely that the real predicate never
 * matched.
 *
 * Every row it creates carries a unique prefix and is deleted on the way out,
 * including when a check fails.
 *
 * Run with: npx tsx scripts/verify-queue-dedupe.ts
 */

const PREFIX = `verify-dedupe-${Date.now()}-`

let failures = 0

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS  ${message}`)
  } else {
    failures++
    console.error(`  FAIL  ${message}`)
  }
}

/** Guards a check so a blocked lock cannot hang the run indefinitely. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms),
    ),
  ])
}

async function main(): Promise<void> {
  const { dbPool } = await import('@/lib/db')

  const idA = `${PREFIX}dedupe`
  const idB = `${PREFIX}claim`
  const idC = `${PREFIX}retry`
  const payload = JSON.stringify({ probe: 'verify-queue-dedupe' })
  const insert = `INSERT INTO worker_queue (id, priority, data, timestamp, retry_count, max_retries, status)
                  VALUES ($1, 'normal', $2::jsonb, $3, 0, 3, 'queued')
                  ON CONFLICT (id) DO NOTHING`

  try {
    console.log('1. Re-enqueue of the same reading collapses to one row')
    for (let attempt = 0; attempt < 3; attempt++) {
      await dbPool.query(insert, [idA, payload, Date.now()])
    }
    const dedupe = await dbPool.query(
      `SELECT count(*)::int AS n FROM worker_queue WHERE id = $1`,
      [idA],
    )
    check(
      dedupe.rows[0].n === 1,
      `3 identical inserts left ${dedupe.rows[0].n} row (expected 1)`,
    )

    console.log('2. Two workers claiming the same reading: exactly one wins')
    await dbPool.query(insert, [idB, payload, Date.now()])
    const claimSql = `UPDATE worker_queue SET status='processing', updated_at=now()
                       WHERE id = $1 AND status = 'queued'
                       RETURNING id`
    const first = await dbPool.connect()
    const second = await dbPool.connect()
    try {
      await first.query('BEGIN')
      const firstResult = await first.query(claimSql, [idB])
      // Issue the competing claim while the first holds the row lock, then give it
      // time to reach the server and block, so the lock path is genuinely tested
      // rather than the two statements merely running in sequence.
      const secondPromise = withTimeout(second.query(claimSql, [idB]), 10000, 'competing claim')
      await new Promise((resolve) => setTimeout(resolve, 200))
      await first.query('COMMIT')
      const secondResult = await secondPromise
      check(firstResult.rowCount === 1, 'first worker is granted the reading')
      check(secondResult.rowCount === 0, 'second worker is refused the reading')
    } finally {
      first.release()
      second.release()
    }

    console.log('3. A retry reuses the same row and id')
    await dbPool.query(insert, [idC, payload, Date.now()])
    await dbPool.query(
      `UPDATE worker_queue SET status='queued', retry_count=retry_count+1, timestamp=$2, updated_at=now()
        WHERE id = $1`,
      [idC, Date.now() + 1000],
    )
    const retry = await dbPool.query(
      `SELECT count(*)::int AS n, min(retry_count)::int AS rc, min(status) AS status
         FROM worker_queue WHERE id = $1`,
      [idC],
    )
    check(
      retry.rows[0].n === 1 && retry.rows[0].rc === 1 && retry.rows[0].status === 'queued',
      `retry left ${retry.rows[0].n} row(s), retry_count=${retry.rows[0].rc}, status=${retry.rows[0].status}`,
    )

    console.log('4. Ids are deterministic across processes (source_hash based)')
    const { WorkerQueue } = await import('@/lib/worker-queue')
    const generate = (WorkerQueue.prototype as any).generateItemId.bind({})
    const reading = { type: 'air-quality', source_hash: 'abc123', timestamp: 1, location: 'x', measurement: {} }
    const readingAgain = { ...reading }
    check(
      generate(reading) === generate(readingAgain),
      'the same reading yields the same id on a second enqueue',
    )
    check(
      generate(reading) !== generate({ ...reading, source_hash: 'different' }),
      'a different reading yields a different id',
    )
  } finally {
    const cleaned = await dbPool.query(`DELETE FROM worker_queue WHERE id LIKE $1`, [`${PREFIX}%`])
    console.log(`\nCleaned up ${cleaned.rowCount} verification row(s).`)
    // lib/db keeps background timers (pool monitors, reapers) alive, so waiting
    // for the event loop to drain would never return. Close the pool with a
    // bound and let the explicit exit below terminate the process.
    await withTimeout(dbPool.end(), 5000, 'pool shutdown').catch(() => {})
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nAll queue dedupe checks passed.')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
