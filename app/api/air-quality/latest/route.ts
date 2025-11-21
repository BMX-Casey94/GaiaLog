import { NextResponse } from 'next/server'
import { findLatestByType } from '@/lib/woc-fetcher'

export const runtime = 'nodejs'

export async function GET() {
	// Add aggressive timeout protection (8 seconds max)
	const timeoutPromise = new Promise((_, reject) => 
		setTimeout(() => reject(new Error('Request timeout')), 8000)
	)
	
	try {
		const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
		const latest = await Promise.race([
			findLatestByType(net, 'air_quality', 20),
			timeoutPromise
		]) as Awaited<ReturnType<typeof findLatestByType>>
		
		if (!latest) {
			return NextResponse.json({ success: false, message: 'No air quality transactions found' }, { status: 200 })
		}
		
		const payload = latest.payload || {}
		
		return NextResponse.json({
			success: true,
			data: {
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
		})
	} catch (error: any) {
		console.error('Air quality chain read error:', error.message || error)
		return NextResponse.json({ 
			success: false, 
			message: error.message?.includes('timeout') ? 'Request timed out' : 'Failed to fetch air quality data' 
		}, { status: 200 }) // Return 200 even on error so UI doesn't break
	}
}
