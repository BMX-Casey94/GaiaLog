/**
 * Retention Maintenance Endpoint
 *
 * GET   /api/maintenance/retention             → execute the retention pass
 *                                                (Vercel Cron only supports GET)
 * GET   /api/maintenance/retention?plan=true   → dry-run plan only
 * POST  /api/maintenance/retention             → execute the retention pass
 * POST  /api/maintenance/retention?dryRun=true → dry-run plan only
 *
 * Auth (production):
 *   Either header:
 *     x-gaialog-internal-secret: <GAIALOG_INTERNAL_API_SECRET>
 *   Or Vercel Cron header (when scheduled by vercel.json):
 *     Authorization: Bearer <CRON_SECRET>
 *
 * In non-production environments the endpoint is open so it can be exercised
 * locally with `curl`.  All deletions are batched and bounded by the
 * RETENTION_* env knobs documented in lib/retention.ts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'
import { planRetention, runRetention } from '@/lib/retention'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

function timingSafeEqualString(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function authoriseRequest(req: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV !== 'production') return null

  const cronSecret = String(process.env.CRON_SECRET || '').trim()
  if (cronSecret) {
    const header = String(req.headers.get('authorization') || '').trim()
    if (header.startsWith('Bearer ')) {
      const token = header.slice(7).trim()
      if (token && timingSafeEqualString(token, cronSecret)) return null
    }
  }

  return requireInternalApiAccess(req)
}

function shouldDryRun(req: NextRequest, body?: unknown): boolean {
  try {
    const url = new URL(req.url)
    if (url.searchParams.get('plan') === 'true') return true
    if (url.searchParams.get('dryRun') === 'true') return true
  } catch {
    /* ignore malformed URL */
  }
  if (body && typeof body === 'object' && (body as { dryRun?: unknown }).dryRun === true) {
    return true
  }
  return false
}

async function planResponse() {
  const plan = await planRetention()
  const totals = {
    readingsEligible: plan.families.reduce((acc, f) => acc + f.eligibleForDeletion, 0),
    readingsTotal: plan.families.reduce((acc, f) => acc + f.totalRows, 0),
    readingsHighSeverityPreserved: plan.families.reduce(
      (acc, f) => acc + f.preservedHighSeverity,
      0,
    ),
    readingsLatestPerLocationPreserved: plan.families.reduce(
      (acc, f) => acc + f.preservedLatestPerLocation,
      0,
    ),
    txLogEligible: plan.txLog.eligibleForDeletion,
    utxoBlobsEligible: plan.utxoCompaction.removedRowsWithBlobs,
    utxoRowsEligibleForPrune: plan.utxoPrune.eligibleForDeletion,
  }
  return NextResponse.json({ success: true, mode: 'dry-run', totals, plan })
}

async function runResponse() {
  const result = await runRetention({ dryRun: false })
  const totals = {
    readingsDeleted: result.families.reduce((acc, f) => acc + f.deleted, 0),
    txLogDeleted: result.txLog.deleted,
    utxoRowsCompacted: result.utxoCompaction.rowsCompacted,
    utxoRowsPruned: result.utxoPrune.rowsDeleted,
  }
  return NextResponse.json({ success: true, mode: 'executed', totals, result })
}

export async function GET(req: NextRequest) {
  const denied = authoriseRequest(req)
  if (denied) return denied

  try {
    if (shouldDryRun(req)) return await planResponse()
    return await runResponse()
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown retention error',
      },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  const denied = authoriseRequest(req)
  if (denied) return denied

  const body = await req.json().catch(() => null)

  try {
    if (shouldDryRun(req, body)) return await planResponse()
    return await runResponse()
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown retention error',
      },
      { status: 500 },
    )
  }
}
