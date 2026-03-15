import { NextResponse } from 'next/server'
import { datasetConfigs, providerConfigs } from '@/lib/provider-registry'
import { buildRolloutGateStatus } from '@/lib/rollout-controls'
import { PROVIDER_DESCRIPTORS } from '@/lib/stream-registry'
import { throughputObservability } from '@/lib/throughput-observability'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function parseWindow(value: string | null, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const window10m = parseWindow(searchParams.get('window10m'), 10)
    const window60m = parseWindow(searchParams.get('window60m'), 60)
    const last10m = throughputObservability.getSnapshot(window10m)
    const last60m = throughputObservability.getSnapshot(window60m)
    const rollout = buildRolloutGateStatus(
      last60m.overall.projectedAcceptedPerDay,
      last60m.overall.projectedConfirmedPerDay,
    )

    const providerMetrics = new Map(last60m.providers.map(provider => [provider.providerId, provider]))
    const datasetMetrics = new Map(last60m.datasets.map(dataset => [`${dataset.providerId}:${dataset.datasetId}`, dataset]))

    return NextResponse.json({
      success: true,
      generatedAt: new Date().toISOString(),
      rollout,
      windows: {
        last10m,
        last60m,
      },
      providers: Object.values(providerConfigs).map(config => ({
        id: config.id,
        label: config.purpose,
        enabled: config.enabled,
        configuredEnabled: config.configuredEnabled,
        requestedRolloutGate: config.requestedRolloutGate,
        rolloutEnabled: config.rolloutEnabled,
        rollout: config.rollout,
        lane: config.queueLane,
        priority: config.defaultPriority,
        throughputClass: config.throughputClass,
        kind: config.kind,
        blockchainFriendly: config.blockchainFriendly,
        attributionRequired: config.attributionRequired || false,
        attributionText: PROVIDER_DESCRIPTORS[config.id].attributionText || null,
        metrics: providerMetrics.get(config.id) || null,
      })),
      datasets: Object.values(datasetConfigs).map(config => ({
        id: config.id,
        providerId: config.providerId,
        label: config.displayName,
        family: config.family,
        enabled: config.enabled,
        configuredEnabled: config.configuredEnabled,
        requestedRolloutGate: config.requestedRolloutGate,
        rolloutEnabled: config.rolloutEnabled,
        rollout: config.rollout,
        lane: config.queueLane,
        priority: config.defaultPriority,
        kind: config.kind,
        blockchainFriendly: config.blockchainFriendly,
        metrics: datasetMetrics.get(`${config.providerId}:${config.id}`) || null,
      })),
      errors: last60m.errors,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
