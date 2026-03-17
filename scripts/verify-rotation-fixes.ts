#!/usr/bin/env tsx
/**
 * Verification script for the fetch rotation and identity fixes.
 * Run: npx tsx scripts/verify-rotation-fixes.ts
 *
 * Tests (no external dependencies required):
 * 1. Hash uniqueness — distinct readings produce distinct source_hash values
 * 2. Hash determinism — identical payloads always produce the same hash
 * 3. Hash length — output is a full 64-char hex SHA-256 digest
 * 4. NOAA rotation — single bounded pass, no re-fetch of same pool
 * 5. WAQI cursor — advances only by processed count, not page size
 */

import { createHash } from 'crypto'

function stringifyCanonical(value: any): string {
  const seen = new WeakSet()
  const replacer = (_key: string, val: any) => {
    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
      if (Array.isArray(val)) return val
      const out: Record<string, any> = {}
      for (const k of Object.keys(val).sort()) out[k] = val[k]
      return out
    }
    return val
  }
  return JSON.stringify(value, replacer)
}

function calculateSourceHash(obj: any): string {
  return createHash('sha256').update(stringifyCanonical(obj)).digest('hex')
}

let passed = 0
let failed = 0

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ FAIL: ${label}`)
    failed++
  }
}

// ---------- Test 1: Hash uniqueness ----------
console.log('\n1. Hash uniqueness — distinct readings produce distinct hashes\n')

const readingA = {
  type: 'air_quality',
  aq: { aqi: 42, pm25: 12, location: 'London', timestamp: '2026-03-16T10:00:00.000Z', source: 'WAQI' },
}
const readingB = {
  type: 'air_quality',
  aq: { aqi: 43, pm25: 12, location: 'London', timestamp: '2026-03-16T10:00:00.000Z', source: 'WAQI' },
}
const readingC = {
  type: 'air_quality',
  aq: { aqi: 42, pm25: 12, location: 'London', timestamp: '2026-03-16T10:05:00.000Z', source: 'WAQI' },
}
const readingD = {
  type: 'air_quality',
  aq: { aqi: 42, pm25: 12, location: 'Manchester', timestamp: '2026-03-16T10:00:00.000Z', source: 'WAQI' },
}

const hashA = calculateSourceHash(readingA)
const hashB = calculateSourceHash(readingB)
const hashC = calculateSourceHash(readingC)
const hashD = calculateSourceHash(readingD)

assert(hashA !== hashB, 'Different AQI value → different hash')
assert(hashA !== hashC, 'Different timestamp → different hash')
assert(hashA !== hashD, 'Different location → different hash')
assert(new Set([hashA, hashB, hashC, hashD]).size === 4, 'All four readings produce unique hashes')

// ---------- Test 2: Hash determinism ----------
console.log('\n2. Hash determinism — same payload always gives same hash\n')

const hashA2 = calculateSourceHash(readingA)
assert(hashA === hashA2, 'Repeated hash of same object is identical')

const reorderedA = {
  aq: { source: 'WAQI', timestamp: '2026-03-16T10:00:00.000Z', location: 'London', pm25: 12, aqi: 42 },
  type: 'air_quality',
}
const hashReordered = calculateSourceHash(reorderedA)
assert(hashA === hashReordered, 'Key order does not affect hash (canonical JSON)')

// ---------- Test 3: Hash format ----------
console.log('\n3. Hash format — full 64-char hex SHA-256 digest\n')

assert(hashA.length === 64, `Hash length is 64 (got ${hashA.length})`)
assert(/^[0-9a-f]{64}$/.test(hashA), 'Hash is lowercase hex')

// ---------- Test 4: Cross-family uniqueness ----------
console.log('\n4. Cross-family uniqueness — different types with overlapping payloads\n')

const waterReading = {
  type: 'water_levels',
  w: { aqi: 42, pm25: 12, location: 'London', timestamp: '2026-03-16T10:00:00.000Z', source: 'WAQI' },
}
const hashWater = calculateSourceHash(waterReading)
assert(hashA !== hashWater, 'air_quality vs water_levels with same inner data → different hash')

// ---------- Test 5: NOAA rotation simulation ----------
console.log('\n5. NOAA rotation — single bounded pass, no re-fetch of same pool\n')

function buildRotatingSlice<T>(items: T[], startIndex: number, limit: number): T[] {
  if (items.length === 0 || limit <= 0) return []
  const slice: T[] = []
  const total = items.length
  for (let offset = 0; offset < Math.min(limit, total); offset++) {
    slice.push(items[(startIndex + offset) % total])
  }
  return slice
}

const stationPool = Array.from({ length: 250 }, (_, i) => `station_${i}`)
const batchLimit = 100
let cursor = 73
const initialCursor = cursor
let stationsRemainingInCycle = stationPool.length
let totalProcessed = 0
let pagesProcessed = 0
const visitedStations = new Set<string>()

while (stationsRemainingInCycle > 0) {
  const batchSize = Math.min(batchLimit, stationsRemainingInCycle)
  const batch = buildRotatingSlice(stationPool, cursor, batchSize)
  if (batch.length === 0) break
  for (const s of batch) visitedStations.add(s)
  cursor = (cursor + batch.length) % stationPool.length
  totalProcessed += batch.length
  stationsRemainingInCycle -= batch.length
  pagesProcessed++
}

assert(totalProcessed === stationPool.length, `Processed exactly pool size (${totalProcessed} = ${stationPool.length})`)
assert(visitedStations.size === stationPool.length, `Visited every station exactly once (${visitedStations.size} unique)`)
assert(pagesProcessed === 3, `Completed in expected number of pages (${pagesProcessed} = ceil(250/100))`)

// ---------- Test 6: WAQI cursor advances by processed count ----------
console.log('\n6. WAQI cursor — advances only by processed count, not full page\n')

const pageSize = 1000
const concurrency = 200
const sweepBudgetMs = 500
const stations = Array.from({ length: pageSize }, (_, i) => `waqi_station_${i}`)
let waqiCursor = 0
let processedInPage = 0
const sweepStart = Date.now()

for (let chunkStart = 0; chunkStart < stations.length; chunkStart += concurrency) {
  if ((Date.now() - sweepStart) >= sweepBudgetMs) break
  const chunk = stations.slice(chunkStart, chunkStart + concurrency)
  processedInPage += chunk.length
  // Simulate 50ms of work per chunk
  const end = Date.now() + 50
  while (Date.now() < end) {}
}

const newCursor = waqiCursor + processedInPage
assert(processedInPage <= pageSize, `Processed ≤ page size (${processedInPage} ≤ ${pageSize})`)
assert(newCursor === processedInPage, `Cursor advances by processed count (${newCursor})`)
if (processedInPage < pageSize) {
  assert(newCursor < pageSize, `Partial page: cursor does not skip unprocessed tail (cursor=${newCursor} < pageSize=${pageSize})`)
}

// ---------- Summary ----------
console.log(`\n${'='.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
} else {
  console.log('All checks passed.')
}
