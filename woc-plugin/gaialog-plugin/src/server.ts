import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { promises as fs } from 'fs'
import { renderErrorHtml, renderHtml, renderHomeHtml } from './render'
import { parsePushes, validateGaiaLog } from './opreturn-validator'
import { buildOpFalseOpReturnWithTag } from './opreturn'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PORT = Number(process.env.PORT || 8787)
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

async function fetchTxAndFindScriptHex(network: string, txid: string, vout?: number): Promise<string> {
	const headers: Record<string, string> = {}
	if (WHATSONCHAIN_API_KEY) headers['woc-api-key'] = WHATSONCHAIN_API_KEY
	const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}`, { headers })
	if (!res.ok) throw new Error(`Failed to fetch TX: ${res.status}`)
	const j = await res.json()
	const outs = Array.isArray(j?.vout) ? j.vout : []

	if (typeof vout === 'number') {
		const o = outs.find((x: any) => x?.n === vout)
		const hex = o?.scriptPubKey?.hex
		if (typeof hex === 'string' && hex.length > 0) return hex
		throw new Error('Specified vout not found or missing script hex')
	}

	for (const o of outs) {
		const asm = String(o?.scriptPubKey?.asm || '')
		if (!asm.includes('OP_RETURN')) continue
		const hex = o?.scriptPubKey?.hex
		if (typeof hex !== 'string' || hex.length === 0) continue
		try {
			validateGaiaLog(hex)
			return hex
		} catch { /* try next */ }
	}
	throw new Error('No GaiaLog OP_RETURN output found')
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
		const scriptHex = String(req.query.script_hex || '').trim()
		const network = String(req.query.network || 'main').trim()
		const txid = String(req.query.txid || '').trim()
		const vout = req.query.vout !== undefined ? Number(req.query.vout) : undefined

		// Show home page if no parameters provided
		if (!scriptHex && !txid) {
			const logoUrl = await resolveLogoDataUrl()
			const html = renderHomeHtml({ logoUrl })
			return res.type('html').send(html)
		}

		let key = ''
		let hex = scriptHex
		if (!hex) {
			if (!txid) throw new Error('Provide script_hex or txid')
			key = `GET:${network}:${txid}:${Number.isFinite(vout) ? vout : -1}`
			const cached = getCache(key)
			if (cached) return res.type('html').send(cached)
			hex = await fetchTxAndFindScriptHex(network, txid, Number.isFinite(vout) ? vout : undefined)
		} else {
			key = `GET:hex:${hex.slice(0, 64)}`
			const cached = getCache(key)
			if (cached) return res.type('html').send(cached)
		}

		const decoded = validateGaiaLog(hex)
		const logoUrl = await resolveLogoDataUrl()
		const html = renderHtml({ txid, network, json: decoded.json, logoUrl })
		setCache(key, html)
		return res.type('html').send(html)
	} catch (e: any) {
		let message = e?.message || 'Decode error'
		try {
			const scriptHex = String(req.query.script_hex || '').trim()
			const network = String(req.query.network || 'main').trim()
			const txid = String(req.query.txid || '').trim()
			const vout = req.query.vout !== undefined ? Number(req.query.vout) : undefined
			const hex = scriptHex || (txid ? await fetchTxAndFindScriptHex(network, txid, Number.isFinite(vout) ? vout : undefined) : '')
			const detected = hex ? detectKnownNonGaia(hex) : null
			if (detected) message = detected.message
			else message = "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin."
		} catch {
			message = "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin."
		}
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
		const logoUrl = await resolveLogoDataUrl()
		const html = renderErrorHtml({ message: "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin.", logoUrl })
		return res.type('text/html').status(200).send(html)
	}
})

app.post('/data-decode/gaialog', async (req, res) => {
	try {
		const body = req.body || {}
		const scriptHex = String(body?.script_hex || '').trim()
		const network = String(body?.network || 'main').trim()
		if (!scriptHex) throw new Error('script_hex required')

		const key = `POST:data-decode:${network}:${scriptHex.slice(0, 64)}`
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
		const scriptHex = String(body?.script_hex || '').trim()
		const network = String(body?.network || 'main').trim()
		const txid = typeof body?.txid === 'string' ? body.txid : undefined
		const vout = Number.isFinite(body?.vout) ? Number(body.vout) : undefined
		const payloadJsonInput = body?.payload_json
		const buildFromPayload = typeof payloadJsonInput === 'string' && payloadJsonInput.trim().length > 0

		let hex = scriptHex
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

		const key = `POST:${txid ?? 'hex'}:${hex.slice(0, 64)}`
		const cached = getCache(key)
		if (cached) return res.type('html').send(cached)

		const decoded = validateGaiaLog(hex)
		const logoUrl = await resolveLogoDataUrl()
		const html = renderHtml({ txid, network, json: decoded.json, logoUrl })
		setCache(key, html)
		return res.type('html').send(html)
	} catch (e: any) {
		let message = e?.message || 'Decode error'
		try {
			const body = req.body || {}
			const scriptHex = String(body?.script_hex || '').trim()
			const network = String(body?.network || 'main').trim()
			const txid = typeof body?.txid === 'string' ? body.txid : undefined
			const vout = Number.isFinite(body?.vout) ? Number(body.vout) : undefined
			const hex = scriptHex || (txid ? await fetchTxAndFindScriptHex(network, txid, vout) : '')
			const detected = hex ? detectKnownNonGaia(hex) : null
			if (detected) message = detected.message
			else message = "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin."
		} catch {
			message = "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin."
		}
		const logoUrl = await resolveLogoDataUrl()
		const html = renderErrorHtml({ message, logoUrl })
		return res.type('html').status(200).send(html)
	}
})

app.listen(PORT, () => {
	console.log(`[GaiaLog Plugin] Listening on http://localhost:${PORT}`)
})



