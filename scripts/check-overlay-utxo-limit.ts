#!/usr/bin/env npx tsx
/**
 * Check the resolved BSV_OVERLAY_UTXO_LIST_LIMIT value.
 * Run from project root: npx tsx scripts/check-overlay-utxo-limit.ts
 */
import 'dotenv/config'

const raw = process.env.BSV_OVERLAY_UTXO_LIST_LIMIT
const resolved = Math.max(1, Number(raw || 10000))

console.log('BSV_OVERLAY_UTXO_LIST_LIMIT:')
console.log('  .env value:     ', raw ?? '(not set)')
console.log('  resolved value: ', resolved)
console.log('  overlay max:    10000 (schema in lib/overlay-service.ts)')
if (resolved > 10000) {
  console.log('\n⚠️  Resolved value exceeds overlay max. Set BSV_OVERLAY_UTXO_LIST_LIMIT=10000 or lower.')
}
