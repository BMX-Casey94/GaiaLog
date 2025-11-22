import { NextResponse } from 'next/server'
import { findLatestByType } from '@/lib/woc-fetcher'
import { blockchainService } from '@/lib/blockchain'

export const runtime = 'nodejs'

// 45s in-memory cache
let advancedMetricsCache: { data: any | null; ts: number } = { data: null, ts: 0 }
const ADVANCED_METRICS_TTL_MS = 45000
const DISABLE_WOC_READS = process.env.GAIALOG_DISABLE_WOC_READS === 'true'

export async function GET() {
	// Serve cached if fresh
	if (advancedMetricsCache.data && (Date.now() - advancedMetricsCache.ts) < ADVANCED_METRICS_TTL_MS) {
		return NextResponse.json({ success: true, data: advancedMetricsCache.data, cached: true }, { status: 200 })
	}

	// Try local transaction log first to avoid WoC calls
	try {
		const local = blockchainService.getLocalTransactionLog()
		if (Array.isArray(local) && local.length > 0) {
			const items = local
				.filter((t) =>
					t.stream === 'advanced_metrics' &&
					t.txid &&
					t.txid !== 'failed' &&
					/^[0-9a-fA-F]{64}$/.test(t.txid)
				)
				.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
			if (items.length > 0) {
				// Always use most recent; remain fixed until new data appears
				const pick = items[0]
				const p: any = pick.payload || {}
				const data = {
					environmental_quality_score: p.environmental_quality_score ?? null,
					uv_index: p.uv_index ?? null,
					humidity_pct: p.humidity_pct ?? null,
					pressure_mb: p.pressure_mb ?? null,
					temperature_c: p.temperature_c ?? null,
					wind_deg: p.wind_deg ?? null,
					wind_kph: p.wind_kph ?? null,
					location: p.location_ascii ?? p.location ?? 'Unknown',
					source: p.source || 'Unknown',
					timestamp: pick.timestamp ? new Date(pick.timestamp).toISOString() : new Date().toISOString(),
				}
				advancedMetricsCache = { data, ts: Date.now() }
				return NextResponse.json({ success: true, data, source: 'local-log' }, { status: 200 })
			}
		}
	} catch {}

	const timeoutPromise = new Promise((_, reject) =>
		setTimeout(() => reject(new Error('Request timeout')), 12000)
	)
	
	try {
		if (DISABLE_WOC_READS) {
			if (advancedMetricsCache.data) {
				return NextResponse.json({ success: true, stale: true, data: advancedMetricsCache.data }, { status: 200 })
			}
			return NextResponse.json({ success: false, message: 'No advanced metrics transactions found' }, { status: 200 })
		}
		const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
		const latest = await Promise.race([
			findLatestByType(net, 'advanced_metrics', 10),
			timeoutPromise
		]) as Awaited<ReturnType<typeof findLatestByType>>
		
		if (!latest) {
			if (advancedMetricsCache.data && (Date.now() - advancedMetricsCache.ts) < ADVANCED_METRICS_TTL_MS) {
				return NextResponse.json({ success: true, stale: true, data: advancedMetricsCache.data }, { status: 200 })
			}
			return NextResponse.json({ success: false, message: 'No advanced metrics transactions found' }, { status: 200 })
		}
		
		const payload = latest.payload || {}
		
		const data = {
			environmental_quality_score: payload.environmental_quality_score ?? null,
			uv_index: payload.uv_index ?? null,
			humidity_pct: payload.humidity_pct ?? null,
			pressure_mb: payload.pressure_mb ?? null,
			temperature_c: payload.temperature_c ?? null,
			wind_deg: payload.wind_deg ?? null,
			wind_kph: payload.wind_kph ?? null,
			location: payload.location_ascii ?? payload.location ?? 'Unknown',
			source: latest.provider || 'Unknown',
			timestamp: latest.timestamp || new Date().toISOString(),
		}

		advancedMetricsCache = { data, ts: Date.now() }

		return NextResponse.json({ success: true, data })
	} catch (error: any) {
		console.error('Advanced metrics chain read error:', error.message || error)
		if (advancedMetricsCache.data && (Date.now() - advancedMetricsCache.ts) < ADVANCED_METRICS_TTL_MS) {
			return NextResponse.json({ success: true, stale: true, data: advancedMetricsCache.data }, { status: 200 })
		}
		return NextResponse.json({ 
			success: false, 
			message: error.message?.includes('timeout') ? 'Request timed out' : 'Failed to fetch advanced metrics data' 
		}, { status: 200 })
	}
}

