import { NextRequest, NextResponse } from 'next/server'
import { validateGaiaLog, parsePushes } from '@/lib/opreturn-validator'
import { promises as fs } from 'fs'
import path from 'path'
import { renderHtml, renderErrorHtml } from '../../../route'

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

export async function GET(
	req: NextRequest,
	{ params }: { params: { network: string; txid: string; vout: string } }
) {
	try {
		const network = String(params.network || 'main').trim()
		const txid = String(params.txid || '').trim()
		const vout = Number(params.vout)
		if (!txid || !Number.isFinite(vout)) throw new Error('Invalid parameters')

		const key = `GET:${network}:${txid}:${vout}`
		const cached = getCache(key)
		if (cached) return new NextResponse(cached, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

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
		return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
	} catch (e: any) {
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
			txid: params.txid,
			network: params.network,
			message: "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin.",
			logoUrl,
		})
		return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 })
	}
}

