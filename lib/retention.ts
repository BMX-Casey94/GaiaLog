/**
 * Explorer & TX-log retention.
 *
 * Keeps Supabase storage and egress bounded by pruning rows that are no
 * longer required for the home-page widgets, while preserving:
 *
 *   1. The latest reading per (data_family, normalized_location) pair, so the
 *      explorer locations map and the per-location autocomplete remain
 *      populated regardless of age.
 *   2. High-severity rows (large seismic events, all volcanic / flood /
 *      natural-event / planning-development entries) which the priority
 *      alerts feed needs and which represent the highest-value records.
 *   3. The chain itself.  Deleting a Supabase row never removes anything
 *      from BSV — explorer-sync can always backfill from WhatsonChain.
 *
 * Everything is configurable via `RETENTION_DAYS_<FAMILY>` env vars and
 * the global `RETENTION_DRY_RUN`, `RETENTION_BATCH_SIZE`,
 * `RETENTION_MAX_DELETES_PER_FAMILY` knobs documented at the bottom.
 */

import { query } from './db'
import { DATA_FAMILY_DESCRIPTORS } from './stream-registry'

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_RETENTION_DAYS_BY_FAMILY: Record<string, number> = {
  air_quality: 7,
  water_levels: 7,
  advanced_metrics: 7,
  hydrology: 14,
  seismic_activity: 30,
  space_weather: 14,
  geomagnetism: 14,
  upper_atmosphere: 14,
  volcanic_activity: 90,
  flood_risk: 90,
  natural_events: 365,
  biodiversity: 180,
  conservation_status: 365,
  land_use_change: 365,
  mining_activity: 365,
  transport_tracking: 7,
  planning_development: 365,
  unknown: 7,
}

const DEFAULT_TX_LOG_RETENTION_DAYS = 30
const DEFAULT_BATCH_SIZE = 5_000
const DEFAULT_MAX_DELETES_PER_FAMILY = 250_000
const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000
// Physically delete spent (removed=true) UTXO rows older than this window.
// Compaction earlier in the run nulls out their raw_tx/beef blobs, but the
// row tuples themselves remain and bloat the heap until VACUUM, eventually
// causing seq scans + statement timeouts on the acquire query (we hit a
// 5.4 GB heap with 2 M dead rows protecting just 194 k live ones in
// 2026-04). A short retention window (default 3 days) keeps the table
// compact while preserving recent rows for any forensic lookups.
const DEFAULT_UTXO_PRUNE_DAYS = 3
const DEFAULT_MAX_UTXO_PRUNES_PER_RUN = 500_000

// ─── Configuration helpers ───────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null) return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

function getRetentionDaysForFamily(family: string): number {
  const envName = `RETENTION_DAYS_${family.toUpperCase()}`
  return envInt(envName, DEFAULT_RETENTION_DAYS_BY_FAMILY[family] ?? 30)
}

// ─── Preservation predicate (mirrors getPriorityAlerts in repository) ───────

/**
 * SQL fragment that evaluates true for rows that must NEVER be deleted by
 * the retention pass.  Kept in sync with overlay-explorer-repository's
 * getPriorityAlerts so anything the priority feed surfaces is retained.
 */
const PRESERVE_HIGH_SEVERITY_SQL = `
  (
    (data_family = 'seismic_activity'    AND COALESCE((metrics_preview->>'magnitude')::float, 0) >= 5)
    OR (data_family = 'volcanic_activity')
    OR (data_family = 'flood_risk')
    OR (data_family = 'natural_events')
    OR (data_family = 'planning_development' AND COALESCE((metrics_preview->>'status')::text, '') ILIKE '%approved%')
  )
`

// ─── Plan / dry-run ──────────────────────────────────────────────────────────

export interface RetentionFamilyPlan {
  family: string
  retentionDays: number
  cutoffIso: string
  totalRows: number
  eligibleForDeletion: number
  preservedHighSeverity: number
  preservedLatestPerLocation: number
}

export interface RetentionPlan {
  generatedAt: string
  families: RetentionFamilyPlan[]
  txLog: {
    retentionDays: number
    cutoffIso: string
    eligibleForDeletion: number
  }
  utxoCompaction: {
    removedRowsWithBlobs: number
  }
  utxoPrune: {
    retentionDays: number
    cutoffIso: string
    eligibleForDeletion: number
  }
}

