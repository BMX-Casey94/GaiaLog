import { NextRequest, NextResponse } from 'next/server'
import { validateGaiaLog, parsePushes } from '@/lib/opreturn-validator'
import { promises as fs } from 'fs'
import path from 'path'
import { renderHtml, renderErrorHtml, detectKnownNonGaia, buildWocHeaders } from '../../../route'

export const runtime = 'nodejs'

const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY

type Cached = { html: string; at: number }
const CACHE_TTL_MS = 15 * 60 * 1000
const cache = new Map<string, Cached>()

function getCache(key: string): string | null {
	const c = cache.get(key)
	if (!c) return null
	if (Date.now() - c.at > CACHE_TTL_MS) {
		cache.delete(key)
		return null
	}
	return c.html
}

function setCache(key: string, html: string): void {
	if (cache.size > 200) {
		const first = cache.keys().next().value
		if (first) cache.delete(first)
	}
	cache.set(key, { html, at: Date.now() })
}

/** Parse a vout from a query, body or route value. Vout 0 is valid. */
function parseVout(value: unknown): number | undefined {
	if (value === undefined || value === null || value === '') return undefined
	const n = Number(value)
	return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : undefined
}

/** Error copy. The pipe is the two-line separator and belongs only to the first sentence. */
const NOT_GAIA_LOG_MESSAGE = "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin."
const GAIA_LOG_UNDECODABLE_MESSAGE = 'This is a GaiaLog transaction, but the payload could not be decoded.'

/** Trim, strip a single leading 0x and remove whitespace before any decode. */
function normaliseScriptHex(value: unknown): string {
	let hex = typeof value === 'string' ? value.trim() : ''
	if (hex.slice(0, 2).toLowerCase() === '0x') hex = hex.slice(2)
	return hex.replace(/\s+/g, '')
}

/** One whole even-length hex token, which is how `asm` shows a single data push. */
function isDataHexToken(token: string): boolean {
	return token.length >= 2 && token.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(token)
}

/** Little-endian hex of `n` in `bytes` bytes, avoiding 32-bit shift overflow. */
function uintLEHex(n: number, bytes: number): string {
	let out = ''
	let value = n
	for (let i = 0; i < bytes; i++) {
		out += (value & 0xff).toString(16).padStart(2, '0')
		value = Math.floor(value / 256)
	}
	return out
}

/** Minimal push encoding, matching `pushDataHex` in lib/opreturn.ts. */
function encodeDataPushHex(dataHex: string): string {
	const len = dataHex.length / 2
	if (len <= 75) return len.toString(16).padStart(2, '0') + dataHex
	if (len <= 0xff) return '4c' + len.toString(16).padStart(2, '0') + dataHex
	if (len <= 0xffff) return '4d' + uintLEHex(len, 2) + dataHex
	return '4e' + uintLEHex(len, 4) + dataHex
}

/**
 * Rebuild an OP_RETURN script from `scriptPubKey.asm`. WhatsOnChain omits
 * `scriptPubKey.hex` for some large scripts, so asm is the only source left.
 * A token before OP_RETURN that is not OP_FALSE/OP_0/OP_TRUE means a plain
 * OP_RETURN; tokens after it that are not hex are opcodes and are ignored.
 */
function scriptHexFromAsm(asm: string): string {
	const tokens = String(asm || '').trim().split(/\s+/).filter(Boolean)
	const at = tokens.indexOf('OP_RETURN')
	if (at < 0) return ''
	let prefix = ''
	if (at > 0) {
		const before = tokens[at - 1]
		if (before === '0' || before === 'OP_0' || before === 'OP_FALSE') prefix = '00'
		else if (before === 'OP_TRUE') prefix = '51'
	}
	let hex = `${prefix}6a`
	for (const token of tokens.slice(at + 1)) {
		if (!isDataHexToken(token)) continue
		hex += encodeDataPushHex(token)
	}
	return hex
}

