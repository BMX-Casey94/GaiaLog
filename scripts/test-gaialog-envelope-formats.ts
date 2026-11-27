/**
 * Envelope format matrix for both GaiaLog OP_RETURN decoders.
 *
 * Run with: npx tsx scripts/test-gaialog-envelope-formats.ts
 *
 * Every accepted case asserts that `lib/opreturn-validator.ts` and the
 * standalone plugin validator at `woc-plugin/gaialog-plugin/src/opreturn-validator.ts`
 * return the same document. The writer is `buildOpFalseOpReturnWithTag` from
 * `lib/opreturn.ts`; layouts the writer cannot produce are hand-built.
 */
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { buildOpFalseOpReturnWithTag } from '../lib/opreturn'
import { validateGaiaLog } from '../lib/opreturn-validator'
import { validateGaiaLog as validateGaiaLogPlugin } from '../woc-plugin/gaialog-plugin/src/opreturn-validator'

type Decoded = { spendable: boolean; gzip: boolean; hasHash: boolean; json: any }

const SAMPLE = {
	app: 'GaiaLog',
	schema_version: '1.1.0',
	data_type: 'air_quality',
	timestamp: 1735689600000,
	payload: { air_quality_index: 42, station: 'Test Station' },
}
const SAMPLE_BYTES = Buffer.from(JSON.stringify(SAMPLE), 'utf8')

const LEGACY = { app: 'GaiaLog', data_type: 'air_quality', payload: { air_quality_index: 1 } }
const LEGACY_BYTES = Buffer.from(JSON.stringify(LEGACY), 'utf8')

let failures = 0

function sha256(buf: Buffer): Buffer {
	return createHash('sha256').update(buf).digest()
}

function pushHex(data: Buffer | string): string {
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
	const len = buf.length
	if (len <= 75) return len.toString(16).padStart(2, '0') + buf.toString('hex')
	if (len <= 0xff) return '4c' + len.toString(16).padStart(2, '0') + buf.toString('hex')
	if (len <= 0xffff) {
		const le = Buffer.alloc(2)
		le.writeUInt16LE(len, 0)
		return '4d' + le.toString('hex') + buf.toString('hex')
	}
	const le4 = Buffer.alloc(4)
	le4.writeUInt32LE(len, 0)
	return '4e' + le4.toString('hex') + buf.toString('hex')
}

/** Hand-build an OP_RETURN script; prefix is '' for a plain OP_RETURN. */
function script(pushes: (Buffer | string)[], prefix: '00' | '51' | '' = '00'): string {
	return prefix + '6a' + pushes.map(pushHex).join('')
}

/** Both validators must accept the script and agree on every field. */
function agree(label: string, hex: string): { lib: Decoded; plugin: Decoded } {
	let lib: Decoded
	let plugin: Decoded
	try {
		lib = validateGaiaLog(hex)
	} catch (e: any) {
		throw new Error(`lib rejected a valid envelope: ${e?.message ?? e}`)
	}
	try {
		plugin = validateGaiaLogPlugin(hex)
	} catch (e: any) {
		throw new Error(`plugin rejected a valid envelope: ${e?.message ?? e}`)
	}
	assert.deepStrictEqual(plugin.json, lib.json, 'validators disagree on json')
	assert.strictEqual(plugin.gzip, lib.gzip, 'validators disagree on gzip')
	assert.strictEqual(plugin.hasHash, lib.hasHash, 'validators disagree on hasHash')
	assert.strictEqual(plugin.spendable, lib.spendable, 'validators disagree on spendable')
	assert.ok(
		lib.json !== null && typeof lib.json === 'object' && !Array.isArray(lib.json),
		'decoded json is not an object',
	)
	return { lib, plugin }
}

function threw(fn: () => unknown): boolean {
	try {
		fn()
		return false
	} catch {
		return true
	}
}

