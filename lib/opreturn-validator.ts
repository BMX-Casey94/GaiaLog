/**
 * GaiaLog OP_RETURN envelope decoding, shared by the Next.js routes, the
 * explorer sync and the WoC fetcher.
 *
 * This is a viewer, not a consensus check: an unreadable extra push must not
 * hide a document that has already parsed.
 */
import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'

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

export type ParsedPushes = { opFalseOrTrue: number; opReturn: number; pushes: Buffer[] }
export type ValidatedGaiaLog = { spendable: boolean; gzip: boolean; hasHash: boolean; json: any }

/** Trim, drop one leading 0x/0X, and remove all whitespace. */
export function normaliseScriptHex(scriptHex: string): string {
	let hex = String(scriptHex ?? '').trim()
	if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2)
	return hex.replace(/\s+/g, '')
}

export function parsePushes(scriptHex: string): ParsedPushes {
	const hex = normaliseScriptHex(scriptHex)
	if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
		throw new Error('Script hex is empty or malformed')
	}
	const buf = Buffer.from(hex, 'hex')

	// Three accepted forms: OP_FALSE OP_RETURN, OP_TRUE OP_RETURN, plain OP_RETURN.
	let i = 0
	let opFalseOrTrue = 0x00
	const opReturn = 0x6a
	const first = buf[0]
	if (first === 0x6a) {
		i = 1
	} else if (first === 0x00 || first === 0x51) {
		if (buf[1] !== 0x6a) throw new Error('Expected OP_RETURN after OP_FALSE/OP_TRUE')
		opFalseOrTrue = first
		i = 2
	} else {
		throw new Error('Must start with OP_RETURN (6a), or OPFALSE (00) OP_RETURN, or OPTRUE (51) OP_RETURN')
	}

	const pushes: Buffer[] = []
	// An opcode that is not a data push ends the list. The header already
	// validated, so the pushes read so far are still usable.
	while (i < buf.length) {
		const op = buf[i]
		let len: number
		let start = i + 1
		if (op <= 0x4b) {
			len = op
		} else if (op === 0x4c) {
			if (i + 1 >= buf.length) break
			len = buf[i + 1]
			start = i + 2
		} else if (op === 0x4d) {
			if (i + 2 >= buf.length) break
			len = buf.readUInt16LE(i + 1)
			start = i + 3
		} else if (op === 0x4e) {
			if (i + 4 >= buf.length) break
			len = buf.readUInt32LE(i + 1)
			start = i + 5
		} else {
			break
		}
		if (start + len > buf.length) break
		pushes.push(buf.subarray(start, start + len))
		i = start + len
	}

	return { opFalseOrTrue, opReturn, pushes }
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

/**
 * A hash push is either the 32 raw digest bytes or its 64 ASCII hex chars.
 * Anything else stays an unread extra push.
 */
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
function decodeEnvelope(pushes: Buffer[], tagIndex: number, spendable: boolean): ValidatedGaiaLog | null {
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
	return { spendable, gzip, hasHash, json }
}

export function validateGaiaLog(scriptHex: string): ValidatedGaiaLog {
	const { opFalseOrTrue, pushes } = parsePushes(scriptHex)
	const spendable = opFalseOrTrue === 0x51

	// Envelope: [prefixes] "GaiaLog" [version] <payload> [extras]
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
		return { spendable, gzip: decoded.gzip, hasHash, json: decoded.json }
	}

	throw new Error('Not a GaiaLog transaction')
}
