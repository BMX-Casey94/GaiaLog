import { NextResponse } from 'next/server'
import { fetchJsonWithRetry } from '@/lib/provider-fetch'
import { datasetConfigs, providerConfigs } from '@/lib/provider-registry'
import { buildRolloutGateStatus } from '@/lib/rollout-controls'
import { PROVIDER_DESCRIPTORS } from '@/lib/stream-registry'
import { throughputObservability } from '@/lib/throughput-observability'

export async function GET() {
  const throughput = throughputObservability.getSnapshot(60)
  const rollout = buildRolloutGateStatus(
    throughput.overall.projectedAcceptedPerDay,
    throughput.overall.projectedConfirmedPerDay,
  )

  const results: any = {
    weatherapi: { ok: false, message: '', status: null as null | number },
    waqi: { ok: false, message: '', status: null as null | number },
    owm: { ok: false, message: '', status: null as null | number },
  }

  // WeatherAPI test
  try {
    const key = process.env.WEATHERAPI_KEY
    if (!key) throw new Error('Missing WEATHERAPI_KEY')
    const data = await fetchJsonWithRetry<any>(`https://api.weatherapi.com/v1/current.json?key=${key}&q=London`, { retries: 1 })
    results.weatherapi.ok = true
    results.weatherapi.message = `Location: ${data?.location?.name || 'ok'}`
    results.weatherapi.status = 200
  } catch (e: any) {
    results.weatherapi.ok = false
    results.weatherapi.message = e?.message || 'error'
  }

  // WAQI test
  try {
    const token = process.env.WAQI_API_KEY
    if (!token) throw new Error('Missing WAQI_API_KEY')
    const data = await fetchJsonWithRetry<any>(`https://api.waqi.info/feed/London/?token=${token}`, { retries: 1 })
    const status = data?.status || 'unknown'
    if (status === 'ok') {
      results.waqi.ok = true
      results.waqi.message = `City: ${data?.data?.city?.name || 'ok'}`
      results.waqi.status = 200
    } else {
      throw new Error(`WAQI status=${status}`)
    }
  } catch (e: any) {
    results.waqi.ok = false
    results.waqi.message = e?.message || 'error'
  }

  // OpenWeatherMap (OWM) test
  try {
    const appid = process.env.OWM_API_KEY
    if (!appid) throw new Error('Missing OWM_API_KEY')
    // London coords
    const data = await fetchJsonWithRetry<any>(`https://api.openweathermap.org/data/2.5/air_pollution?lat=51.5074&lon=-0.1278&appid=${appid}`, { retries: 1 })
    if (data?.list) {
      results.owm.ok = true
      results.owm.message = `Items: ${data.list.length}`
      results.owm.status = 200
    } else {
      throw new Error('Unexpected OWM response')
    }
  } catch (e: any) {
    results.owm.ok = false
    results.owm.message = e?.message || 'error'
  }

  return NextResponse.json({
    results,
    rollout,
    throughput,
    controls: {
      providers: Object.values(providerConfigs).map(cfg => ({
        id: cfg.id,
        enabled: cfg.enabled,
        configuredEnabled: cfg.configuredEnabled,
        requestedRolloutGate: cfg.requestedRolloutGate,
        rolloutEnabled: cfg.rolloutEnabled,
        rollout: cfg.rollout,
        lane: cfg.queueLane,
        priority: cfg.defaultPriority,
        chunkSize: cfg.chunkSize,
        maxInFlight: cfg.maxInFlight,
        intervalMs: cfg.cadence.intervalMs,
        budgets: cfg.budgets,
        throughputClass: cfg.throughputClass,
        blockchainFriendly: cfg.blockchainFriendly,
        attributionRequired: cfg.attributionRequired || false,
        attributionText: PROVIDER_DESCRIPTORS[cfg.id].attributionText || null,
      })),
      datasets: Object.values(datasetConfigs).map(cfg => ({
        id: cfg.id,
        providerId: cfg.providerId,
        family: cfg.family,
        enabled: cfg.enabled,
        configuredEnabled: cfg.configuredEnabled,
        requestedRolloutGate: cfg.requestedRolloutGate,
        rolloutEnabled: cfg.rolloutEnabled,
        rollout: cfg.rollout,
        lane: cfg.queueLane,
        priority: cfg.defaultPriority,
        chunkSize: cfg.chunkSize,
        maxInFlight: cfg.maxInFlight,
        intervalMs: cfg.cadence.intervalMs,
        budgets: cfg.budgets,
      })),
    },
  })
}


