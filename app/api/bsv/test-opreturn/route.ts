import { NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    const payload = {
      app: 'GaiaLog',
      provider: 'test',
      schema_version: '1.0.0',
      timestamp: Date.now(),
      data_type: 'test',
      note: 'OP_FALSE OP_RETURN test write via ARC',
    }
    const txid = await blockchainService.writeToChain({
      stream: 'test-opreturn',
      timestamp: Date.now(),
      payload,
    })
    return NextResponse.json({ success: true, txid, woc: `https://whatsonchain.com/tx/${txid}` })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}

export async function GET(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    return NextResponse.json({
      success: true,
      usage: {
        method: 'POST',
        url: '/api/bsv/test-opreturn',
        description: 'Sends a single OP_FALSE OP_RETURN test transaction via ARC',
        body: 'No body required; uses a fixed demo payload',
        returns: '{ success, txid, woc }'
      }
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}


