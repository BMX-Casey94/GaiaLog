/* Minimal utilities to build OP_RETURN scripts for preview/testing */

function encodePush(data: Buffer | string): Buffer {
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
	const len = buf.length
	if (len <= 75) {
		return Buffer.concat([Buffer.from([len]), buf])
	}
	if (len <= 0xff) {
		return Buffer.concat([Buffer.from([0x4c, len]), buf]) // OP_PUSHDATA1
	}
	if (len <= 0xffff) {
		const le = Buffer.alloc(2)
		le.writeUInt16LE(len, 0)
		return Buffer.concat([Buffer.from([0x4d]), le, buf]) // OP_PUSHDATA2
	}
	const le4 = Buffer.alloc(4)
	le4.writeUInt32LE(len, 0)
	return Buffer.concat([Buffer.from([0x4e]), le4, buf]) // OP_PUSHDATA4
}

export function buildOpFalseOpReturnWithTag(opts: {
	tag: string
	version: string
	payload: Buffer
	extra?: (Buffer | string)[]
	useTrueReturn?: boolean
}): string {
	const { tag, version, payload, extra = [], useTrueReturn = false } = opts
	const prefix = useTrueReturn ? Buffer.from([0x51, 0x6a]) : Buffer.from([0x00, 0x6a]) // OP_TRUE/OP_FALSE OP_RETURN
	const parts: Buffer[] = [prefix, encodePush(tag), encodePush(version), encodePush(payload)]
	for (const e of extra) parts.push(encodePush(e as any))
	return Buffer.concat(parts).toString('hex')
}



