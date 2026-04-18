import { NextResponse } from 'next/server'
import { insertAirQuality, insertAdvanced, insertSeismic, insertWaterLevel, calculateSourceHash } from '@/lib/repositories'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  const results: Record<string, any> = {}
  try {
    // Seed Air Quality from WeatherAPI (London)
    try {
      if (!process.env.WEATHERAPI_KEY) throw new Error('WEATHERAPI_KEY missing')
      const resp = await fetch(`https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHERAPI_KEY}&q=London&aqi=yes`)
      if (!resp.ok) throw new Error(`WeatherAPI ${resp.status}`)
      const data = await resp.json()
      const aq = {
        provider: 'WeatherAPI.com',
        station_code: null,
        city: data.location?.name || 'London',
        lat: typeof data.location?.lat === 'number' ? data.location.lat : null,
        lon: typeof data.location?.lon === 'number' ? data.location.lon : null,
        aqi: data.current?.air_quality?.['us-epa-index'] || null,
        pm25: data.current?.air_quality?.['pm2_5'] || null,
        pm10: data.current?.air_quality?.['pm10'] || null,
        co: data.current?.air_quality?.['co'] || null,
        no2: data.current?.air_quality?.['no2'] || null,
        o3: data.current?.air_quality?.['o3'] || null,
        so2: null,
        temperature_c: data.current?.temp_c ?? null,
        humidity_pct: data.current?.humidity ?? null,
        pressure_mb: data.current?.pressure_mb ?? null,
        wind_kph: data.current?.wind_kph ?? null,
        wind_deg: data.current?.wind_degree ?? null,
        source: 'WeatherAPI.com',
        source_hash: calculateSourceHash({ type: 'seed_air', data }),
        collected_at: new Date(),
      }
      await insertAirQuality(aq)
      results.air_quality = 'inserted'
    } catch (e: any) {
      results.air_quality = `error: ${e?.message || e}`
    }

    // Seed Water Levels from NOAA (first station)
    try {
      const stations = await (await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels')).json()
      const s = stations?.stations?.[0]
      if (!s?.id) throw new Error('No station')
      const today = new Date().toISOString().slice(0, 10)
      const wl = await (await fetch(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${today}&end_date=${today}&station=${s.id}&product=water_level&datum=MLLW&time_zone=gmt&units=metric&format=json`)).json()
      const latest = wl?.data?.[wl.data.length - 1]
      if (!latest) throw new Error('No water level')
      const row = {
        provider: 'NOAA Tides & Currents',
        station_code: s.id,
        lat: typeof s.lat === 'number' ? s.lat : null,
        lon: typeof s.lng === 'number' ? s.lng : (typeof s.lon === 'number' ? s.lon : null),
        level_m: latest?.v != null ? Number(latest.v) : null,
        tide_height_m: null,
        wave_height_m: null,
        salinity_psu: null,
        dissolved_oxygen_mg_l: null,
        turbidity_ntu: null,
        current_speed_ms: null,
        current_direction_deg: null,
        wind_kph: null,
        wind_deg: null,
        source: 'NOAA Tides & Currents',
        source_hash: calculateSourceHash({ type: 'seed_water', station: s.id, latest }),
        collected_at: new Date(),
      }
      await insertWaterLevel(row)
      results.water_level = 'inserted'
    } catch (e: any) {
      results.water_level = `error: ${e?.message || e}`
    }

    // Seed Seismic from USGS (last 6h, mag>=2.5)
    try {
      const end = new Date().toISOString()
      const start = new Date(Date.now() - 6 * 3600 * 1000).toISOString()
      const usgs = await (await fetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&endtime=${end}&minmagnitude=2.5&orderby=time`)).json()
      const f = usgs?.features?.[0]
      if (!f) throw new Error('No events')
      const row = {
        provider: 'USGS Earthquake API',
        event_id: f.id ?? null,
        location: f.properties?.place ?? null,
        magnitude: typeof f.properties?.mag === 'number' ? f.properties.mag : null,
        depth_km: typeof f.geometry?.coordinates?.[2] === 'number' ? f.geometry.coordinates[2] : null,
        lat: typeof f.geometry?.coordinates?.[1] === 'number' ? f.geometry.coordinates[1] : null,
        lon: typeof f.geometry?.coordinates?.[0] === 'number' ? f.geometry.coordinates[0] : null,
        source_hash: calculateSourceHash({ type: 'seed_seismic', id: f.id }),
        collected_at: new Date(),
      }
      await insertSeismic(row)
      results.seismic = 'inserted'
    } catch (e: any) {
      results.seismic = `error: ${e?.message || e}`
    }

    // Seed Advanced from WeatherAPI (London)
    try {
      if (!process.env.WEATHERAPI_KEY) throw new Error('WEATHERAPI_KEY missing')
      const resp = await fetch(`https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHERAPI_KEY}&q=London&aqi=no`)
      if (!resp.ok) throw new Error(`WeatherAPI ${resp.status}`)
      const data = await resp.json()
      const humidity = data.current?.humidity ?? 0
      const soilMoisture = Math.max(0, Math.min(1, humidity / 100))
      const row = {
        provider: 'WeatherAPI-derived metrics',
        city: data.location?.name || 'London',
        lat: typeof data.location?.lat === 'number' ? data.location.lat : null,
        lon: typeof data.location?.lon === 'number' ? data.location.lon : null,
        uv_index: data.current?.uv ?? null,
        soil_moisture_pct: Math.round(soilMoisture * 100),
        wildfire_risk: 1,
        environmental_score: 100,
        temperature_c: data.current?.temp_c ?? null,
        humidity_pct: humidity ?? null,
        pressure_mb: data.current?.pressure_mb ?? null,
        wind_kph: data.current?.wind_kph ?? null,
        wind_deg: data.current?.wind_degree ?? null,
        source_hash: calculateSourceHash({ type: 'seed_advanced', data }),
        collected_at: new Date(),
      }
      await insertAdvanced(row)
      results.advanced = 'inserted'
    } catch (e: any) {
      results.advanced = `error: ${e?.message || e}`
    }

    return NextResponse.json({ success: true, results })
  } catch (error) {
    console.error('Seed error:', error)
    return NextResponse.json({ success: false, error: 'Seed failed' }, { status: 500 })
  }
}


