import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'

function readLE(hex: string, i: number, n: number): number {
	let v = 0
	for (let k = 0; k < n; k++) {
		const byteHex = hex.slice(i + 2 * k, i + 2 * k + 2)
		v |= parseInt(byteHex, 16) << (8 * k)
	}
	return v
}

export function parsePushes(scriptHex: string): { opFalseOrTrue: number; opReturn: number; pushes: Buffer[] } {
	let i = 0
	const readByte = () => parseInt(scriptHex.slice(i, i + 2), 16)
	const expect = (b: number) => {
		const got = readByte()
		i += 2
		if (got !== b) throw new Error(`Expected 0x${b.toString(16)}, got 0x${got.toString(16)}`)
		return got
	}

	// Support three forms:
	// 1) OP_FALSE OP_RETURN ...      (00 6a ...)
	// 2) OP_TRUE OP_RETURN ...       (51 6a ...)
	// 3) Plain OP_RETURN ...         (6a ...)
	let opFalseOrTrue = 0x00
	let opReturn = 0x6a

	const first = readByte()
	i += 2
	if (first === 0x6a) {
		// Plain OP_RETURN with no leading OP_FALSE/OP_TRUE
		opFalseOrTrue = 0x00
		opReturn = 0x6a
	} else if (first === 0x00 || first === 0x51) {
		opFalseOrTrue = first
		opReturn = expect(0x6a)
	} else {
		throw new Error('Must start with OP_RETURN (6a), or OPFALSE (00) OP_RETURN, or OPTRUE (51) OP_RETURN')
	}

	const pushes: Buffer[] = []
	while (i < scriptHex.length) {
		const op = readByte()
		i += 2
		let len = 0
		if (op <= 75) {
			len = op
		} else if (op === 0x4c) {
			len = readByte()
			i += 2
		} else if (op === 0x4d) {
			len = readLE(scriptHex, i, 2)
			i += 4
		} else if (op === 0x4e) {
			len = readLE(scriptHex, i, 4)
			i += 8
		} else {
			throw new Error(`Unexpected opcode 0x${op.toString(16)} in OP_RETURN`)
		}
		const dataHex = scriptHex.slice(i, i + len * 2)
		i += len * 2
		pushes.push(Buffer.from(dataHex, 'hex'))
	}

	return { opFalseOrTrue, opReturn, pushes }
}

export function validateGaiaLog(scriptHex: string): { spendable: boolean; gzip: boolean; hasHash: boolean; json: any } {
	const { opFalseOrTrue, pushes } = parsePushes(scriptHex)
	const spendable = opFalseOrTrue === 0x51 // TRUE RETURN if enabled

	// Primary format: ["GaiaLog", "v1", <payload>, ...extras]
	if (pushes.length < 3) {
		// Fallback: accept legacy single-push JSON that already contains { app: "GaiaLog", ... }
		try {
			if (pushes.length >= 1) {
				const first = pushes[0].toString('utf8')
				const obj = JSON.parse(first)
				if (obj && typeof obj === 'object' && obj.app === 'GaiaLog') {
					// Consider this a valid GaiaLog document without envelope
					return { spendable, gzip: false, hasHash: false, json: obj }
				}
			}
		} catch {
			// fallthrough to error
		}
		throw new Error('Missing required pushes')
	}
	const tag = pushes[0].toString('utf8')
	const version = pushes[1].toString('utf8')
	if (tag !== 'GaiaLog') throw new Error(`Unexpected tag ${tag}`)
	if (version !== 'v1') throw new Error(`Unexpected version ${version}`)

	const payloadBytes = pushes[2]
	let idx = 3

	// Optional extras (order: payload_sha256? then "encoding=gzip"?)
	let hashPush: Buffer | undefined
	let isGzip = false

	if (idx < pushes.length && pushes[idx].length === 32) {
		hashPush = pushes[idx]
		idx++
	}
	if (idx < pushes.length && pushes[idx].toString('utf8') === 'encoding=gzip') {
		isGzip = true
		idx++
	}
	if (idx !== pushes.length) {
		throw new Error('Unexpected extra pushes detected')
	}

	// Verify hash (against embedded bytes exactly as written)
	if (hashPush) {
		const h = createHash('sha256').update(payloadBytes).digest()
		if (!h.equals(hashPush)) throw new Error('payload_sha256 mismatch')
	}

	// Decode payload
	const decodedBytes = isGzip ? gunzipSync(payloadBytes) : payloadBytes
	const json = JSON.parse(decodedBytes.toString('utf8'))

	return { spendable, gzip: isGzip, hasHash: !!hashPush, json }
}




