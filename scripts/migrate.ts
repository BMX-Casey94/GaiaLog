#!/usr/bin/env tsx
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

// Load env before db module; imports are hoisted so we must load db dynamically
dotenv.config({ path: '.env.local' })
dotenv.config()

/** Migrations that start with their own BEGIN; ... COMMIT; (after optional -- comments). */
function migrationOpensOwnTransaction(sql: string): boolean {
  for (const rawLine of sql.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('--')) continue
    return /^BEGIN\s*;/i.test(line)
  }
  return false
}

/**
 * Migrations that must run OUTSIDE a transaction block.
 *
 * Postgres rejects CREATE/DROP INDEX CONCURRENTLY inside an explicit
 * transaction with SQLSTATE 25001 ("cannot run inside a transaction block"),
 * so these files are sent on their own instead of inside BEGIN/COMMIT.
 *
 * Convention: a file listed here (or matching the content test) must contain a
 * single statement — CONCURRENTLY is the only reason to bypass the wrapper, and
 * a multi-statement file would then lose atomicity without gaining anything.
 *
 * Detection is deliberately by content as well as by name. The name list alone
 * is a trap: any new *_concurrent.sql file that is not also added here fails at
 * deploy time with 25001, which is exactly how 0031 failed.
 */
const CONCURRENT_INDEX_MIGRATIONS = new Set([
  '0017_overlay_utxo_inventory_idx_concurrent.sql',
  '0019_overlay_utxo_acquirable_at_idx_concurrent.sql',
  '0023_oer_unconfirmed_backfill_idx_concurrent.sql',
  '0025_seismic_event_id_idx_concurrent.sql',
  '0026_worker_queue_status_timestamp_idx_concurrent.sql',
  '0028_drop_oer_family_ts_idx_concurrent.sql',
  '0029_drop_overlay_topic_removed_idx_concurrent.sql',
  '0031_oer_unconfirmed_admitted_idx_concurrent.sql',
])

function isConcurrentIndexMigration(file: string, sql = ''): boolean {
  if (CONCURRENT_INDEX_MIGRATIONS.has(file)) return true
  return /\b(?:CREATE|DROP)\s+INDEX\s+CONCURRENTLY\b/i.test(sql)
}

async function run() {
  const { dbPool, attachClientErrorHandler } = await import('@/lib/db')
  const migrationsDir = path.resolve(process.cwd(), 'db', 'migrations')
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const client = await dbPool.connect()
  attachClientErrorHandler(client)
  try {
    await client.query('SET statement_timeout = 0')
    await client.query('SET lock_timeout = 0')

    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (id SERIAL PRIMARY KEY, filename TEXT UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    const applied = new Set<string>()
    const rows = await client.query('SELECT filename FROM _migrations')
    for (const r of rows.rows) applied.add(r.filename)

    for (const file of files) {
      if (applied.has(file)) continue
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      console.log(`Applying migration: ${file}`)

      if (isConcurrentIndexMigration(file, sql)) {
        await client.query(sql)
        await client.query('INSERT INTO _migrations(filename) VALUES($1)', [file])
        continue
      }

      if (migrationOpensOwnTransaction(sql)) {
        await client.query(sql)
        await client.query('INSERT INTO _migrations(filename) VALUES($1)', [file])
        continue
      }

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO _migrations(filename) VALUES($1)', [file])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      }
    }
    console.log('Migrations completed')
  } catch (e) {
    console.error('Migration failed:', e)
    process.exitCode = 1
  } finally {
    client.release()
    await dbPool.end()
  }
}

run()
