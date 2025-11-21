import { NextResponse } from 'next/server'
import { getAllWalletAddresses, fetchWalletTransactions, fetchTxOpReturn } from '@/lib/woc-fetcher'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
    const addresses = getAllWalletAddresses()
    
    if (addresses.length === 0) {
      return NextResponse.json({ 
        error: 'No wallet addresses found',
        hint: 'Check BSV_WALLET_*_PRIVATE_KEY environment variables'
      }, { status: 500 })
    }
    
    const results: any = {
      network: net,
      walletsFound: addresses.length,
      walletAddresses: addresses,
      transactions: [] as any[],
    }
    
    // Test all wallets to see which ones have transactions
    results.walletResults = []
    
    for (const testAddr of addresses) {
      const walletResult: any = {
        address: testAddr,
        transactionsFound: 0,
        sampleTxids: [] as string[],
        decodedTransactions: [] as any[],
        errors: [] as string[],
      }
      
      try {
        console.log(`[Debug] Testing wallet ${testAddr.substring(0, 10)}...`)
        const txs = await fetchWalletTransactions(net, testAddr, 20)
        walletResult.transactionsFound = txs.length
        walletResult.sampleTxids = txs.slice(0, 5).map(t => t.tx_hash)
        
        console.log(`[Debug] Found ${txs.length} transactions for ${testAddr.substring(0, 10)}...`)
        
        // Try to decode first 10 transactions
        for (const tx of txs.slice(0, 10)) {
          try {
            const decoded = await fetchTxOpReturn(net, tx.tx_hash, testAddr)
            if (decoded) {
              walletResult.decodedTransactions.push({
                txid: tx.tx_hash,
                data_type: decoded.data_type,
                hasPayload: !!decoded.payload,
                timestamp: decoded.timestamp,
                provider: decoded.provider,
              })
            }
          } catch (err: any) {
            walletResult.errors.push(`Failed to decode ${tx.tx_hash.substring(0, 12)}...: ${err.message}`)
          }
        }
      } catch (error: any) {
        walletResult.errors.push(error.message)
        walletResult.stack = error.stack
      }
      
      results.walletResults.push(walletResult)
      
      // Also update main results with first wallet's data for backwards compatibility
      if (results.walletResults.length === 1) {
        results.transactionsFound = walletResult.transactionsFound
        results.sampleTxids = walletResult.sampleTxids
        results.transactions = walletResult.decodedTransactions
      }
    }
    
    return NextResponse.json(results, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error: any) {
    return NextResponse.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 })
  }
}

