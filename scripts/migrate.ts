#!/usr/bin/env tsx
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import { dbPool } from '@/lib/db'

async function run() {
  const migrationsDir = path.resolve(process.cwd(), 'db', 'migrations')
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const client = await dbPool.connect()
  try {
    await client.query('BEGIN')
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
      await client.query(sql)
      await client.query('INSERT INTO _migrations(filename) VALUES($1)', [file])
    }
    await client.query('COMMIT')
    console.log('Migrations completed')
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('Migration failed:', e)
    process.exitCode = 1
  } finally {
    client.release()
    await dbPool.end()
  }
}

run()


