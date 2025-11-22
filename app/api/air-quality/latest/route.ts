import { NextResponse } from 'next/server'
import { findLatestByType } from '@/lib/woc-fetcher'
import { blockchainService } from '@/lib/blockchain'

export const runtime = 'nodejs'

// 45s in-memory cache to reduce WoC calls and smooth transient timeouts
let airQualityCache: { data: any | null; ts: number } = { data: null, ts: 0 }
const AIR_QUALITY_TTL_MS = 45000
const DISABLE_WOC_READS = process.env.GAIALOG_DISABLE_WOC_READS === 'true'

export async function GET() {
	// Serve cached data if fresh (<=45s)
	if (airQualityCache.data && (Date.now() - airQualityCache.ts) < AIR_QUALITY_TTL_MS) {
		return NextResponse.json({ success: true, data: airQualityCache.data, cached: true }, { status: 200 })
	}

	// Try local transaction log first to avoid WoC calls
	try {
		const local = blockchainService.getLocalTransactionLog()
		if (Array.isArray(local) && local.length > 0) {
			const items = local
				.filter((t) =>
					t.stream === 'air_quality' &&
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
					aqi: (p.air_quality_index ?? p.aqi ?? p.AQI ?? null) != null ? Number(p.air_quality_index ?? p.aqi ?? p.AQI) : null,
					pm25: (p.fine_particulate_matter_pm25 ?? p.pm25 ?? null) != null ? Number(p.fine_particulate_matter_pm25 ?? p.pm25) : null,
					pm10: (p.coarse_particulate_matter_pm10 ?? p.pm10 ?? null) != null ? Number(p.coarse_particulate_matter_pm10 ?? p.pm10) : null,
					location: (p.location_ascii ?? p.city ?? p.location) || 'Unknown',
					country: '',
					lat: 0,
					lon: 0,
					source: p.source || 'Unknown',
					timestamp: pick.timestamp ? new Date(pick.timestamp).toISOString() : new Date().toISOString(),
				}
				airQualityCache = { data, ts: Date.now() }
				return NextResponse.json({ success: true, data, source: 'local-log' }, { status: 200 })
			}
		}
	} catch {}

	// Timeout aligned with WoC internal abort (10s) with slight slack
	const timeoutPromise = new Promise((_, reject) =>
		setTimeout(() => reject(new Error('Request timeout')), 12000)
	)
	
	try {
		if (DISABLE_WOC_READS) {
			// With WoC reads disabled, serve stale if available or no-data
			if (airQualityCache.data) {
				return NextResponse.json({ success: true, stale: true, data: airQualityCache.data }, { status: 200 })
			}
			return NextResponse.json({ success: false, message: 'No air quality transactions found' }, { status: 200 })
		}
		const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
		const latest = await Promise.race([
			// Reduce scan depth for quicker responses
			findLatestByType(net, 'air_quality', 10),
			timeoutPromise
		]) as Awaited<ReturnType<typeof findLatestByType>>
		
		if (!latest) {
			// If we have recent cache, serve it as stale
			if (airQualityCache.data && (Date.now() - airQualityCache.ts) < AIR_QUALITY_TTL_MS) {
				return NextResponse.json({ success: true, stale: true, data: airQualityCache.data }, { status: 200 })
			}
			return NextResponse.json({ success: false, message: 'No air quality transactions found' }, { status: 200 })
		}
		
		const payload = latest.payload || {}
		
		const data = {
			// Normalize common AQI payload shapes (WAQI and internal)
			aqi: (payload.air_quality_index ?? payload.aqi ?? payload.AQI ?? null) != null
				? Number(payload.air_quality_index ?? payload.aqi ?? payload.AQI)
				: null,
			pm25: (payload.fine_particulate_matter_pm25 ?? payload.pm25 ?? null) != null
				? Number(payload.fine_particulate_matter_pm25 ?? payload.pm25)
				: null,
			pm10: (payload.coarse_particulate_matter_pm10 ?? payload.pm10 ?? null) != null
				? Number(payload.coarse_particulate_matter_pm10 ?? payload.pm10)
				: null,
			location: (payload.location_ascii ?? payload.city ?? payload.location) || 'Unknown',
			country: '',
			lat: 0,
			lon: 0,
			source: latest.provider || 'Unknown',
			timestamp: typeof latest.timestamp === 'number'
				? new Date(latest.timestamp).toISOString()
				: (latest.timestamp || new Date().toISOString()),
		}

		// refresh cache
		airQualityCache = { data, ts: Date.now() }

		return NextResponse.json({
			success: true,
			data
		})
	} catch (error: any) {
		console.error('Air quality chain read error:', error.message || error)
		// Serve stale if available
		if (airQualityCache.data && (Date.now() - airQualityCache.ts) < AIR_QUALITY_TTL_MS) {
			return NextResponse.json({ success: true, stale: true, data: airQualityCache.data }, { status: 200 })
		}
		return NextResponse.json({ 
			success: false, 
			message: error.message?.includes('timeout') ? 'Request timed out' : 'Failed to fetch air quality data' 
		}, { status: 200 }) // Return 200 even on error so UI doesn't break
	}
}
