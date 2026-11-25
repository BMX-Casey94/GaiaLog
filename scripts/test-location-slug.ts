/**
 * Round-trip tests for the location slug codec.
 *
 * Run with: npx tsx scripts/test-location-slug.ts
 *
 * These are the values that actually exist in production, taken from
 * `/api/explorer/locations`, plus the pathological cases that would collide
 * under a naive `lower().replace(/\s+/g, '-')` scheme.
 */
import { locationToSlug, slugToLocation, slugRoundTrips } from '../lib/location-slug'

const REAL_VALUES = [
  'london',
  'new london',
  'longview',
  'barcelona',
  'lonf1',
  'wlon7',
  'longford',
  'kent, south london and east sussex',
  'west wyalong',
  'parit sulong',
  'colonia plan de ayala',
  'longquan',
]

const PATHOLOGICAL = [
  'wilkes-barre',
  'wilkes barre',
  'a  b',
  'a-b',
  'a--b',
  'a~b',
  'a/b',
  'a?b',
  'a#b',
  'a%b',
  'a&b=c',
  'café',
  '北京',
  'location (test)',
  "o'brien",
  'tilde~hex',
  'trailing-',
  '-leading',
  '123',
  '-',
  ' ',
]

let failures = 0

function check(value: string) {
  const slug = locationToSlug(value)
  const back = slugToLocation(slug)

  if (back !== value) {
    console.error(`FAIL round-trip: ${JSON.stringify(value)} -> ${JSON.stringify(slug)} -> ${JSON.stringify(back)}`)
    failures++
  }
  if (slug.includes('/')) {
    console.error(`FAIL contains slash: ${JSON.stringify(value)} -> ${JSON.stringify(slug)}`)
    failures++
  }
  if (!/^[A-Za-z0-9\-~]*$/.test(slug)) {
    console.error(`FAIL unsafe chars: ${JSON.stringify(value)} -> ${JSON.stringify(slug)}`)
    failures++
  }
}

for (const value of [...REAL_VALUES, ...PATHOLOGICAL]) check(value)

// Distinctness: the whole point of the encoding is that different locations
// cannot share a URL.
const all = [...REAL_VALUES, ...PATHOLOGICAL]
const seen = new Map<string, string>()
for (const value of all) {
  const slug = locationToSlug(value)
  const previous = seen.get(slug)
  if (previous !== undefined && previous !== value) {
    console.error(`FAIL collision: ${JSON.stringify(previous)} and ${JSON.stringify(value)} both -> ${JSON.stringify(slug)}`)
    failures++
  }
  seen.set(slug, value)
}

// The hyphen/space distinction must hold specifically.
if (locationToSlug('wilkes-barre') === locationToSlug('wilkes barre')) {
  console.error('FAIL: hyphen and space collide')
  failures++
}

// Malformed slugs must be rejected rather than guessed.
// Note: `~ffffffff` is NOT malformed — it is the escape `~ffff` followed by the
// literal text `ffff`, which the decoder handles correctly. It will simply match
// no location and 404 at the lookup.
for (const bad of ['~', '~zz', '~12', 'UPPER', 'has space', 'a.b', '~00g0']) {
  const result = slugToLocation(bad)
  if (result !== null) {
    console.error(`FAIL: expected null for malformed "${bad}", got ${JSON.stringify(result)}`)
    failures++
  }
}

// A valid escape must still decode, so rejection above is not simply blanket.
if (slugToLocation('a~002db') !== 'a-b') {
  console.error('FAIL: fixed-width escape did not decode')
  failures++
}

if (!slugRoundTrips('kent, south london and east sussex')) {
  console.error('FAIL: slugRoundTrips returned false for a real location')
  failures++
}

console.log(
  failures === 0
    ? `PASS — ${all.length} values round-tripped, all distinct, all path-safe`
    : `${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
