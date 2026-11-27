import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { renderErrorHtml, renderHtml, renderHomeHtml } from './render.js'
import { parsePushes, validateGaiaLog } from './opreturn-validator.js'
import { buildOpFalseOpReturnWithTag } from './opreturn.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PORT = Number(process.env.PORT || 8787)
const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY

/**
 * Build WoC request headers for the configured API key. Modern keys are
 * prefixed `mainnet_`/`testnet_` and must travel in Authorization; legacy keys
 * use the `woc-api-key` header.
 */
export function buildWocHeaders(apiKey: string | undefined | null): Record<string, string> {
	if (!apiKey) return {}
	const key = String(apiKey).trim()
	if (!key) return {}
	if (key.startsWith('mainnet_') || key.startsWith('testnet_')) {
		return { Authorization: key }
	}
	return { 'woc-api-key': key }
}

/** Cache key: full SHA-256 of the script hex, never a truncated prefix. */
export function hexCacheKey(scriptHex: string): string {
	return createHash('sha256').update(scriptHex).digest('hex')
}

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

async function resolveLogoDataUrl(): Promise<string | null> {
	const candidates = [
		path.join(process.cwd(), 'woc-plugin', 'gaialog-plugin', 'assets', 'gaialog-logo.png'),
		path.join(process.cwd(), 'assets', 'gaialog-logo.png'),
		path.join(__dirname, '../assets/gaialog-logo.png'),
		path.join(__dirname, '../assets/gaialog-logo.svg'),
		path.join(process.cwd(), 'public', 'gaialog-logo.png'),
		path.join(process.cwd(), 'public', 'gaialog-logo.svg'),
		path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.png'),
		path.join(process.cwd(), 'woc-plugin', 'GaiaLog Logo.png'),
		path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.svg'),
		path.join(process.cwd(), '..', 'GaiaLog Logo.png')
	]
	for (const p of candidates) {
		try {
			const buf = await fs.readFile(p)
			const mime = p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'
			return `data:${mime};base64,${buf.toString('base64')}`
		} catch {}
	}
	return null
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

function detectKnownNonGaia(scriptHex: string): { name: string; message: string } | null {
	try {
		let blob = ''
		try {
			const { pushes } = parsePushes(scriptHex)
			const texts = pushes.map(b => {
				try { return b.toString('utf8') } catch { return '' }
			}).filter(Boolean)
			blob = texts.join(' ')
		} catch {}
		try {
			const rawAscii = Buffer.from(scriptHex, 'hex').toString('latin1')
			const printable = rawAscii.split('').map(ch => {
				const c = ch.charCodeAt(0)
				return c >= 32 && c <= 126 ? ch : ' '
			}).join('')
			blob = `${blob} ${printable}`.toLowerCase()
		} catch {}
		if (blob.includes('rekord kloud') || blob.includes('"woctag":"rekord kloud"')) {
			return { name: 'rekord_kloud', message: "Oops! Looks like you are trying to view a 'Rekord Kloud' transaction.|Unfortunately, our plugin isn't compatible for this data." }
		}
		if (blob.includes('"p":"bsv-20"') || blob.includes('application/bsv-20') || blob.includes(' ord ')) {
			return { name: 'mnee', message: "Oops! It appears you are attempting to view a MNEE transaction.|Please select the MNEE Plugin to view the correct details." }
		}
		if (blob.includes('treechat_msg_id') || blob.includes('treechat_thread_id') || (blob.includes('app') && blob.includes('treechat'))) {
			return { name: 'treechat', message: "Sorry! It appears you are trying to view a Treechat transaction record.|Please switch to the Treechat BMAP Plugin." }
		}
		if (blob.includes('1lmv1pymp8s9yjun7m9hvtsdkdbau8kqnj@') || blob.includes('certihash')) {
			return { name: 'certihash', message: "Oops! It looks like you are trying to view a CertiHash transaction.|Please use the CertiHash plugin to view the correct details." }
		}
	} catch {}
	return null
}

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/', async (req, res) => {
	try {
		const scriptHex = normaliseScriptHex(req.query.script_hex)
		const network = String(req.query.network || 'main').trim()
		const txid = String(req.query.txid || '').trim()
		const vout = parseVout(req.query.vout)

		// Show home page if no parameters provided
		if (!scriptHex && !txid) {
			const logoUrl = await resolveLogoDataUrl()
			const html = renderHomeHtml({ logoUrl })
			return res.type('html').send(html)
		}

		// WoC invokes the plugin with whichever vout the visitor opened, and may
		// also send that output's script. The key therefore has to cover both the
		// transaction identity and the vout, and a supplied script must not
		// short-circuit the lookup when a txid is available.
		const voutIndex = Number.isFinite(vout) ? vout : -1
		const key = txid ? `GET:${network}:${txid}:${voutIndex}` : `GET:hex:${hexCacheKey(scriptHex)}`
		const cached = getCache(key)
		if (cached) return res.type('html').send(cached)

		let hex = scriptHex
		if (txid) {
			try {
				hex = await fetchTxAndFindScriptHex(network, txid, Number.isFinite(vout) ? vout : undefined)
			} catch (lookupError) {
				// No usable transaction, so fall back to the script WoC supplied.
				if (!scriptHex) throw lookupError
				hex = scriptHex
			}
		}
		if (!hex) throw new Error('Provide script_hex or txid')

		const decoded = validateGaiaLog(hex)
		const logoUrl = await resolveLogoDataUrl()
		const html = renderHtml({ txid, network, json: decoded.json, logoUrl })
		setCache(key, html)
		return res.type('html').send(html)
	} catch (e: any) {
		const message = await failureMessage(e, {
			scriptHex: String(req.query.script_hex || ''),
			network: String(req.query.network || 'main').trim(),
			txid: String(req.query.txid || '').trim(),
			vout: parseVout(req.query.vout),
		})
		const logoUrl = await resolveLogoDataUrl()
		const html = renderErrorHtml({ message, logoUrl })
		return res.type('html').status(200).send(html)
	}
})