export async function planRetention(): Promise<RetentionPlan> {
  const families = Object.keys(DATA_FAMILY_DESCRIPTORS) as Array<keyof typeof DATA_FAMILY_DESCRIPTORS>
  const familyPlans: RetentionFamilyPlan[] = []

  for (const family of families) {
    const retentionDays = getRetentionDaysForFamily(family)
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000)

    const result = await query<{
      total_rows: string
      eligible_for_deletion: string
      preserved_high_severity: string
      preserved_latest_per_location: string
    }>(
      `WITH per_family AS (
         SELECT txid,
                normalized_location,
                reading_ts,
                ROW_NUMBER() OVER (
                  PARTITION BY normalized_location
                  ORDER BY reading_ts DESC
                ) AS rn,
                CASE WHEN ${PRESERVE_HIGH_SEVERITY_SQL} THEN 1 ELSE 0 END AS high_sev
           FROM overlay_explorer_readings
          WHERE data_family = $1
       )
       SELECT
         COUNT(*)::text AS total_rows,
         COUNT(*) FILTER (
           WHERE reading_ts < $2
             AND high_sev = 0
             AND (rn > 1 OR normalized_location IS NULL)
         )::text AS eligible_for_deletion,
         COUNT(*) FILTER (WHERE high_sev = 1)::text AS preserved_high_severity,
         COUNT(*) FILTER (WHERE rn = 1 AND normalized_location IS NOT NULL)::text AS preserved_latest_per_location
       FROM per_family`,
      [family, cutoff],
    )

    const row = result.rows[0]
    familyPlans.push({
      family,
      retentionDays,
      cutoffIso: cutoff.toISOString(),
      totalRows: Number(row?.total_rows ?? 0),
      eligibleForDeletion: Number(row?.eligible_for_deletion ?? 0),
      preservedHighSeverity: Number(row?.preserved_high_severity ?? 0),
      preservedLatestPerLocation: Number(row?.preserved_latest_per_location ?? 0),
    })
  }

  const txLogDays = envInt('RETENTION_TX_LOG_DAYS', DEFAULT_TX_LOG_RETENTION_DAYS)
  const txLogCutoff = new Date(Date.now() - txLogDays * 86_400_000)
  const txLogResult = await query<{ eligible: string }>(
    `SELECT COUNT(*)::text AS eligible
       FROM tx_log
      WHERE status = 'confirmed'
        AND collected_at < $1`,
    [txLogCutoff],
  )

  const utxoResult = await query<{ blobs: string }>(
    `SELECT COUNT(*)::text AS blobs
       FROM overlay_admitted_utxos
      WHERE removed = true
        AND (raw_tx IS NOT NULL OR beef IS NOT NULL)`,
  )

  const utxoPruneDays = envInt('RETENTION_UTXO_PRUNE_DAYS', DEFAULT_UTXO_PRUNE_DAYS)
  const utxoPruneCutoff = new Date(Date.now() - utxoPruneDays * 86_400_000)
  const utxoPruneResult = await query<{ eligible: string }>(
    `SELECT COUNT(*)::text AS eligible
       FROM overlay_admitted_utxos
      WHERE removed = true
        AND removed_at IS NOT NULL
        AND removed_at < $1`,
    [utxoPruneCutoff],
  )

  return {
    generatedAt: new Date().toISOString(),
    families: familyPlans,
    txLog: {
      retentionDays: txLogDays,
      cutoffIso: txLogCutoff.toISOString(),
      eligibleForDeletion: Number(txLogResult.rows[0]?.eligible ?? 0),
    },
    utxoCompaction: {
      removedRowsWithBlobs: Number(utxoResult.rows[0]?.blobs ?? 0),
    },
    utxoPrune: {
      retentionDays: utxoPruneDays,
      cutoffIso: utxoPruneCutoff.toISOString(),
      eligibleForDeletion: Number(utxoPruneResult.rows[0]?.eligible ?? 0),
    },
  }
}

// ─── Execute ─────────────────────────────────────────────────────────────────

export interface RetentionFamilyResult {
  family: string
  retentionDays: number
  cutoffIso: string
  deleted: number
  batches: number
  capped: boolean
  durationMs: number
}