/** Best available script hex for one transaction output. */
function outputScriptHex(out: any): string {
	const fromScriptPubKey = normaliseScriptHex(out?.scriptPubKey?.hex)
	if (isDataHexToken(fromScriptPubKey)) return fromScriptPubKey
	const fromOutput = normaliseScriptHex(out?.hex)
	if (isDataHexToken(fromOutput)) return fromOutput
	return scriptHexFromAsm(String(out?.scriptPubKey?.asm || ''))
}

/** True when the script carries a push whose text is exactly "GaiaLog". */
function hasGaiaLogPush(scriptHex: string): boolean {
	try {
		const { pushes } = parsePushes(scriptHex)
		return pushes.some(push => push.toString('utf8') === 'GaiaLog')
	} catch {
		return false
	}
}

function isGaiaLogScript(scriptHex: string): boolean {
	if (!scriptHex) return false
	try {
		validateGaiaLog(scriptHex)
		return true
	} catch {
		return false
	}
}

/** Plain OP_RETURN, OP_FALSE OP_RETURN or OP_TRUE OP_RETURN. */
function isOpReturnScript(scriptHex: string): boolean {
	return /^(00|51)?6a/i.test(scriptHex)
}

/** Fetch the transaction once and return every output with the script hex available for it. */
async function fetchTxOutputs(network: string, txid: string): Promise<{ n: number; scriptHex: string }[]> {
	const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}`, {
		headers: buildWocHeaders(WHATSONCHAIN_API_KEY),
	})
	if (!res.ok) throw new Error(`Failed to fetch TX: ${res.status}`)
	const j = await res.json()
	const outs: any[] = Array.isArray(j?.vout) ? j.vout : []
	return outs.map((out: any, i: number) => ({
		n: typeof out?.n === 'number' ? out.n : i,
		scriptHex: outputScriptHex(out),
	}))
}

/**
 * Fetch the transaction once and return the script to decode.
 *
 * WhatsOnChain invokes the plugin with whichever vout the visitor opened, and
 * the writer puts the OP_RETURN first, so the opened vout is often the change
 * output. When the requested output is not a valid GaiaLog OP_RETURN, the first
 * output that does validate is returned instead.
 */
async function fetchTxAndFindScriptHex(network: string, txid: string, vout?: number): Promise<string> {
	const outputs = await fetchTxOutputs(network, txid)
	const validating = outputs.filter(output => isGaiaLogScript(output.scriptHex))

	if (typeof vout === 'number' && Number.isFinite(vout)) {
		const requested = outputs.find(output => output.n === vout)
		if (!requested) {
			if (validating.length > 0) return validating[0].scriptHex
			throw new Error('Specified vout not found')
		}
		if (isGaiaLogScript(requested.scriptHex)) return requested.scriptHex
		if (validating.length > 0) return validating[0].scriptHex
		// No output validates: hand back the requested output's script so the
		// caller can classify it. Only a total absence of bytes is a lookup error.
		if (requested.scriptHex) return requested.scriptHex
		throw new Error('Specified vout not found or missing script hex')
	}

	if (validating.length > 0) return validating[0].scriptHex
	throw new Error('No GaiaLog OP_RETURN output found')
}

/**
 * Pick the error copy for a failed request.
 *
 * The previous code replaced every failure with the not-a-GaiaLog sentence,
 * which hid fetch errors, missing script hex and recoverable envelope problems.
 * That sentence now needs a script that was actually obtained, fails to
 * validate, carries no exact "GaiaLog" push and matches no other known
 * protocol. A fetch failure, a vout that does not exist and an output with no
 * script bytes all keep the underlying error instead.
 */
async function failureMessage(
	failure: any,
	params: { scriptHex?: string; network?: string; txid?: string; vout?: number }
): Promise<string> {
	const fallback = failure?.message ? String(failure.message) : 'Decode error'
	const suppliedHex = normaliseScriptHex(params.scriptHex)

	// Fetch once. A transaction that cannot be read yields no evidence at all.
	let outputs: { n: number; scriptHex: string }[] = []
	let txReadable = false
	if (params.txid) {
		try {
			outputs = await fetchTxOutputs(params.network || 'main', params.txid)
			txReadable = true
		} catch { /* classified below */ }
	}
	if (!suppliedHex && !txReadable) return fallback

	// The opened vout drives the verdict, so a vout with no script is a lookup failure.
	let requested: { n: number; scriptHex: string } | undefined
	if (txReadable && params.vout !== undefined) {
		requested = outputs.find(output => output.n === params.vout)
		if (!requested || !requested.scriptHex) return fallback
	}

	const fromTx = txReadable ? outputs.map(output => output.scriptHex).filter(Boolean) : []
	const scripts = [suppliedHex, ...fromTx].filter((script, i, list) => script && list.indexOf(script) === i)
	if (scripts.length === 0) return fallback

	// A script that decodes means the failure happened somewhere else.
	if (scripts.some(isGaiaLogScript)) return fallback

	// A tag anywhere in the transaction means our envelope failed to decode,
	// even when the visitor opened the change output.
	if (scripts.some(hasGaiaLogPush)) return GAIA_LOG_UNDECODABLE_MESSAGE

	// Name another protocol from the opened output first, then the OP_RETURN,
	// which is where such a tag actually lives when the vout is a plain payment.
	const opReturns = fromTx.filter(isOpReturnScript)
	const ordered = [requested?.scriptHex || '', ...opReturns, ...scripts]
		.filter((script, i, list) => script && list.indexOf(script) === i)
	for (const script of ordered) {
		const detected = detectKnownNonGaia(script)
		if (detected) return detected.message
	}

	// Only deny the transaction when its scripts were actually read.
	return txReadable || !params.txid ? NOT_GAIA_LOG_MESSAGE : fallback
}

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ network: string; txid: string; vout: string }> }
) {
	const resolvedParams = await params
	try {
		const network = String(resolvedParams.network || 'main').trim()
		const txid = String(resolvedParams.txid || '').trim()
		const vout = Number(resolvedParams.vout)
		if (!txid || !Number.isFinite(vout)) throw new Error('Invalid parameters')

		const key = `GET:${network}:${txid}:${vout}`
		const cached = getCache(key)
		if (cached) return new NextResponse(cached, { headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
			'Vary': 'Accept',
		} })

		const hex = await fetchTxAndFindScriptHex(network, txid, vout)
		const decoded = validateGaiaLog(hex)
		
		const logoUrl = await (async () => {
			const candidates = [
				path.join(process.cwd(), 'public', 'gaialog-logo.png'),
				path.join(process.cwd(), 'public', 'gaialog-logo.svg'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'GaiaLog Logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.svg'),
			]
			for (const p of candidates) {
				try {
					const buf = await fs.readFile(p)
					const mime = p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'
					return `data:${mime};base64,${buf.toString('base64')}`
				} catch {}
			}
			return null
		})()

		const html = renderHtml({
			txid,
			network,
			json: decoded.json,
			spendable: decoded.spendable,
			hasHash: decoded.hasHash,
			isGzip: decoded.gzip,
			logoUrl,
		})
		setCache(key, html)
		return new NextResponse(html, { headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
			'Vary': 'Accept',
		} })
	} catch (e: any) {
		const rawVout = String(resolvedParams.vout ?? '').trim()
		const vout = parseVout(rawVout)
		// A malformed vout is a bad request, not evidence about the transaction.
		const message = rawVout !== '' && vout === undefined
			? (e?.message ? String(e.message) : 'Invalid parameters')
			: await failureMessage(e, {
				network: String(resolvedParams.network || 'main').trim(),
				txid: String(resolvedParams.txid || '').trim(),
				vout,
			})

		const logoUrl = await (async () => {
			const candidates = [
				path.join(process.cwd(), 'public', 'gaialog-logo.png'),
				path.join(process.cwd(), 'public', 'gaialog-logo.svg'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'GaiaLog Logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.svg'),
			]
			for (const p of candidates) {
				try {
					const buf = await fs.readFile(p)
					const mime = p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'
					return `data:${mime};base64,${buf.toString('base64')}`
				} catch {}
			}
			return null
		})()

		const html = renderErrorHtml({
			txid: resolvedParams.txid,
			network: resolvedParams.network,
			message,
			logoUrl,
		})
		return new NextResponse(html, { headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
			'Vary': 'Accept',
		}, status: 200 })
	}
}

