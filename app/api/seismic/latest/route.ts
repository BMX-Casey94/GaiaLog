import { NextResponse } from 'next/server'
import { findLatestByType } from '@/lib/woc-fetcher'
import { blockchainService } from '@/lib/blockchain'

export const runtime = 'nodejs'

// 45s in-memory cache
let seismicCache: { data: any | null; ts: number } = { data: null, ts: 0 }
const SEISMIC_TTL_MS = 45000
const DISABLE_WOC_READS = process.env.GAIALOG_DISABLE_WOC_READS === 'true'

export async function GET() {
	// Serve cached if fresh
	if (seismicCache.data && (Date.now() - seismicCache.ts) < SEISMIC_TTL_MS) {
		return NextResponse.json({ success: true, data: seismicCache.data, cached: true }, { status: 200 })
	}

	// Try local transaction log first to avoid WoC calls
	try {
		const local = blockchainService.getLocalTransactionLog()
		if (Array.isArray(local) && local.length > 0) {
			const items = local
				.filter((t) =>
					t.stream === 'seismic_activity' &&
					t.txid &&
					t.txid !== 'failed' &&
					/^[0-9a-fA-F]{64}$/.test(t.txid)
				)
				.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
			if (items.length > 0) {
				// Always use most recent; remain fixed until new data appears
				const pick = items[0]
				const p: any = pick.payload || {}
				const depthKm = p.depth ?? p.depth_km ?? 0
				const depthMiles = depthKm > 0 ? (depthKm * 0.621371) : null
				const data = {
					magnitude: p.magnitude ?? 0,
					depth: depthKm,
					depth_miles: depthMiles,
					latitude: p.latitude ?? null,
					longitude: p.longitude ?? null,
					location: p.location_ascii ?? p.location ?? 'Unknown',
					source: p.source || 'Unknown',
					timestamp: pick.timestamp ? new Date(pick.timestamp).toISOString() : new Date().toISOString(),
				}
				seismicCache = { data, ts: Date.now() }
				return NextResponse.json({ success: true, data, source: 'local-log' }, { status: 200 })
			}
		}
	} catch {}

	const timeoutPromise = new Promise((_, reject) =>
		setTimeout(() => reject(new Error('Request timeout')), 12000)
	)
	
	try {
		if (DISABLE_WOC_READS) {
			if (seismicCache.data) {
				return NextResponse.json({ success: true, stale: true, data: seismicCache.data }, { status: 200 })
			}
			return NextResponse.json({ success: false, message: 'No seismic activity transactions found' }, { status: 200 })
		}
		const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
		const latest = await Promise.race([
			findLatestByType(net, 'seismic_activity', 25),
			timeoutPromise
		]) as Awaited<ReturnType<typeof findLatestByType>>
		
		if (!latest) {
			if (seismicCache.data && (Date.now() - seismicCache.ts) < SEISMIC_TTL_MS) {
				return NextResponse.json({ success: true, stale: true, data: seismicCache.data }, { status: 200 })
			}
			return NextResponse.json({ success: false, message: 'No seismic activity transactions found' }, { status: 200 })
		}
		
		const payload = latest.payload || {}
		
		// Convert depth from km to miles if needed
		const depthKm = payload.depth ?? payload.depth_km ?? 0
		const depthMiles = depthKm > 0 ? (depthKm * 0.621371) : null
		
		const data = {
			magnitude: payload.magnitude ?? 0,
			depth: depthKm,
			depth_miles: depthMiles,
			latitude: payload.latitude ?? null,
			longitude: payload.longitude ?? null,
			location: payload.location_ascii ?? payload.location ?? 'Unknown',
			source: latest.provider || 'Unknown',
			timestamp: latest.timestamp || new Date().toISOString(),
		}

		seismicCache = { data, ts: Date.now() }

		return NextResponse.json({ success: true, data })
	} catch (error: any) {
		console.error('Seismic chain read error:', error.message || error)
		if (seismicCache.data && (Date.now() - seismicCache.ts) < SEISMIC_TTL_MS) {
			return NextResponse.json({ success: true, stale: true, data: seismicCache.data }, { status: 200 })
		}
		return NextResponse.json({ 
			success: false, 
			message: error.message?.includes('timeout') ? 'Request timed out' : 'Failed to fetch seismic data' 
		}, { status: 200 })
	}
}

