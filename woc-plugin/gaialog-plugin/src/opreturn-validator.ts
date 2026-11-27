/* OP_RETURN parsing and GaiaLog envelope validation */

import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'

export type ParseResult = {
	pushes: Buffer[]
	isFalseReturn: boolean
	isTrueReturn: boolean
	isPlainReturn: boolean
}

export type GaiaLogValidation = {
	json: any
	spendable: boolean
	hasHash: boolean
	gzip: boolean
}

const TAG = Buffer.from('GaiaLog', 'utf8')
const GZIP_MARKER = Buffer.from('encoding=gzip', 'utf8')
/** The tag may sit behind a small number of other protocol pushes. */
const MAX_TAG_INDEX = 4
const MAX_VERSION_LENGTH = 16
const VERSION_PATTERN = /^v?\d+(\.\d+){0,3}$/
/**
 * Ceiling on decompressed size. Script data is untrusted, and a small gzip
 * push can expand enormously; decoding must not be able to exhaust memory.
 */
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024

/** Trim, drop one leading 0x/0X, and remove all whitespace. */
export function normaliseScriptHex(scriptHex: string): string {
	let hex = String(scriptHex ?? '').trim()
	if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2)
	return hex.replace(/\s+/g, '')
}

function readPush(buf: Buffer, offset: number): { data: Buffer; next: number } | null {
	if (offset >= buf.length) return null
	const op = buf[offset]
	// OP_0 (0x00) is a push of empty data, so parsing continues past it.
	if (op <= 0x4b) {
		const size = op
		const start = offset + 1
		const end = start + size
		if (end > buf.length) return null
		return { data: buf.subarray(start, end), next: end }
	}
	if (op === 0x4c) {
		if (offset + 1 >= buf.length) return null
		const len = buf[offset + 1]
		const start = offset + 2
		const end = start + len
		if (end > buf.length) return null
		return { data: buf.subarray(start, end), next: end }
	}
	if (op === 0x4d) {
		if (offset + 2 >= buf.length) return null
		const len = buf.readUInt16LE(offset + 1)
		const start = offset + 3
		const end = start + len
		if (end > buf.length) return null
		return { data: buf.subarray(start, end), next: end }
	}
	if (op === 0x4e) {
		if (offset + 4 >= buf.length) return null
		const len = buf.readUInt32LE(offset + 1)
		const start = offset + 5
		const end = start + len
		if (end > buf.length) return null
		return { data: buf.subarray(start, end), next: end }
	}
	return null
}

export function parsePushes(scriptHex: string): ParseResult {
	const hex = normaliseScriptHex(scriptHex)
	if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
		throw new Error('Not an OP_RETURN script')
	}
	const buf = Buffer.from(hex, 'hex')
	let i = 0
	let isFalse = false
	let isTrue = false
	let isPlain = false
	if (buf[0] === 0x00 && buf[1] === 0x6a) {
		isFalse = true
		i = 2
	} else if (buf[0] === 0x51 && buf[1] === 0x6a) {
		isTrue = true
		i = 2
	} else if (buf[0] === 0x6a) {
		isPlain = true
		i = 1
	} else {
		throw new Error('Not an OP_RETURN script')
	}
	const pushes: Buffer[] = []
	// A non-push opcode ends the list; the header already validated, so the
	// pushes read so far stay usable.
	while (i < buf.length) {
		const p = readPush(buf, i)
		if (!p) break
		pushes.push(p.data)
		i = p.next
	}
	return { pushes, isFalseReturn: isFalse, isTrueReturn: isTrue, isPlainReturn: isPlain }
}

function isDocument(value: any): boolean {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Gunzip with a hard size ceiling; throws if the stream exceeds it. */
function gunzipBounded(buf: Buffer): Buffer {
	return gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
}

/** JSON, or gzip of JSON, with a non-null object at the root. */
function tryDecodeDocument(push: Buffer): { json: any; gzip: boolean } | null {
	const magic = push.length >= 2 && push[0] === 0x1f && push[1] === 0x8b
	let bytes = push
	if (magic) {
		try {
			bytes = gunzipBounded(push)
		} catch {
			return null
		}
	}
	try {
		const json = JSON.parse(bytes.toString('utf8'))
		return isDocument(json) ? { json, gzip: magic } : null
	} catch {
		return null
	}
}

function isVersionToken(push: Buffer): boolean {
	const text = push.toString('utf8')
	return text.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(text)
}

/** A hash push is the 32 raw digest bytes or its 64 ASCII hex chars. */
function isDigestPush(push: Buffer, digest: Buffer): boolean {
	if (push.length === 32) return push.equals(digest)
	if (push.length === 64) {
		const ascii = push.toString('latin1').toLowerCase()
		return /^[0-9a-f]{64}$/.test(ascii) && ascii === digest.toString('hex')
	}
	return false
}

/**
 * Decode the envelope starting at `tagIndex`. Returns null when the pushes
 * after the tag do not form a document, so the caller can fall back to the
 * legacy layout.
 */
function decodeEnvelope(pushes: Buffer[], tagIndex: number, spendable: boolean): GaiaLogValidation | null {
	let index = tagIndex + 1
	if (index >= pushes.length) return null
	const hasVersion = isVersionToken(pushes[index])
	if (hasVersion) index++
	if (index >= pushes.length) return null

	const payload = pushes[index]
	const extras = pushes.slice(index + 1)
	// The marker may sit anywhere among the extras. The writer also adds it
	// when compression was requested but failed, leaving plain JSON in place,
	// so a marker that does not inflate must not hide that document.
	const markedGzip = extras.some(p => p.equals(GZIP_MARKER))
	const magicGzip = payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b

	let bytes = payload
	let gzip = false
	if (magicGzip || markedGzip) {
		try {
			bytes = gunzipBounded(payload)
			gzip = true
		} catch {
			if (magicGzip) {
				if (hasVersion) throw new Error('Invalid GaiaLog gzip payload')
				return null
			}
			bytes = payload
		}
	}

	let json: any
	try {
		json = JSON.parse(bytes.toString('utf8'))
	} catch {
		if (hasVersion) throw new Error('Invalid GaiaLog JSON payload')
		return null
	}
	if (!isDocument(json)) {
		if (hasVersion) throw new Error('GaiaLog payload is not a JSON object')
		return null
	}

	const digest = createHash('sha256').update(payload).digest()
	const hasHash = extras.some(p => isDigestPush(p, digest))
	return { json, spendable, hasHash, gzip }
}

export function validateGaiaLog(scriptHex: string): GaiaLogValidation {
	const { pushes, isTrueReturn } = parsePushes(scriptHex)
	const spendable = isTrueReturn

	let tagIndex = -1
	const scanLimit = Math.min(pushes.length, MAX_TAG_INDEX + 1)
	for (let i = 0; i < scanLimit; i++) {
		if (pushes[i].equals(TAG)) {
			tagIndex = i
			break
		}
	}

	if (tagIndex >= 0) {
		const envelope = decodeEnvelope(pushes, tagIndex, spendable)
		if (envelope) return envelope
	}

	// Legacy: a push that is itself the document, tagged app === "GaiaLog".
	for (let i = 0; i < pushes.length; i++) {
		const decoded = tryDecodeDocument(pushes[i])
		if (!decoded) continue
		if (decoded.json.app !== 'GaiaLog') continue
		const digest = createHash('sha256').update(pushes[i]).digest()
		const hasHash = pushes.slice(i + 1).some(p => isDigestPush(p, digest))
		return { json: decoded.json, spendable, hasHash, gzip: decoded.gzip }
	}

	throw new Error('Not a GaiaLog transaction')
}
