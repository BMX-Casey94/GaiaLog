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
			findLatestByType(net, 'advanced_metrics', 20),
			timeoutPromise
		]) as Awaited<ReturnType<typeof findLatestByType>>
		
		if (!latest) {
			return NextResponse.json({ success: false, message: 'No advanced metrics transactions found' }, { status: 200 })
		}
		
		const payload = latest.payload || {}
		
		return NextResponse.json({
			success: true,
			data: {
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
		})
	} catch (error: any) {
		console.error('Advanced metrics chain read error:', error.message || error)
		return NextResponse.json({ 
			success: false, 
			message: error.message?.includes('timeout') ? 'Request timed out' : 'Failed to fetch advanced metrics data' 
		}, { status: 200 })
	}
}

