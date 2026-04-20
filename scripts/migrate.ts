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

/** Each file is a single CREATE INDEX CONCURRENTLY (cannot batch multiple in one transaction). */
const CONCURRENT_INDEX_MIGRATIONS = new Set([
  '0017_overlay_utxo_inventory_idx_concurrent.sql',
])

function isConcurrentIndexMigration(file: string): boolean {
  return CONCURRENT_INDEX_MIGRATIONS.has(file)
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

      if (isConcurrentIndexMigration(file)) {
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
