import { NextResponse } from 'next/server'
import { getSpendSourceStatus } from '@/lib/spend-source'
import { fetchTreasuryOverlayInventorySnapshot } from '@/lib/utxo-overlay-monitor'
import {
  getMaintainerMinConfirmations,
  getMinSpendConfirmations,
  getQueueGateMinConfirmations,
} from '@/lib/utxo-spend-policy'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Protected JSON snapshot for operators: overlay treasury counts vs spend policy.
 * Set GAIALOG_UTXO_HEALTH_SECRET (≥8 chars) and send header x-gaialog-utxo-health-secret.
 */
export async function GET(request: Request) {
  const expected = process.env.GAIALOG_UTXO_HEALTH_SECRET
  if (!expected || expected.length < 8) {
    return NextResponse.json(
      { ok: false, error: 'GAIALOG_UTXO_HEALTH_SECRET is not set or too short (min 8 characters).' },
      { status: 503 },
    )
  }

  const provided = request.headers.get('x-gaialog-utxo-health-secret') || ''
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  }

  try {
    const spendSource = getSpendSourceStatus()
    const inventory = await fetchTreasuryOverlayInventorySnapshot()

    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      policy: {
        minSpendConfirmations: getMinSpendConfirmations(),
        queueGateMinConfirmations: getQueueGateMinConfirmations(),
        maintainerMinConfirmations: getMaintainerMinConfirmations(),
        spendSourceMode: spendSource.mode,
        activeImplementation: spendSource.activeImplementation,
        overlayLookupConfigured: spendSource.overlayLookupConfigured,
        overlaySubmitConfigured: spendSource.overlaySubmitConfigured,
        emptyDriftRetryEnabled: process.env.BSV_OVERLAY_EMPTY_DRIFT_RETRY !== 'false',
      },
      spendSourceWallets: spendSource.wallets,
      treasuryInventory: inventory,
    })
  } catch (error) {
    console.error('UTXO health error:', error)
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
