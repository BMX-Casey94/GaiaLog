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
			findLatestByType(net, 'seismic_activity', 20),
			timeoutPromise
		]) as Awaited<ReturnType<typeof findLatestByType>>
		
		if (!latest) {
			return NextResponse.json({ success: false, message: 'No seismic activity transactions found' }, { status: 200 })
		}
		
		const payload = latest.payload || {}
		
		// Convert depth from km to miles if needed
		const depthKm = payload.depth ?? payload.depth_km ?? 0
		const depthMiles = depthKm > 0 ? (depthKm * 0.621371) : null
		
		return NextResponse.json({
			success: true,
			data: {
				magnitude: payload.magnitude ?? 0,
				depth: depthKm,
				depth_miles: depthMiles,
				latitude: payload.latitude ?? null,
				longitude: payload.longitude ?? null,
				location: payload.location_ascii ?? payload.location ?? 'Unknown',
				source: latest.provider || 'Unknown',
				timestamp: latest.timestamp || new Date().toISOString(),
			}
		})
	} catch (error: any) {
		console.error('Seismic chain read error:', error.message || error)
		return NextResponse.json({ 
			success: false, 
			message: error.message?.includes('timeout') ? 'Request timed out' : 'Failed to fetch seismic data' 
		}, { status: 200 })
	}
}