export interface RetentionRunResult {
  startedAt: string
  finishedAt: string
  dryRun: boolean
  families: RetentionFamilyResult[]
  txLog: {
    retentionDays: number
    deleted: number
    durationMs: number
  }
  utxoCompaction: {
    rowsCompacted: number
    durationMs: number
  }
  utxoPrune: {
    retentionDays: number
    rowsDeleted: number
    durationMs: number
    capped: boolean
  }
}

export async function runRetention(opts?: { dryRun?: boolean }): Promise<RetentionRunResult> {
  const dryRun = opts?.dryRun ?? envBool('RETENTION_DRY_RUN', false)
  const batchSize = envInt('RETENTION_BATCH_SIZE', DEFAULT_BATCH_SIZE)
  const perFamilyCap = envInt('RETENTION_MAX_DELETES_PER_FAMILY', DEFAULT_MAX_DELETES_PER_FAMILY)
  // RETENTION_STATEMENT_TIMEOUT_MS is intentionally unused at the application
  // layer: SET LOCAL requires an explicit transaction block which the pooled
  // query() helper does not expose, and SET (session-scoped) would leak across
  // pool reuse.  Statement timeouts should be enforced at the Supabase
  // database level via ALTER ROLE … SET statement_timeout, which applies
  // consistently to every connection regardless of caller.
  void DEFAULT_STATEMENT_TIMEOUT_MS

  const startedAt = new Date()
  const families = Object.keys(DATA_FAMILY_DESCRIPTORS) as Array<keyof typeof DATA_FAMILY_DESCRIPTORS>
  const familyResults: RetentionFamilyResult[] = []

  for (const family of families) {
    const retentionDays = getRetentionDaysForFamily(family)
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000)

    const t0 = Date.now()
    let deleted = 0
    let batches = 0
    let capped = false

    if (!dryRun) {
      while (deleted < perFamilyCap) {
        const remaining = perFamilyCap - deleted
        const limit = Math.min(batchSize, remaining)

        const result = await query(
          `WITH eligible AS (
             SELECT txid
               FROM overlay_explorer_readings
              WHERE data_family = $1
                AND reading_ts < $2
                AND NOT (${PRESERVE_HIGH_SEVERITY_SQL})
                AND txid NOT IN (
                  SELECT DISTINCT ON (normalized_location) txid
                    FROM overlay_explorer_readings
                   WHERE data_family = $1
                     AND normalized_location IS NOT NULL
                   ORDER BY normalized_location, reading_ts DESC
                )
              ORDER BY reading_ts ASC
              LIMIT $3
           )
           DELETE FROM overlay_explorer_readings r
             USING eligible e
            WHERE r.txid = e.txid`,
          [family, cutoff, limit],
        )

        const rowsThisBatch = result.rowCount ?? 0
        deleted += rowsThisBatch
        batches += 1
        if (rowsThisBatch < limit) break
      }
      capped = deleted >= perFamilyCap
    }

    familyResults.push({
      family,
      retentionDays,
      cutoffIso: cutoff.toISOString(),
      deleted,
      batches,
      capped,
      durationMs: Date.now() - t0,
    })
  }

  // ─ tx_log retention ────────────────────────────────────────────────────────
  const txLogDays = envInt('RETENTION_TX_LOG_DAYS', DEFAULT_TX_LOG_RETENTION_DAYS)
  const txLogCutoff = new Date(Date.now() - txLogDays * 86_400_000)
  const txLogStarted = Date.now()
  let txLogDeleted = 0

  if (!dryRun) {
    let more = true
    while (more) {
      const result = await query(
        `WITH eligible AS (
           SELECT txid
             FROM tx_log
            WHERE status = 'confirmed'
              AND collected_at < $1
            LIMIT $2
         )
         DELETE FROM tx_log t
           USING eligible e
          WHERE t.txid = e.txid`,
        [txLogCutoff, batchSize],
      )
      const rowsThisBatch = result.rowCount ?? 0
      txLogDeleted += rowsThisBatch
      more = rowsThisBatch === batchSize
    }
  }

  // ─ Spent-UTXO blob compaction ──────────────────────────────────────────────
  // Batched: an unbounded UPDATE here exceeds Supabase's per-statement
  // timeout once the spent-row backlog grows past a few hundred thousand
  // rows.  Issuing N small UPDATEs of LIMIT batchSize keeps each statement
  // well under the timeout and lets the job make incremental progress
  // across multiple runs even if a single run is interrupted.  The
  // RETENTION_MAX_UTXO_COMPACTIONS_PER_RUN cap (default 200_000 rows)
  // bounds the total work per cron pass so a daily run finishes promptly
  // even after the first big backlog has been chewed through manually
  // via scripts/sql/compact-spent-utxos.sql.
  const utxoStarted = Date.now()
  let utxoCompacted = 0
  if (!dryRun) {
    const utxoBatchCap = envInt('RETENTION_MAX_UTXO_COMPACTIONS_PER_RUN', 200_000)
    while (utxoCompacted < utxoBatchCap) {
      const remaining = utxoBatchCap - utxoCompacted
      const limit = Math.min(batchSize, remaining)

      const utxoResult = await query(
        `WITH batch AS (
           SELECT topic, txid, vout
             FROM overlay_admitted_utxos
            WHERE removed = true
              AND (raw_tx IS NOT NULL OR beef IS NOT NULL)
            LIMIT $1
         )
         UPDATE overlay_admitted_utxos u
            SET raw_tx = NULL,
                beef   = NULL
           FROM batch b
          WHERE u.topic = b.topic
            AND u.txid  = b.txid
            AND u.vout  = b.vout`,
        [limit],
      )

      const rowsThisBatch = utxoResult.rowCount ?? 0
      utxoCompacted += rowsThisBatch
      if (rowsThisBatch < limit) break
    }
  }

  // ─ Spent-UTXO physical prune ───────────────────────────────────────────────
  // After compaction has nulled the heavy blobs, physically delete spent
  // rows older than the configured window so the heap stays small. Without
  // this step PostgreSQL retains the (now-tiny) tuples indefinitely, which
  // slowly bloats the table heap, defeats the partial indexes (every scan
  // has to skip past dead rows), and eventually pushes the acquire query
  // into seq-scan territory + statement timeouts. Batched + per-run capped
  // so a single pass can never run away with the connection.
  const utxoPruneDays = envInt('RETENTION_UTXO_PRUNE_DAYS', DEFAULT_UTXO_PRUNE_DAYS)
  const utxoPruneCap = envInt('RETENTION_MAX_UTXO_PRUNES_PER_RUN', DEFAULT_MAX_UTXO_PRUNES_PER_RUN)
  const utxoPruneCutoff = new Date(Date.now() - utxoPruneDays * 86_400_000)
  const utxoPruneStarted = Date.now()
  let utxoPruned = 0
  let utxoPruneCapped = false

  if (!dryRun && utxoPruneDays > 0) {
    while (utxoPruned < utxoPruneCap) {
      const remaining = utxoPruneCap - utxoPruned
      const limit = Math.min(batchSize, remaining)

      const pruneResult = await query(
        `WITH eligible AS (
           SELECT topic, txid, vout
             FROM overlay_admitted_utxos
            WHERE removed = true
              AND removed_at IS NOT NULL
              AND removed_at < $1
            LIMIT $2
         )
         DELETE FROM overlay_admitted_utxos u
           USING eligible e
          WHERE u.topic = e.topic
            AND u.txid  = e.txid
            AND u.vout  = e.vout`,
        [utxoPruneCutoff, limit],
      )

      const rowsThisBatch = pruneResult.rowCount ?? 0
      utxoPruned += rowsThisBatch
      if (rowsThisBatch < limit) break
    }
    utxoPruneCapped = utxoPruned >= utxoPruneCap
  }

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun,
    families: familyResults,
    txLog: {
      retentionDays: txLogDays,
      deleted: txLogDeleted,
      durationMs: Date.now() - txLogStarted,
    },
    utxoCompaction: {
      rowsCompacted: utxoCompacted,
      durationMs: Date.now() - utxoStarted,
    },
    utxoPrune: {
      retentionDays: utxoPruneDays,
      rowsDeleted: utxoPruned,
      durationMs: Date.now() - utxoPruneStarted,
      capped: utxoPruneCapped,
    },
  }
}
