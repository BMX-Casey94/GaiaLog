#!/usr/bin/env npx tsx
/**
 * GaiaLog Geocode Backfill
 *
 * Scans overlay_explorer_readings for rows that have lat/lon but only a
 * coordinate-based or generic location string.  For each, it reverse-geocodes
 * the coordinates and updates both the reading row and the location_keys
 * rollup table.
 *
 * The script is idempotent and resumable — it tracks progress via a cursor
 * and skips already-geocoded rows.
 *
 * Usage:
 *   npx tsx scripts/backfill-geocode.ts
 *   npx tsx scripts/backfill-geocode.ts --dry-run
 *   npx tsx scripts/backfill-geocode.ts --limit 500
 *   npx tsx scripts/backfill-geocode.ts --batch-size 20
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.join(process.cwd(), '.env.local') })
dotenv.config({ path: path.join(process.cwd(), '.env') })

import { query } from '../lib/db'
import { reverseGeocode, buildDisplayLocation, locationNeedsGeocoding } from '../lib/reverse-geocoder'

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const LIMIT = (() => {
  const idx = args.indexOf('--limit')
  return idx >= 0 ? Math.max(1, parseInt(args[idx + 1] || '0', 10) || Infinity) : Infinity
})()
const BATCH_SIZE = (() => {
  const idx = args.indexOf('--batch-size')
  return idx >= 0 ? Math.max(1, Math.min(100, parseInt(args[idx + 1] || '50', 10))) : 50
})()

// ─── State ───────────────────────────────────────────────────────────────────

let totalScanned = 0
let totalUpdated = 0
let totalSkipped = 0
let totalErrors = 0

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log()
  console.log('============================================================')
  console.log('  GaiaLog Geocode Backfill')
  console.log('============================================================')
  console.log()
  console.log(`   Mode:        ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`)
  console.log(`   Limit:       ${LIMIT === Infinity ? 'unlimited' : LIMIT}`)
  console.log(`   Batch size:  ${BATCH_SIZE}`)
  console.log()

  let lastTxid: string | null = null

  while (totalUpdated < LIMIT) {
    const remaining = LIMIT - totalUpdated
    const fetchSize = Math.min(BATCH_SIZE, remaining === Infinity ? BATCH_SIZE : remaining)

    const cursorFilter = lastTxid
      ? `AND txid > $2`
      : ''

    const result = await query<{
      txid: string
      location: string | null
      lat: number
      lon: number
    }>(
      `SELECT txid, location, lat, lon
       FROM overlay_explorer_readings
       WHERE lat IS NOT NULL AND lon IS NOT NULL
         ${cursorFilter}
       ORDER BY txid ASC
       LIMIT $1`,
      lastTxid ? [fetchSize, lastTxid] : [fetchSize],
    )

    const rows = result.rows || []
    if (rows.length === 0) break

    for (const row of rows) {
      totalScanned++
      lastTxid = row.txid

      if (!locationNeedsGeocoding(row.location)) {
        totalSkipped++
        continue
      }

      if (totalUpdated >= LIMIT) break

      try {
        const place = await reverseGeocode(row.lat, row.lon)
        if (!place) {
          totalSkipped++
          continue
        }

        const displayLocation = buildDisplayLocation(place)
        if (!displayLocation) {
          totalSkipped++
          continue
        }

        if (DRY_RUN) {
          console.log(`   [DRY] ${row.txid.slice(0, 12)}... (${row.lat}, ${row.lon}) → ${displayLocation}`)
        } else {
          await query(
            `UPDATE overlay_explorer_readings
             SET location = $2, normalized_location = $3
             WHERE txid = $1`,
            [row.txid, displayLocation, displayLocation.toLowerCase()],
          )

          // Update the location_keys rollup (delete old coordinate-based key, trigger will recreate)
          // Simpler: just update display_location and normalized_location for matching entries
          if (row.location) {
            const oldNormalized = row.location.trim().toLowerCase()
            await query(
              `UPDATE overlay_explorer_location_keys
               SET display_location = $2, normalized_location = $3
               WHERE normalized_location = $1`,
              [oldNormalized, displayLocation, displayLocation.toLowerCase()],
            ).catch(() => {})
          }
        }

        totalUpdated++

        if (totalUpdated % 25 === 0) {
          process.stdout.write(
            `\r   Scanned: ${totalScanned} | Updated: ${totalUpdated} | Skipped: ${totalSkipped} | Errors: ${totalErrors}       `,
          )
        }
      } catch (err) {
        totalErrors++
        console.warn(`\n   Error for ${row.txid.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`)
      }
    }

    if (rows.length < fetchSize) break
  }

  console.log()
  console.log()
  console.log('============================================================')
  console.log('  Backfill Summary')
  console.log('============================================================')
  console.log(`   Rows scanned:    ${totalScanned}`)
  console.log(`   Rows updated:    ${totalUpdated}`)
  console.log(`   Rows skipped:    ${totalSkipped} (already have proper names)`)
  console.log(`   Errors:          ${totalErrors}`)
  console.log()
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
