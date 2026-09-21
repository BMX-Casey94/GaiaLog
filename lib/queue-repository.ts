import { query } from '@/lib/db'
import { ensureRelationExists } from '@/lib/ensure-relation'

export type QueueRow = {
  id: string
  priority: 'high' | 'normal'
  data: any
  timestamp: number
  retry_count: number
  max_retries: number
  status: 'queued' | 'processing' | 'completed' | 'failed'
  last_error: string | null
  updated_at: string | null
}

const WORKER_QUEUE_DDL = `
  CREATE TABLE IF NOT EXISTS worker_queue (
    id text PRIMARY KEY,
    priority text NOT NULL,
    data jsonb NOT NULL,
    timestamp bigint NOT NULL,
    retry_count integer NOT NULL DEFAULT 0,
    max_retries integer NOT NULL DEFAULT 3,
    status text NOT NULL DEFAULT 'queued',
    last_error text NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS worker_queue_status_idx ON worker_queue(status);
  CREATE INDEX IF NOT EXISTS worker_queue_updated_idx ON worker_queue(updated_at);
`

let _queueTableReady: Promise<void> | null = null

export function ensureQueueTable(): Promise<void> {
  if (!_queueTableReady) {
    // Probe first — do not re-issue CREATE TABLE on every failure/timeout when
    // the table already exists (that stampeded Supabase logs under pool load).
    _queueTableReady = ensureRelationExists('public.worker_queue', WORKER_QUEUE_DDL).catch((err) => {
      _queueTableReady = null
      throw err
    })
  }
  return _queueTableReady
}

export async function enqueueQueueItem(row: Omit<QueueRow, 'status' | 'last_error' | 'updated_at'>): Promise<void> {
  await ensureQueueTable()
  await query(
    `INSERT INTO worker_queue (id, priority, data, timestamp, retry_count, max_retries, status)
     VALUES ($1,$2,$3,$4,$5,$6,'queued')
     ON CONFLICT (id) DO NOTHING`,
    [row.id, row.priority, JSON.stringify(row.data), row.timestamp, row.retry_count, row.max_retries]
  )
}

/**
 * Reclaim `processing` rows abandoned by a worker that died mid-batch.
 *
 * Split out from hydration because it is a write, and claiming is done by a
 * separate statement. 2 minutes is the threshold the original combined function
 * used; it remains comfortably longer than any single item's processing time.
 */
export async function reclaimStuckQueueItems(): Promise<number> {
  await ensureQueueTable()
  const res = await query(
    `UPDATE worker_queue
        SET status='queued', updated_at=now()
      WHERE status='processing'
        AND updated_at < now() - interval '2 minutes'`,
  )
  return (res as any).rowCount || 0
}

const CLAIM_MAX_ITEMS = Math.max(
  1,
  Number(process.env.BSV_QUEUE_HYDRATE_MAX_ITEMS || 10000),
)

/**
 * Atomically claim a batch of pending queue items for this worker.
 *
 * ## Why this claims rather than reads
 *
 * Hydration used to read rows and leave their status untouched
 * (`WHERE status IN ('queued','processing')`), so every worker process that
 * started loaded the same rows into its own memory. With more than one worker
 * the same item could therefore be processed twice, and the only thing standing
 * between that and a duplicate broadcast was the on-chain dedup check
 * downstream. A queue that claims its work removes the duplicate at source.
 *
 * ## Why the predicate is a single status
 *
 * A btree on `(status, timestamp)` cannot satisfy `status IN (...)` with
 * `ORDER BY timestamp`. One index scan returns rows grouped by status rather
 * than in global timestamp order, and the planner does not synthesise a
 * MergeAppend over the ScalarArrayOp. Measured on production:
 *
 *   WHERE status = 'queued'                    -> Index Scan, cost 0.43..361.67
 *   WHERE status IN ('queued','processing')    -> Parallel Seq Scan + Sort,
 *                                                 cost 411,162.78 for LIMIT 200
 *
 * The `IN` form scanned the whole heap to return the first page, and a
 * 10,000-row hydration never completed (cancelled at 150 s; a live worker was
 * observed sitting in it for 121 s), which left the in-memory queues empty and
 * stopped all processing. Claiming only ever takes `queued` rows, so every
 * statement is a plain index scan in timestamp order that stops after LIMIT.
 *
 * ## Atomicity
 *
 * `FOR UPDATE SKIP LOCKED` locks the chosen rows for the remainder of the
 * statement and skips any row another worker is already claiming, so two
 * workers cannot receive the same item. The claim and the move to `processing`
 * happen in one statement. A worker that dies mid-batch leaves rows in
 * `processing`, which {@link reclaimStuckQueueItems} returns to `queued` after
 * two minutes.
 *
 * `(timestamp, id)` is a strict total order, so the oldest-first selection is
 * deterministic and does not depend on physical row order.
 */
const CLAIM_SQL = `
  WITH claimed AS (
    SELECT id
      FROM worker_queue
     WHERE status = 'queued'
     ORDER BY timestamp ASC, id ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE worker_queue AS u
     SET status = 'processing', updated_at = now()
    FROM claimed AS c
   WHERE u.id = c.id
  RETURNING u.id, u.priority, u.data, u.timestamp, u.retry_count, u.max_retries,
            u.status, u.last_error,
            to_char(u.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
`

