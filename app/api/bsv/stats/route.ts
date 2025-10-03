import { NextResponse } from 'next/server'
import { walletManager } from '@/lib/wallet-manager'
import { workerQueue } from '@/lib/worker-queue'
import { workerManager } from '@/lib/worker-threads'
import { bsvTransactionService } from '@/lib/bsv-transaction-service'
import { query } from '@/lib/db'
import { fetchMetricsStore } from '@/lib/metrics'

export async function GET() {
  try {
    // Get data from all services
    const walletInfo = walletManager.getAllWalletInfo()
    const queueStats = workerQueue.getQueueStats()
    const workerStats = workerManager.getWorkerStats()
    const transactionHistory = bsvTransactionService.getTransactionHistory()
    
    // Calculate overall statistics (prefer DB tx_log if available)
    let totalTransactions = Array.isArray(transactionHistory) ? transactionHistory.length : 0
    let completedFromDb = 0
    let failedFromDb = 0
    try {
      const rows = await query<{ total: number; completed: number; failed: number }>(
        `SELECT 
           count(*)::int as total,
           sum((status = 'pending')::int)::int as pending,
           sum((status = 'confirmed')::int)::int as completed,
           sum((status = 'failed')::int)::int as failed
         FROM tx_log
         WHERE collected_at > now() - interval '24 hours'`
      )
      if (rows && Array.isArray(rows.rows) && rows.rows[0]) {
        totalTransactions = rows.rows[0].total
        completedFromDb = rows.rows[0].completed
        failedFromDb = rows.rows[0].failed
      }
    } catch {
      // DB may be unconfigured; fall back to in-memory stats
    }

    const processingRate = queueStats.processingRate
    const denom = (failedFromDb + completedFromDb)
    const errorRate = denom > 0 ? (failedFromDb / denom) * 100 : queueStats.errorRate * 100
    const dailyCapacity = processingRate * 60 * 60 * 24
    
    // Calculate total balance across all wallets
    const totalBalance = walletInfo.reduce((sum, wallet) => sum + wallet.balance, 0)
    
    // Calculate total transactions from workers
    const totalWorkerTransactions = workerStats.reduce((sum, worker) => sum + worker.totalTransactions, 0)
    
    const httpMetrics = fetchMetricsStore.snapshot()

    return NextResponse.json({
      success: true,
      totalTransactions,
      processingRate,
      errorRate,
      dailyCapacity,
      totalBalance,
      totalWorkerTransactions,
      walletCount: walletInfo.length,
      runningWorkers: workerStats.filter(w => w.isRunning).length,
      queueSize: queueStats.totalItems,
      completedTransactions: completedFromDb || queueStats.completedItems || 0,
      failedTransactions: failedFromDb || queueStats.failedItems || 0,
      http: httpMetrics
    })
  } catch (error) {
    console.error('Error fetching BSV stats:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to fetch BSV statistics',
        totalTransactions: 0,
        processingRate: 0,
        errorRate: 0,
        dailyCapacity: 0,
        totalBalance: 0,
        totalWorkerTransactions: 0,
        walletCount: 0,
        runningWorkers: 0,
        queueSize: 0,
        completedTransactions: 0,
        failedTransactions: 0
      },
      { status: 500 }
    )
  }
}

