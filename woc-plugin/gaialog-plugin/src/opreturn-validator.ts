/* OP_RETURN parsing and GaiaLog envelope validation */

export type ParseResult = {
	pushes: Buffer[]
	isFalseReturn: boolean
	isTrueReturn: boolean
	isPlainReturn: boolean
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
		const len = buf[offset + 1]
		const start = offset + 2
		const end = start + len
		if (end > buf.length) return null
		return { data: buf.subarray(start, end), next: end }
	}
	if (op === 0x4d) {
		const len = buf.readUInt16LE(offset + 1)
		const start = offset + 3
		const end = start + len
		if (end > buf.length) return null
		return { data: buf.subarray(start, end), next: end }
	}
	if (op === 0x4e) {
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

export function validateGaiaLog(scriptHex: string): {
	json: any
	spendable: boolean
	hasHash: boolean
	gzip: boolean
} {
	const { pushes } = parsePushes(scriptHex)

	// Envelope path: "GaiaLog", "v1", <payload>, [extras...]
	let payload: Buffer | null = null
	let gzip = false
	let hasHash = false
	if (pushes.length >= 3) {
		const p1 = pushes[0].toString('utf8')
		const p2 = pushes[1].toString('utf8')
		if (p1 === 'GaiaLog' && p2 === 'v1') {
			payload = pushes[2]
			for (let idx = 3; idx < pushes.length; idx++) {
				const x = pushes[idx]
				if (x.length === 32) hasHash = true
				const asText = safeText(x)
				if (asText.includes('encoding=gzip')) gzip = true
			}
		}
	}
	// Fallback legacy: single JSON push with app:"GaiaLog"
	if (!payload && pushes.length === 1) {
		const only = pushes[0]
		try {
			const j = JSON.parse(only.toString('utf8'))
			if (String(j?.app) === 'GaiaLog') {
				return { json: j, spendable: false, hasHash: false, gzip: false }
			}
		} catch {}
	}
	if (!payload) throw new Error('Missing required pushes')

	// Decompress if needed
	let raw = payload
	if (gzip || (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b)) {
		const { gunzipSync } = require('zlib') as typeof import('zlib')
		raw = gunzipSync(raw)
		gzip = true
	}
	let json: any
	try {
		json = JSON.parse(raw.toString('utf8'))
	} catch (e: any) {
		throw new Error('Invalid GaiaLog JSON payload')
	}
	return { json, spendable: false, hasHash, gzip }
}

function safeText(b: Buffer): string {
	try {
		return b.toString('utf8')
	} catch {
		return ''
	}
}