export async function claimPendingQueueItems(limit: number = CLAIM_MAX_ITEMS): Promise<QueueRow[]> {
  await ensureQueueTable()
  const claimSize = Math.min(CLAIM_MAX_ITEMS, Math.max(1, Math.floor(limit)))
  const res = await query<QueueRow>(CLAIM_SQL, [claimSize])
  return (((res as any).rows || []) as QueueRow[])
}

export async function markQueueItemProcessing(id: string): Promise<void> {
  await query(`UPDATE worker_queue SET status='processing', updated_at=now() WHERE id=$1`, [id])
}

/**
 * Batch claim: move a set of items to `processing`, and report which ones this
 * caller actually took.
 *
 * `processQueue()` transitions an entire batch in a single loop, so issuing one
 * UPDATE per item turned one logical operation into up to `batchSize` separate
 * statements every `processingIntervalMs`. Measured in production, the per-item
 * form had accumulated 48,997,412 calls at a 4.2 ms mean. Doing the same work
 * set-based collapses it to one round trip — and one index-maintenance pass —
 * per batch.
 *
 * The `status = 'queued'` predicate is what makes this a claim rather than a
 * label change. If two workers collected the same reading, both will try to
 * claim it; the first commits, and the second's UPDATE re-evaluates once the row
 * lock is released, finds the status no longer 'queued', and returns no id for
 * it. Only ids returned here may be broadcast, so a reading cannot be sent twice
 * on the addToQueue path. Rows hydrated by claimPendingQueueItems are already
 * 'processing' and are not passed to this function.
 */
export async function markQueueItemsProcessing(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  await ensureQueueTable()
  const res = await query(
    `UPDATE worker_queue
        SET status='processing', updated_at=now()
      WHERE id = ANY($1::text[])
        AND status = 'queued'
     RETURNING id`,
    [ids]
  )
  return (((res as any).rows || []) as Array<{ id: string }>).map((r) => r.id)
}

export async function markQueueItemCompleted(id: string): Promise<void> {
  // Completed items are transient; remove them immediately to avoid DB bloat
  await query(`DELETE FROM worker_queue WHERE id=$1`, [id])
}

export async function markQueueItemFailed(id: string, error: string): Promise<void> {
  await query(`UPDATE worker_queue SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`, [id, error])
}

export async function requeueQueueItem(id: string, nextRetryCount: number, whenMsFromNow: number): Promise<void> {
  // Update retry_count and set back to queued; timestamp used as priority/age
  const nextTs = Date.now() + Math.max(0, whenMsFromNow)
  await query(
    `UPDATE worker_queue
     SET status='queued', retry_count=$2, timestamp=$3, updated_at=now()
     WHERE id=$1`,
    [id, nextRetryCount, nextTs]
  )
}

const CLEANUP_BATCH_SIZE = Math.max(
  100,
  Number(process.env.BSV_QUEUE_CLEANUP_BATCH_SIZE || 5000),
)
const CLEANUP_MAX_BATCHES = Math.max(
  1,
  Number(process.env.BSV_QUEUE_CLEANUP_MAX_BATCHES || 40),
)

/**
 * Delete failed items older than the retention window (default 24 hours).
 *
 * Two problems with the previous single-statement form:
 *
 *  1. It interpolated `hoursToRetain` into the SQL string rather than binding
 *     it — a parameter that is currently a constant, but an injection seam
 *     nonetheless.
 *  2. It issued one unbounded DELETE. Because nothing indexed
 *     `(status, updated_at)`, the planner fell back to a full scan, and the
 *     statement deleted 11,843,012 rows across 1,730 calls at a 23,578 ms mean
 *     (max 117 s) — long enough to be cancelled by the server-side timeout and
 *     to hold a pool connection for the duration.
 *
 * This version ages rows on `timestamp` (epoch ms) instead of `updated_at`, so
 * the predicate is served by the `worker_queue(status, timestamp)` index, and it
 * deletes in bounded batches so no single statement can run long enough to be
 * cancelled. `timestamp` is an acceptable age proxy here: `requeueQueueItem`
 * rewrites it on every retry, so for a terminal `failed` row it is at most one
 * backoff interval *older* than the failure itself. That makes a row eligible
 * marginally earlier than a strict 24-hours-since-failure rule would — an
 * immaterial difference against a 24-hour retention window, and well above the
 * 2-minute stuck-processing threshold.
 */
export async function cleanupOldFailedItems(hoursToRetain: number = 24): Promise<number> {
  const retainHours = Math.max(1, Math.floor(Number(hoursToRetain) || 24))
  const cutoffMs = Date.now() - retainHours * 3_600_000
  let deleted = 0

  for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch++) {
    const res = await query(
      `WITH doomed AS (
         SELECT id
           FROM worker_queue
          WHERE status = 'failed'
            AND timestamp < $1
          LIMIT $2
       )
       DELETE FROM worker_queue AS u
         USING doomed AS d
        WHERE u.id = d.id
        RETURNING u.id`,
      [cutoffMs, CLEANUP_BATCH_SIZE],
    )
    const removed = ((res as any).rows || []).length || 0
    deleted += removed
    // Fewer rows than the batch size means the eligible set is exhausted.
    if (removed < CLEANUP_BATCH_SIZE) break
  }

  return deleted
}
