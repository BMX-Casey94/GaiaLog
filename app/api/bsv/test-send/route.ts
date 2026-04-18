import { NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    const body = await request.json().catch(() => ({})) as any
    const to = (body && body.to) || null
    const amount = typeof body.amount === 'number' ? Math.max(600, Math.floor(body.amount)) : 1000 // sats

    const from = (blockchainService as any).getAddress ? (blockchainService as any).getAddress() : null
    if (!from) {
      return NextResponse.json({ success: false, error: 'Wallet not initialized' }, { status: 400 })
    }

    const destination = to || from // default: send to self
    const txid = await (blockchainService as any).sendToAddress(destination, amount)

    return NextResponse.json({ success: true, txid, to: destination, amount })
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

export async function GET(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    const from = (blockchainService as any).getAddress ? (blockchainService as any).getAddress() : null
    if (!from) {
      return NextResponse.json({ success: false, error: 'Wallet not initialized' }, { status: 400 })
    }
    const txid = await (blockchainService as any).sendToAddress(from, 1000)
    return NextResponse.json({ success: true, txid, to: from, amount: 1000 })
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
