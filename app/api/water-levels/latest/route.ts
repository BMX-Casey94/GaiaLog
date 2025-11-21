import { NextResponse } from 'next/server'
import { findLatestByType } from '@/lib/woc-fetcher'

export const runtime = 'nodejs'

export async function GET() {
	const timeoutPromise = new Promise((_, reject) => 
		setTimeout(() => reject(new Error('Request timeout')), 8000)
	)
	
	try {
		const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
		const latest = await Promise.race([
			findLatestByType(net, 'water_levels', 20),
			timeoutPromise
		]) as Awaited<ReturnType<typeof findLatestByType>>
		
		if (!latest) {
			return NextResponse.json({ success: false, message: 'No water level transactions found' }, { status: 200 })
		}
		
		const payload = latest.payload || {}
		
		return NextResponse.json({
			success: true,
			data: {
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
		})
	} catch (error: any) {
		console.error('Water levels chain read error:', error.message || error)
		return NextResponse.json({ 
			success: false, 
			message: error.message?.includes('timeout') ? 'Request timed out' : 'Failed to fetch water level data' 
		}, { status: 200 })
	}
}

