import { NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'

export const runtime = 'nodejs'

const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY

async function fetchJson(url: string) {
	const headers: Record<string, string> = {}
	if (WHATSONCHAIN_API_KEY) headers['woc-api-key'] = WHATSONCHAIN_API_KEY
	const res = await fetch(url, { headers, cache: 'no-store' })
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
	return res.json()
}

type Alert = {
	code: string
	severity: 'moderate' | 'high' | 'critical'
	message: string
	at: string
}

export async function GET() {
	try {
		const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
		const now = Date.now()
		const alerts: Alert[] = []

		// 1) Chain state and warnings (if exposed)
		try {
			const chaininfo = await fetchJson(`https://api.whatsonchain.com/v1/bsv/${net}/chaininfo`)
			const warnings = (chaininfo?.warnings || '').toString().trim()
			if (warnings) {
				alerts.push({
					code: 'node_warning',
					severity: 'critical',
					message: warnings,
					at: new Date().toISOString(),
				})
			}
			const mediantimeSec = Number(chaininfo?.mediantime || 0)
			if (Number.isFinite(mediantimeSec) && mediantimeSec > 0) {
				const mins = Math.max(0, (now - mediantimeSec * 1000) / 60000)
				if (mins >= 60) {
					alerts.push({
						code: 'stale_block',
						severity: 'critical',
						message: `Last median block time ~${Math.floor(mins)} mins ago`,
						at: new Date().toISOString(),
					})
				} else if (mins >= 30) {
					alerts.push({
						code: 'slow_blocks',
						severity: 'high',
						message: `Blocks delayed ~${Math.floor(mins)} mins`,
						at: new Date().toISOString(),
					})
				} else if (mins >= 10) {
					alerts.push({
						code: 'lagging_blocks',
						severity: 'moderate',
						message: `Blocks lagging ~${Math.floor(mins)} mins`,
						at: new Date().toISOString(),
					})
				}
			}
		} catch {
			// Chain info not critical; continue
		}

		// 2) Recent transactions for our writer address (no DB)
		let recentTxs: string[] = []
		try {
			const addr = blockchainService.getAddress()
			if (addr) {
				const base = `https://api.whatsonchain.com/v1/bsv/${net}/address/${addr}`
				let listRes = await fetch(`${base}/txs`, { cache: 'no-store' })
				if (listRes.status === 404) listRes = await fetch(`${base}/history`, { cache: 'no-store' })
				if (listRes.ok) {
					const raw = await listRes.json()
					const list: { tx_hash: string }[] = Array.isArray(raw)
						? (raw[0]?.tx_hash ? raw : (typeof raw[0] === 'string' ? raw.map((id: string) => ({ tx_hash: id })) : []))
						: []
					recentTxs = list.map(x => x.tx_hash).filter(Boolean).slice(0, 10)
				}
			}
		} catch {
			// Not fatal; keep empty
		}

		const severityRank: Record<Alert['severity'], number> = { critical: 3, high: 2, moderate: 1 }
		const body = {
			success: true,
			network: net as 'main' | 'test',
			generatedAt: new Date().toISOString(),
			alerts: alerts.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]),
			recentTxs,
		}
		return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
	} catch (e: any) {
		return NextResponse.json({
			success: true,
			network: process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test',
			generatedAt: new Date().toISOString(),
			alerts: [],
			recentTxs: [],
			error: e?.message || 'snapshot_failed',
		}, { headers: { 'Cache-Control': 'no-store' } })
	}
}



