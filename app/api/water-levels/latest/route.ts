import { NextResponse } from 'next/server'
import { findLatestByType } from '@/lib/woc-fetcher'
import { blockchainService } from '@/lib/blockchain'

export const runtime = 'nodejs'

// 45s in-memory cache
let waterLevelsCache: { data: any | null; ts: number } = { data: null, ts: 0 }
const WATER_LEVELS_TTL_MS = 45000
const DISABLE_WOC_READS = process.env.GAIALOG_DISABLE_WOC_READS === 'true'

export async function GET() {
	// Serve cached if fresh
	if (waterLevelsCache.data && (Date.now() - waterLevelsCache.ts) < WATER_LEVELS_TTL_MS) {
		return NextResponse.json({ success: true, data: waterLevelsCache.data, cached: true }, { status: 200 })
	}

	// Try local transaction log first to avoid WoC calls
	try {
		const local = blockchainService.getLocalTransactionLog()
		if (Array.isArray(local) && local.length > 0) {
			const items = local
				.filter((t) =>
					t.stream === 'water_levels' &&
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
					level: p.river_level ?? p.sea_level ?? p.level_m ?? 0,
					river_level: p.river_level ?? p.level_m ?? 0,
					sea_level: p.sea_level ?? null,
					water_temperature_c: p.water_temperature_c ?? null,
					tide_height: p.tide_height ?? null,
					wave_height_m: p.wave_height_m ?? null,
					salinity_psu: p.salinity_psu ?? null,
					turbidity_ntu: p.turbidity_ntu ?? null,
					location: p.location_ascii ?? p.location ?? 'Unknown',
					source: p.source || 'Unknown',
					timestamp: pick.timestamp ? new Date(pick.timestamp).toISOString() : new Date().toISOString(),
				}
				waterLevelsCache = { data, ts: Date.now() }
				return NextResponse.json({ success: true, data, source: 'local-log' }, { status: 200 })
			}
		}
	} catch {}

	const timeoutPromise = new Promise((_, reject) =>
		setTimeout(() => reject(new Error('Request timeout')), 12000)
	)
	
	try {
		if (DISABLE_WOC_READS) {
			if (waterLevelsCache.data) {
				return NextResponse.json({ success: true, stale: true, data: waterLevelsCache.data }, { status: 200 })
			}
			return NextResponse.json({ success: false, message: 'No water level transactions found' }, { status: 200 })
		}
		const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
		const latest = await Promise.race([
			findLatestByType(net, 'water_levels', 10),
			timeoutPromise
		]) as Awaited<ReturnType<typeof findLatestByType>>
		
		if (!latest) {
			if (waterLevelsCache.data && (Date.now() - waterLevelsCache.ts) < WATER_LEVELS_TTL_MS) {
				return NextResponse.json({ success: true, stale: true, data: waterLevelsCache.data }, { status: 200 })
			}
			return NextResponse.json({ success: false, message: 'No water level transactions found' }, { status: 200 })
		}
		
		const payload = latest.payload || {}
		
		const data = {
			level: payload.river_level ?? payload.sea_level ?? payload.level_m ?? 0,
			river_level: payload.river_level ?? payload.level_m ?? 0,
			sea_level: payload.sea_level ?? null,
			water_temperature_c: payload.water_temperature_c ?? null,
			tide_height: payload.tide_height ?? null,
			wave_height_m: payload.wave_height_m ?? null,
			salinity_psu: payload.salinity_psu ?? null,
			turbidity_ntu: payload.turbidity_ntu ?? null,
			location: payload.location_ascii ?? payload.location ?? 'Unknown',
			source: latest.provider || 'Unknown',
			timestamp: latest.timestamp || new Date().toISOString(),
		}

		waterLevelsCache = { data, ts: Date.now() }

		return NextResponse.json({ success: true, data })
	} catch (error: any) {
		console.error('Water levels chain read error:', error.message || error)
		if (waterLevelsCache.data && (Date.now() - waterLevelsCache.ts) < WATER_LEVELS_TTL_MS) {
			return NextResponse.json({ success: true, stale: true, data: waterLevelsCache.data }, { status: 200 })
		}
		return NextResponse.json({ 
			success: false, 
			message: error.message?.includes('timeout') ? 'Request timed out' : 'Failed to fetch water level data' 
		}, { status: 200 })
	}
}

