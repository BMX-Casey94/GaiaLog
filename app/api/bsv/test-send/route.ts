import { NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'

export const runtime = 'nodejs'

export async function POST(request: Request) {
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

export async function GET() {
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