// WoC Data plugin style endpoints (per docs/example repos)
app.get('/data-decode/:network/gaialog/:txid/:vout', async (req, res) => {
	try {
		const network = String(req.params.network || 'main').trim()
		const txid = String(req.params.txid || '').trim()
		const vout = Number(req.params.vout)
		if (!txid || !Number.isFinite(vout)) throw new Error('Invalid parameters')

		const key = `GET:${network}:${txid}:${vout}`
		const cached = getCache(key)
		if (cached) return res.type('text/html').send(cached)

		const hex = await fetchTxAndFindScriptHex(network, txid, vout)
		const decoded = validateGaiaLog(hex)
		const logoUrl = await resolveLogoDataUrl()
		const html = renderHtml({ txid, network, json: decoded.json, logoUrl })
		setCache(key, html)
		return res.type('text/html').send(html)
	} catch (e: any) {
		const rawVout = String(req.params.vout ?? '').trim()
		const vout = parseVout(rawVout)
		// A malformed vout is a bad request, not evidence about the transaction.
		const message = rawVout !== '' && vout === undefined
			? (e?.message ? String(e.message) : 'Invalid parameters')
			: await failureMessage(e, {
				network: String(req.params.network || 'main').trim(),
				txid: String(req.params.txid || '').trim(),
				vout,
			})
		const logoUrl = await resolveLogoDataUrl()
		const html = renderErrorHtml({ message, logoUrl })
		return res.type('text/html').status(200).send(html)
	}
})

