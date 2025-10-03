import { NextResponse } from "next/server"
export const runtime = 'nodejs'
import { dataCollector } from "@/lib/data-collector"

export async function GET() {
  try {
    const seismic = await dataCollector.collectSeismicData()
    if (!seismic) {
      return NextResponse.json({ error: "No seismic data" }, { status: 502 })
    }
    return NextResponse.json({
      timestamp: seismic.timestamp,
      recent_events: [
        {
          id: seismic.event_id,
          magnitude: seismic.magnitude,
          location: seismic.location,
          depth: seismic.depth,
          time: seismic.timestamp,
          coordinates: { lat: seismic.coordinates.lat, lon: seismic.coordinates.lon },
        },
      ],
      status: "active",
      source: seismic.source,
    })
  } catch (error) {
    console.error("Seismic API error:", error)
    return NextResponse.json({ error: "Failed to fetch seismic data" }, { status: 500 })
  }
}
