import { NextResponse } from 'next/server'
import { walletManager } from '@/lib/wallet-manager'
import { query } from '@/lib/db'
import { bsvConfig } from '@/lib/bsv-config'

export const runtime = 'nodejs'

export async function GET() {
  try {
    // Get all wallet information (addresses)
    const walletInfo = walletManager.getAllWalletInfo()
    const net = bsvConfig.network === 'mainnet' ? 'main' : 'test'

    // Refresh balances from WhatsOnChain (confirmed + unconfirmed), in satoshis
    const refreshed = await Promise.all(
      walletInfo.map(async (wallet, index) => {
        try {
          const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${net}/address/${wallet.address}/balance`)
          const json = await res.json()
          const balanceSat = (json?.confirmed ?? 0) + (json?.unconfirmed ?? 0)
          await walletManager.updateWalletBalance(index, balanceSat)
          // derive tx count from tx_log for this wallet index
          let txCount = 0
          try {
            const r = await query<{ count: string }>(
              'SELECT COUNT(*)::text as count FROM tx_log WHERE wallet_index = $1',
              [index]
            )
            txCount = Number(r.rows?.[0]?.count || '0')
          } catch {}
          return {
            index,
            address: wallet.address,
            balance: balanceSat,
            lastUsed: typeof (wallet as any).lastUsed === 'number' ? (wallet as any).lastUsed : new Date(wallet.lastUsed).getTime(),
            transactionCount: txCount,
          }
        } catch {
          // fallback to in-memory
          let txCount = 0
          try {
            const r = await query<{ count: string }>(
              'SELECT COUNT(*)::text as count FROM tx_log WHERE wallet_index = $1',
              [index]
            )
            txCount = Number(r.rows?.[0]?.count || '0')
          } catch {}
          return {
            index,
            address: wallet.address,
            balance: wallet.balance,
            lastUsed: typeof (wallet as any).lastUsed === 'number' ? (wallet as any).lastUsed : new Date(wallet.lastUsed).getTime(),
            transactionCount: txCount,
          }
        }
      })
    )

    return NextResponse.json({
      success: true,
      wallets: refreshed,
      totalBalance: walletManager.getTotalBalance(),
      walletCount: walletManager.getWalletCount()
    })
  } catch (error) {
    console.error('Error fetching wallet data:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to fetch wallet data',
        wallets: []
      },
      { status: 500 }
    )
  }
}

