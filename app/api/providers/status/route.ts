import { NextResponse } from 'next/server'
import { fetchJsonWithRetry } from '@/lib/provider-fetch'
import { fetchOwmJsonWithRotation, hasOwmApiKeys } from '@/lib/owm'
import { datasetConfigs, providerConfigs } from '@/lib/provider-registry'
import { buildRolloutGateStatus } from '@/lib/rollout-controls'
import { PROVIDER_DESCRIPTORS } from '@/lib/stream-registry'
import { throughputObservability } from '@/lib/throughput-observability'
import { ServerSwrCache } from '@/lib/server-swr-cache'

const probeCache = new ServerSwrCache<Record<string, { ok: boolean; message: string; status: number | null }>>(60_000)

async function runExternalProbes() {
  const results: Record<string, { ok: boolean; message: string; status: number | null }> = {
    weatherapi: { ok: false, message: '', status: null },
    waqi: { ok: false, message: '', status: null },
    owm: { ok: false, message: '', status: null },
  }

  await Promise.all([
    // WeatherAPI test
    (async () => {
      try {
        const key = process.env.WEATHERAPI_KEY
        if (!key) throw new Error('Missing WEATHERAPI_KEY')
        const data = await fetchJsonWithRetry<any>(`https://api.weatherapi.com/v1/current.json?key=${key}&q=London`, { retries: 1 })
        results.weatherapi = { ok: true, message: `Location: ${data?.location?.name || 'ok'}`, status: 200 }
      } catch (e: any) {
        results.weatherapi = { ok: false, message: e?.message || 'error', status: null }
      }
    })(),
    // WAQI test
    (async () => {
      try {
        const token = process.env.WAQI_API_KEY
        if (!token) throw new Error('Missing WAQI_API_KEY')
        const data = await fetchJsonWithRetry<any>(`https://api.waqi.info/feed/London/?token=${token}`, { retries: 1 })
        const status = data?.status || 'unknown'
        if (status === 'ok') {
          results.waqi = { ok: true, message: `City: ${data?.data?.city?.name || 'ok'}`, status: 200 }
        } else {
          throw new Error(`WAQI status=${status}`)
        }
      } catch (e: any) {
        results.waqi = { ok: false, message: e?.message || 'error', status: null }
      }
    })(),
    // OpenWeatherMap (OWM) test
    (async () => {
      try {
        if (!hasOwmApiKeys()) throw new Error('Missing OWM_API_KEY / OWM_API_KEYS')
        const data = await fetchOwmJsonWithRotation<any>(
          (apiKey) => `https://api.openweathermap.org/data/2.5/air_pollution?lat=51.5074&lon=-0.1278&appid=${apiKey}`,
          { retries: 1, providerId: 'owm' },
        )
        if (data?.list) {
          results.owm = { ok: true, message: `Items: ${data.list.length}`, status: 200 }
        } else {
          throw new Error('Unexpected OWM response')
        }
      } catch (e: any) {
        results.owm = { ok: false, message: e?.message || 'error', status: null }
      }
    })(),
  ])

  return results
}

export async function GET() {
  const throughput = throughputObservability.getSnapshot(60)
  const rollout = buildRolloutGateStatus(
    throughput.overall.projectedAcceptedPerDay,
    throughput.overall.projectedConfirmedPerDay,
  )

  const { value: results } = await probeCache.get(runExternalProbes)

  return NextResponse.json({
    results,
    rollout,
    throughput,
    controls: {
      providers: Object.values(providerConfigs).map(cfg => {
        const desc = PROVIDER_DESCRIPTORS[cfg.id]
        return {
          id: cfg.id,
          displayName: desc?.displayName ?? cfg.id,
          primaryFamily: desc?.primaryFamily ?? 'advanced_metrics',
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
          attributionText: (desc as { attributionText?: string })?.attributionText ?? null,
        }
      }),
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


