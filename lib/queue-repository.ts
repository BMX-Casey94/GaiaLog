import { query } from '@/lib/db'

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

export async function ensureQueueTable(): Promise<void> {
  await query(`
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
  `)
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

export async function loadPendingQueueItems(limit: number = 5000): Promise<QueueRow[]> {
  await ensureQueueTable()
  // Reclaim stuck 'processing' older than 2 minutes
  await query(`UPDATE worker_queue SET status='queued', updated_at=now() WHERE status='processing' AND updated_at < now() - interval '2 minutes'`)
  const res = await query<QueueRow>(
    `SELECT id, priority, data, timestamp, retry_count, max_retries, status, last_error, to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at
     FROM worker_queue
     WHERE status IN ('queued','processing')
     ORDER BY timestamp ASC
     LIMIT $1`,
    [limit]
  )
  return (res as any).rows || []
}

export async function markQueueItemProcessing(id: string): Promise<void> {
  await query(`UPDATE worker_queue SET status='processing', updated_at=now() WHERE id=$1`, [id])
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

// Delete failed items older than the provided retention window (default 24 hours)
export async function cleanupOldFailedItems(hoursToRetain: number = 24): Promise<number> {
  const res = await query(
    `DELETE FROM worker_queue
     WHERE status='failed'
       AND updated_at < now() - interval '${hoursToRetain} hours'
     RETURNING id`
  )
  return ((res as any).rows || []).length || 0
}





