function toHexLE(n: number, bytes: number): string {
	const arr = []
	for (let i = 0; i < bytes; i++) {
		arr.push((n >> (8 * i)) & 0xff)
	}
	return Buffer.from(arr).toString('hex')
}

function pushDataHex(hex: string): string {
	const len = hex.length / 2
	if (len <= 75) {
		return len.toString(16).padStart(2, '0') + hex
	} else if (len <= 0xff) {
		// OP_PUSHDATA1 (0x4c), then 1-byte length
		return '4c' + len.toString(16).padStart(2, '0') + hex
	} else if (len <= 0xffff) {
		// OP_PUSHDATA2 (0x4d), then 2-byte little-endian length
		return '4d' + toHexLE(len, 2) + hex
	} else {
		// OP_PUSHDATA4 (0x4e), then 4-byte little-endian length
		return '4e' + toHexLE(len, 4) + hex
	}
}

export function buildOpFalseOpReturnWithTag(params: {
	tag: string
	version?: string
	payload: Buffer
	extra?: (Buffer | string)[]
	useTrueReturn?: boolean
}): string {
	const { tag, payload, version = 'v1', extra = [], useTrueReturn = false } = params
	const tagHex = Buffer.from(tag, 'utf8').toString('hex')
	const verHex = Buffer.from(version, 'utf8').toString('hex')
	const payloadHex = payload.toString('hex')

	const parts: string[] = []
	parts.push(useTrueReturn ? '51' : '00') // OP_TRUE (0x51) or OP_FALSE (0x00)
	parts.push('6a') // OP_RETURN
	parts.push(pushDataHex(tagHex))
	parts.push(pushDataHex(verHex))
	parts.push(pushDataHex(payloadHex))
	for (const item of extra) {
		const h = Buffer.isBuffer(item) ? item.toString('hex') : Buffer.from(item, 'utf8').toString('hex')
		parts.push(pushDataHex(h))
	}
	return parts.join('')
}


