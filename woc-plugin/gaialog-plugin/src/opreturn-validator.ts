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

function readPush(buf: Buffer, offset: number): { data: Buffer; next: number } | null {
	if (offset >= buf.length) return null
	const op = buf[offset]
	if (op >= 0x01 && op <= 0x4b) {
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
	const buf = Buffer.from(scriptHex, 'hex')
	let i = 0
	let isFalse = false
	let isTrue = false
	let isPlain = false
	if (buf.length >= 2 && buf[0] === 0x00 && buf[1] === 0x6a) {
		isFalse = true
		i = 2
	} else if (buf.length >= 2 && buf[0] === 0x51 && buf[1] === 0x6a) {
		isTrue = true
		i = 2
	} else if (buf.length >= 1 && buf[0] === 0x6a) {
		isPlain = true
		i = 1
	} else {
		throw new Error('Not an OP_RETURN script')
	}
	const pushes: Buffer[] = []
	while (i < buf.length) {
		const p = readPush(buf, i)
		if (!p) break
		pushes.push(p.data)
		i = p.next
	}
	return { pushes, isFalseReturn: isFalse, isTrueReturn: isTrue, isPlainReturn: isPlain }
}

export function validateGaiaLog(scriptHex: string): GaiaLogValidation {
	const { pushes, isTrueReturn } = parsePushes(scriptHex)

	// Envelope path: "GaiaLog", "v1", <payload>, [payload_sha256?], ["encoding=gzip"?]
	let payload: Buffer | null = null
	let gzip = false
	let hashPush: Buffer | undefined

	if (pushes.length >= 3) {
		const p1 = pushes[0].toString('utf8')
		const p2 = pushes[1].toString('utf8')
		if (p1 === 'GaiaLog' && p2 === 'v1') {
			payload = pushes[2]
			let idx = 3
			if (idx < pushes.length && pushes[idx].length === 32) {
				hashPush = pushes[idx]
				idx++
			}
			for (; idx < pushes.length; idx++) {
				if (pushes[idx].toString('utf8') === 'encoding=gzip') gzip = true
			}
		}
	}

	// Fallback legacy: single JSON push with app:"GaiaLog"
	if (!payload && pushes.length === 1) {
		const only = pushes[0]
		try {
			const j = JSON.parse(only.toString('utf8'))
			if (String(j?.app) === 'GaiaLog') {
				return { json: j, spendable: isTrueReturn, hasHash: false, gzip: false }
			}
		} catch {}
	}
	if (!payload) throw new Error('Missing required pushes')

	// Verify the embedded SHA-256 digest before trusting the payload.
	if (hashPush) {
		const digest = createHash('sha256').update(payload).digest()
		if (!digest.equals(hashPush)) throw new Error('payload_sha256 mismatch')
	}

	// Decompress if needed
	let raw = payload
	if (gzip || (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b)) {
		raw = gunzipSync(raw)
		gzip = true
	}

	let json: any
	try {
		json = JSON.parse(raw.toString('utf8'))
	} catch {
		throw new Error('Invalid GaiaLog JSON payload')
	}

	return { json, spendable: isTrueReturn, hasHash: !!hashPush, gzip }
}
