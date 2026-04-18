import { NextResponse } from 'next/server'
import { blockchainService } from '@/lib/blockchain'
import { requireInternalApiAccess } from '@/lib/internal-api-auth'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const denied = requireInternalApiAccess(request)
  if (denied) return denied

  try {
    const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
    const address: string | null = (blockchainService as any).getAddress ? (blockchainService as any).getAddress() : null
    let woc: any = null
    if (address) {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${net}/address/${address}/balance`)
      woc = await res.json()
    }
    const balance = await blockchainService.checkBalance()
    const lastError = (blockchainService as any).getLastError ? (blockchainService as any).getLastError() : null
    return NextResponse.json({ success: true, network: net, address, balance_bsv: balance, woc, lastError })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'error' }, { status: 500 })
  }
}