app.post('/data-decode/gaialog', async (req, res) => {
	try {
		const body = req.body || {}
		const scriptHex = normaliseScriptHex(body?.script_hex)
		const network = String(body?.network || 'main').trim()
		if (!scriptHex) throw new Error('script_hex required')

		const key = `POST:data-decode:${network}:${hexCacheKey(scriptHex)}`
		const cached = getCache(key)
		if (cached) return res.type('text/html').send(cached)

		const decoded = validateGaiaLog(scriptHex)
		const logoUrl = await resolveLogoDataUrl()
		const html = renderHtml({ json: decoded.json, logoUrl })
		setCache(key, html)
		return res.type('text/html').send(html)
	} catch (e: any) {
		const logoUrl = await resolveLogoDataUrl()
		const html = renderErrorHtml({ message: e?.message || 'Decode error', logoUrl })
		return res.type('text/html').status(200).send(html)
	}
})

app.post('/', async (req, res) => {
	try {
		const body = req.body || {}
		const scriptHex = normaliseScriptHex(body?.script_hex)
		const network = String(body?.network || 'main').trim()
		const txid = typeof body?.txid === 'string' ? body.txid.trim() : undefined
		const vout = parseVout(body?.vout)
		const payloadJsonInput = body?.payload_json
		const buildFromPayload = typeof payloadJsonInput === 'string' && payloadJsonInput.trim().length > 0

		let hex = scriptHex
		// WoC may send the opened output's script alongside a txid. Prefer the
		// transaction so a change output does not hide the OP_RETURN, and fall
		// back to the supplied script when the lookup genuinely fails.
		if (txid && !buildFromPayload) {
			try {
				hex = await fetchTxAndFindScriptHex(network, txid, vout)
			} catch (lookupError) {
				if (!scriptHex) throw lookupError
				hex = scriptHex
			}
		}
		if (!hex) {
			if (buildFromPayload) {
				const buf = Buffer.from(String(payloadJsonInput), 'utf8')
				const extras: any[] = []
				const includeHash = body?.include_hash === true
				const useGzip = body?.gzip === true
				let dataBuf: any = buf
				if (useGzip) {
					const { gzipSync } = await import('zlib')
					dataBuf = gzipSync(buf)
				}
				if (includeHash) {
					const { createHash } = await import('crypto')
					const h = createHash('sha256').update(dataBuf).digest()
					extras.push(Buffer.from(h))
				}
				if (useGzip) extras.push('encoding=gzip')
				hex = buildOpFalseOpReturnWithTag({ tag: 'GaiaLog', version: 'v1', payload: dataBuf, extra: extras, useTrueReturn: false })
			} else {
				if (!txid) throw new Error('Provide script_hex, txid, or payload_json')
				hex = await fetchTxAndFindScriptHex(network, txid, vout)
			}
		}

		const key = `POST:${txid ?? 'hex'}:${hexCacheKey(hex)}`
		const cached = getCache(key)
		if (cached) return res.type('html').send(cached)

		const decoded = validateGaiaLog(hex)
		const logoUrl = await resolveLogoDataUrl()
		const html = renderHtml({ txid, network, json: decoded.json, logoUrl })
		setCache(key, html)
		return res.type('html').send(html)
	} catch (e: any) {
		const body = req.body || {}
		const message = await failureMessage(e, {
			scriptHex: String(body?.script_hex || ''),
			network: String(body?.network || 'main').trim(),
			txid: typeof body?.txid === 'string' ? body.txid.trim() : undefined,
			vout: parseVout(body?.vout),
		})
		const logoUrl = await resolveLogoDataUrl()
		const html = renderErrorHtml({ message, logoUrl })
		return res.type('html').status(200).send(html)
	}
})

/**
 * Start the HTTP listener only when this module is the process entry point.
 * Importing `server.js` (for tests or embedding) then has no side effect.
 */
export function startServer(port: number = PORT) {
	return app.listen(port, () => {
		console.log(`[GaiaLog Plugin] Listening on http://localhost:${port}`)
	})
}

const entryArg = (() => {
	const arg = process.argv[1] || ''
	return arg.replace(/\\/g, '/')
})()

if (/\/server\.(ts|js)$/.test(entryArg)) {
	startServer()
}

export { app }