/** Neither validator may accept the script. */
function reject(label: string, hex: string): void {
	const libThrew = threw(() => validateGaiaLog(hex))
	const pluginThrew = threw(() => validateGaiaLogPlugin(hex))
	assert.ok(libThrew, 'lib accepted a non-GaiaLog script')
	assert.ok(pluginThrew, 'plugin accepted a non-GaiaLog script')
}

function testCase(label: string, fn: () => void): void {
	try {
		fn()
		console.log(`PASS  ${label}`)
	} catch (e: any) {
		failures++
		console.error(`FAIL  ${label}\n      ${e?.message ?? e}`)
	}
}

// 1. OP_FALSE OP_RETURN with a plain JSON payload.
testCase('1  OP_FALSE, v1, plain JSON', () => {
	const hex = buildOpFalseOpReturnWithTag({ tag: 'GaiaLog', version: 'v1', payload: SAMPLE_BYTES })
	const { lib, plugin } = agree('1', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.gzip, false)
		assert.strictEqual(r.hasHash, false)
		assert.strictEqual(r.spendable, false)
	}
})

// 2. OP_TRUE OP_RETURN prefix.
testCase('2  OP_TRUE, v1, plain JSON', () => {
	const hex = buildOpFalseOpReturnWithTag({
		tag: 'GaiaLog',
		version: 'v1',
		payload: SAMPLE_BYTES,
		useTrueReturn: true,
	})
	const { lib, plugin } = agree('2', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.spendable, true)
	}
})

// 3. Plain OP_RETURN: the same script with the leading OP_FALSE byte removed.
testCase('3  plain OP_RETURN (6a only)', () => {
	const built = buildOpFalseOpReturnWithTag({ tag: 'GaiaLog', version: 'v1', payload: SAMPLE_BYTES })
	assert.strictEqual(built.slice(0, 2), '00')
	const { lib, plugin } = agree('3', built.slice(2))
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.spendable, false)
	}
})

// 4. Gzip payload plus the explicit marker push.
testCase('4a gzip payload with encoding=gzip marker', () => {
	const gz = gzipSync(SAMPLE_BYTES)
	const hex = buildOpFalseOpReturnWithTag({
		tag: 'GaiaLog',
		version: 'v1',
		payload: gz,
		extra: ['encoding=gzip'],
	})
	const { lib, plugin } = agree('4a', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.gzip, true)
		assert.strictEqual(r.hasHash, false)
	}
})

testCase('4b gzip payload with hash then encoding=gzip marker', () => {
	const gz = gzipSync(SAMPLE_BYTES)
	const hex = buildOpFalseOpReturnWithTag({
		tag: 'GaiaLog',
		version: 'v1',
		payload: gz,
		extra: [sha256(gz), 'encoding=gzip'],
	})
	const { lib, plugin } = agree('4b', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.gzip, true)
		assert.strictEqual(r.hasHash, true)
	}
})

// 4c. Marker present, payload left as plain JSON. lib/blockchain.ts pushes
// encoding=gzip whenever gzip was requested, including when gzip itself threw.
testCase('4c encoding=gzip marker on an uncompressed payload', () => {
	const hex = buildOpFalseOpReturnWithTag({
		tag: 'GaiaLog',
		version: 'v1',
		payload: SAMPLE_BYTES,
		extra: ['encoding=gzip'],
	})
	const { lib, plugin } = agree('4c', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.gzip, false)
		assert.strictEqual(r.hasHash, false)
	}
})

// 5. Gzip payload identified by magic bytes alone.
testCase('5  gzip payload, no marker push', () => {
	const gz = gzipSync(SAMPLE_BYTES)
	const hex = buildOpFalseOpReturnWithTag({ tag: 'GaiaLog', version: 'v1', payload: gz })
	const { lib, plugin } = agree('5', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.gzip, true)
		assert.strictEqual(r.hasHash, false)
	}
})

