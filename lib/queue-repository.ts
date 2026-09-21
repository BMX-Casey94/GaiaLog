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
 * Split out from hydration because it is a write, and hydration now runs as
 * many small reads. 2 minutes is the threshold the original combined function
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

const HYDRATE_MAX_ITEMS = Math.max(
  1,
  Number(process.env.BSV_QUEUE_HYDRATE_MAX_ITEMS || 10000),
)
const HYDRATE_PAGE_SIZE = Math.min(
  1000,
  Math.max(
    1,
    Number(process.env.BSV_QUEUE_HYDRATE_PAGE_SIZE || 200),
  ),
)

/**
 * One page of pending items, oldest-first, using keyset pagination.
 *
 * ## Why this is written as two UNION ALL branches
 *
 * The previous single-statement form was:
 *
 *   WHERE status IN ('queued','processing') ORDER BY timestamp ASC LIMIT $1
 *
 * A btree on `(status, timestamp)` cannot satisfy that ordering. A single index
 * scan returns rows grouped by status — all `processing` then all `queued` (or
 * the reverse) — so the result is not globally timestamp-ordered, and
 * PostgreSQL will not synthesise a MergeAppend over the ScalarArrayOp. With
 * `worker_queue(status)` alone, or with 91% of the table matching the `IN`
 * list, the planner instead chose a **parallel sequential scan plus a full
 * sort**. Measured on production:
 *
 *   status = 'queued'                          -> Index Scan, cost 0.43..361.67
 *   status = ANY('{queued,processing}')        -> Parallel Seq Scan + Sort,
 *                                                 cost 411,162.78 for LIMIT 200
 *
 * The `IN` form therefore scanned the whole 2.6 GB heap to return the first 200
 * rows, and a 10,000-row hydration did not complete at all (confirmed:
 * `EXPLAIN ANALYZE` cancelled at 150 s, and a live worker sat in the statement
 * for 121 s). Splitting the predicate into one branch per status lets each
 * branch use the index in timestamp order and stop after `LIMIT`, and the outer
 * sort then operates on at most 2 x LIMIT rows rather than millions.
 *
 * ## Keyset correctness
 *
 * The tuple comparison `(timestamp, id) > (lastTimestamp, lastId)` is a strict
 * total order, so no row is returned twice and none is skipped — including
 * across rows that share a millisecond timestamp, which is common at this
 * write volume. Ordering the outer query by `(timestamp, id)` matches that
 * comparison. A first page is expressed as `timestamp >= 0, id > ''` rather
 * than NULLs, so the predicate needs no special case.
 */
const PENDING_PAGE_SQL = `
  SELECT page.id,
         page.priority,
         page.data,
         page.timestamp,
         page.retry_count,
         page.max_retries,
         page.status,
         page.last_error,
         to_char(page.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM (
      (SELECT id, priority, data, timestamp, retry_count, max_retries, status, last_error, updated_at
         FROM worker_queue
        WHERE status = 'queued'
          AND timestamp >= $1::bigint
          AND (timestamp > $1::bigint OR id > $2::text)
        ORDER BY timestamp ASC
        LIMIT $3::int)
      UNION ALL
      (SELECT id, priority, data, timestamp, retry_count, max_retries, status, last_error, updated_at
         FROM worker_queue
        WHERE status = 'processing'
          AND timestamp >= $1::bigint
          AND (timestamp > $1::bigint OR id > $2::text)
        ORDER BY timestamp ASC
        LIMIT $3::int)
    ) AS page
   ORDER BY page.timestamp ASC, page.id ASC
   LIMIT $3::int
`

export interface PendingHydrationOptions {
  /** Hard cap on rows yielded across all pages. Default 10000. */
  maxItems?: number
  /** Rows per page. Default 200, clamped to 1..1000. */
  pageSize?: number
}

/**
 * Yield pending queue items oldest-first in bounded pages.
 *
 * Yielding page-by-page lets the caller populate its in-memory queues as rows
 * arrive, so a large catch-up does not have to materialise a single huge result
 * set. Every page is a bounded, index-ordered query, so no single statement can
 * run long enough to hit the server-side timeout - the failure mode that left
 * the in-memory queue empty and stopped all processing.
 *
 * Retains the previous behaviour of hydrating both `queued` and `processing`
 * rows: a `processing` row belongs to a worker that may have died, and
 * `reclaimStuckQueueItems` is what returns it to `queued`.
 */
export async function* iteratePendingQueueItems(
  options: PendingHydrationOptions = {},
): AsyncGenerator<QueueRow[], void, void> {
  await ensureQueueTable()
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? HYDRATE_MAX_ITEMS))
  const pageSize = Math.min(
    1000,
    Math.max(1, Math.floor(options.pageSize ?? HYDRATE_PAGE_SIZE)),
  )

  let loaded = 0
  let lastTimestamp = 0
  let lastId = ''

  while (loaded < maxItems) {
    const take = Math.min(pageSize, maxItems - loaded)
    const res = await query<QueueRow>(PENDING_PAGE_SQL, [lastTimestamp, lastId, take])
    const rows = (((res as any).rows || []) as QueueRow[])
    if (rows.length === 0) return

    yield rows
    loaded += rows.length

    const tail = rows[rows.length - 1]
    lastTimestamp = Number(tail.timestamp)
    lastId = tail.id

    // A short page means the eligible set is exhausted.
    if (rows.length < take) return
  }
}

export async function markQueueItemProcessing(id: string): Promise<void> {
  await query(`UPDATE worker_queue SET status='processing', updated_at=now() WHERE id=$1`, [id])
}

/**
 * Batch variant of {@link markQueueItemProcessing}.
 *
 * `processQueue()` transitions an entire batch in a single loop, so issuing one
 * UPDATE per item turned one logical operation into up to `batchSize` separate
 * statements every `processingIntervalMs`. Measured in production, the per-item
 * form had accumulated 48,997,412 calls at a 4.2 ms mean. Doing the same work
 * set-based collapses it to one round trip — and one index-maintenance pass —
 * per batch.
 */
export async function markQueueItemsProcessing(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await ensureQueueTable()
  await query(
    `UPDATE worker_queue SET status='processing', updated_at=now() WHERE id = ANY($1::text[])`,
    [ids]
  )
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





