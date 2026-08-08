import { NextResponse } from 'next/server'
import { walletManager } from '@/lib/wallet-manager'
import { getBSVAddressUrl } from '@/lib/utils'
import { bsvConfig } from '@/lib/bsv-config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Lightweight public funding strip for the homepage.
 * Uses Bitails address balances (not WhatsOnChain wallet history lookups).
 */

const BITAILS_BASE = (process.env.BSV_BITAILS_API_BASE || 'https://api.bitails.io').replace(/\/$/, '')

// Public treasury addresses — same set shown elsewhere on the site. Used when
// walletManager is not initialised in the web process.
const FALLBACK_WALLETS: Array<{ index: number; address: string }> = [
  { index: 0, address: '13S6zUA88PtDNy9DKHZuh3QQmy4d4eN4Se' },
  { index: 1, address: '127HLeWpr66JU3SDmQJ9dmjBo6RgNsRU1w' },
  { index: 2, address: '1Jm2t7cmarKskV65UsigAr7tveS5WhPdJS' },
]

interface WalletFundingRow {
  index: number
  label: string
  address: string
  confirmedSats: number
  unconfirmedSats: number
  totalSats: number
  explorerUrl: string
  error?: string
}

async function fetchBitailsBalance(address: string): Promise<{ confirmed: number; unconfirmed: number }> {
  const res = await fetch(`${BITAILS_BASE}/address/${encodeURIComponent(address)}/balance`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`Bitails ${res.status}`)
  }
  const body = (await res.json()) as { confirmed?: number; unconfirmed?: number; summary?: number }
  return {
    confirmed: Number(body.confirmed ?? 0) || 0,
    unconfirmed: Number(body.unconfirmed ?? 0) || 0,
  }
}

function resolveWallets(): Array<{ index: number; address: string }> {
  try {
    if (walletManager.isReady()) {
      const fromManager = walletManager.getAllWalletInfo()
        .filter((w) => typeof w.address === 'string' && w.address.length > 0)
        .map((w) => ({ index: w.index, address: w.address }))
      if (fromManager.length > 0) return fromManager
    }
  } catch {}
  return FALLBACK_WALLETS
}

export async function GET() {
  const network = bsvConfig.network === 'mainnet' ? 'main' : 'test'
  const wallets = resolveWallets()

  const rows: WalletFundingRow[] = await Promise.all(
    wallets.map(async (w) => {
      const label = `W${w.index + 1}`
      try {
        const bal = await fetchBitailsBalance(w.address)
        const totalSats = bal.confirmed + bal.unconfirmed
        return {
          index: w.index,
          label,
          address: w.address,
          confirmedSats: bal.confirmed,
          unconfirmedSats: bal.unconfirmed,
          totalSats,
          explorerUrl: getBSVAddressUrl(w.address, network as 'main' | 'test'),
        }
      } catch (err) {
        return {
          index: w.index,
          label,
          address: w.address,
          confirmedSats: 0,
          unconfirmedSats: 0,
          totalSats: 0,
          explorerUrl: getBSVAddressUrl(w.address, network as 'main' | 'test'),
          error: err instanceof Error ? err.message : 'balance unavailable',
        }
      }
    }),
  )

  const totalSats = rows.reduce((sum, r) => sum + r.totalSats, 0)

  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      source: 'bitails',
      network: bsvConfig.network,
      totalSats,
      wallets: rows,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      },
    },
  )
}