// 6. Marker push before the hash push (swapped extras).
testCase('6  marker before hash push, swapped extras', () => {
	const gz = gzipSync(SAMPLE_BYTES)
	const hex = buildOpFalseOpReturnWithTag({
		tag: 'GaiaLog',
		version: 'v1',
		payload: gz,
		extra: ['encoding=gzip', sha256(gz)],
	})
	const { lib, plugin } = agree('6', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.gzip, true)
		assert.strictEqual(r.hasHash, true)
	}
})

// 7. Unknown trailing pushes must not break decoding.
testCase('7a unknown trailing push after gzip envelope', () => {
	const gz = gzipSync(SAMPLE_BYTES)
	const hex = buildOpFalseOpReturnWithTag({
		tag: 'GaiaLog',
		version: 'v1',
		payload: gz,
		extra: [sha256(gz), 'encoding=gzip', 'extra=1'],
	})
	const { lib, plugin } = agree('7a', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.gzip, true)
		assert.strictEqual(r.hasHash, true)
	}
})

testCase('7b unknown trailing push after plain envelope', () => {
	const hex = buildOpFalseOpReturnWithTag({
		tag: 'GaiaLog',
		version: 'v1',
		payload: SAMPLE_BYTES,
		extra: ['extra=1'],
	})
	const { lib, plugin } = agree('7b', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.gzip, false)
	}
})

// 8. Version tokens other than exactly "v1".
for (const version of ['v1.0', '1', '1.1.0']) {
	testCase(`8  version push "${version}"`, () => {
		const hex = buildOpFalseOpReturnWithTag({ tag: 'GaiaLog', version, payload: SAMPLE_BYTES })
		const { lib, plugin } = agree(`8/${version}`, hex)
		for (const r of [lib, plugin]) assert.deepStrictEqual(r.json, SAMPLE)
	})
}

// 9. No version push at all.
testCase('9  tag then JSON, no version push', () => {
	const hex = script(['GaiaLog', SAMPLE_BYTES])
	const { lib, plugin } = agree('9', hex)
	for (const r of [lib, plugin]) assert.deepStrictEqual(r.json, SAMPLE)
})

// 10. Legacy single push carrying the application tag inside the JSON.
testCase('10 legacy single JSON push', () => {
	const hex = script([LEGACY_BYTES])
	const { lib, plugin } = agree('10', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, LEGACY)
		assert.strictEqual(r.gzip, false)
		assert.strictEqual(r.hasHash, false)
	}
})

// 11. Legacy JSON gzipped as the only push.
testCase('11 legacy gzipped single JSON push', () => {
	const hex = script([gzipSync(LEGACY_BYTES)])
	const { lib, plugin } = agree('11', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, LEGACY)
		assert.strictEqual(r.gzip, true)
	}
})

// 12. Legacy JSON push with a trailing push.
testCase('12 legacy JSON push plus trailing push', () => {
	const hex = script([LEGACY_BYTES, 'extra=1'])
	const { lib, plugin } = agree('12', hex)
	for (const r of [lib, plugin]) assert.deepStrictEqual(r.json, LEGACY)
})

// 13. The digest pushed as 64 ASCII hex characters instead of 32 raw bytes.
testCase('13 ASCII hex SHA-256 push', () => {
	const hex = buildOpFalseOpReturnWithTag({
		tag: 'GaiaLog',
		version: 'v1',
		payload: SAMPLE_BYTES,
		extra: [Buffer.from(sha256(SAMPLE_BYTES).toString('hex'), 'ascii')],
	})
	const { lib, plugin } = agree('13', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.hasHash, true)
	}
})

// 14. Prefix pushes in front of the tag.
testCase('14 two prefix pushes before the tag', () => {
	const hex = script(['MAP', 'SET', 'GaiaLog', 'v1', SAMPLE_BYTES])
	const { lib, plugin } = agree('14', hex)
	for (const r of [lib, plugin]) assert.deepStrictEqual(r.json, SAMPLE)
})

// 15. 0x prefix and internal whitespace in the script hex.
testCase('15 script hex with 0x prefix and spaces', () => {
	const built = buildOpFalseOpReturnWithTag({ tag: 'GaiaLog', version: 'v1', payload: SAMPLE_BYTES })
	const messy = '0x' + built.replace(/(.{8})/g, '$1 ').trim()
	const { lib, plugin } = agree('15', messy)
	for (const r of [lib, plugin]) assert.deepStrictEqual(r.json, SAMPLE)
})

// 16. A 32-byte push that is not the payload digest: no throw, no hasHash.
testCase('16 mismatched 32-byte push', () => {
	const hex = buildOpFalseOpReturnWithTag({
		tag: 'GaiaLog',
		version: 'v1',
		payload: SAMPLE_BYTES,
		extra: [Buffer.alloc(32, 0xab)],
	})
	const { lib, plugin } = agree('16', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.hasHash, false)
	}
})

// 17. A non-push opcode after a valid envelope must stop parsing, not fail.
testCase('17 non-push opcode after a valid envelope', () => {
	const hex = buildOpFalseOpReturnWithTag({ tag: 'GaiaLog', version: 'v1', payload: SAMPLE_BYTES }) + 'ac'
	const { lib, plugin } = agree('17', hex)
	for (const r of [lib, plugin]) assert.deepStrictEqual(r.json, SAMPLE)
})

// 18. Malformed hex is rejected by both validators.
testCase('18 reject: odd-length and non-hex scripts', () => {
	for (const bad of ['006a0', '006aZZ', '00 6a 04']) {
		reject(`malformed ${JSON.stringify(bad)}`, bad)
	}
})

// 19. An empty push (OP_0) inside the envelope: both must behave the same.
testCase('19 empty push inside the envelope', () => {
	const hex = script(['GaiaLog', Buffer.alloc(0), LEGACY_BYTES])
	const { lib, plugin } = agree('19', hex)
	for (const r of [lib, plugin]) assert.deepStrictEqual(r.json, LEGACY)
})

// 20. Gzip payload with no version push resolves by magic bytes alone.
testCase('20 tag then gzipped JSON, no version push', () => {
	const hex = script(['GaiaLog', gzipSync(SAMPLE_BYTES)])
	const { lib, plugin } = agree('20', hex)
	for (const r of [lib, plugin]) {
		assert.deepStrictEqual(r.json, SAMPLE)
		assert.strictEqual(r.gzip, true)
	}
})

// 21. Truncated envelopes are rejected rather than accepted as empty.
testCase('21 reject: tag with no payload', () => {
	for (const hex of [script(['GaiaLog']), script(['GaiaLog', 'v1'])]) {
		reject(`truncated ${hex}`, hex)
	}
})

// 22. A JSON array is not a GaiaLog document.
testCase('22 reject: JSON array payload', () => {
	for (const hex of [script(['GaiaLog', 'v1', '[1,2,3]']), script(['["app"]'])]) {
		reject(`array ${hex}`, hex)
	}
})

// ---------------------------------------------------------------------------
// Scripts that must still be rejected
// ---------------------------------------------------------------------------

testCase('reject: MNEE push plus bsv-20 JSON', () => {
	reject('mnee', script(['MNEE', Buffer.from('{"p":"bsv-20"}', 'utf8')]))
})

testCase('reject: unrelated JSON', () => {
	reject('unrelated-json', script([Buffer.from('{"hello":"world"}', 'utf8')]))
})

testCase('reject: GaiaLog tag with a non-JSON payload', () => {
	reject('not-json', script(['GaiaLog', 'v1', 'not-json']))
})

testCase('reject: empty and non-script input', () => {
	for (const bad of ['', '   ', '0x', '0x6a', 'deadbeef', 'zz']) {
		reject(`non-script ${JSON.stringify(bad)}`, bad)
	}
})

console.log(
	failures === 0 ? 'PASS — all envelope formats accepted by both validators' : `${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
