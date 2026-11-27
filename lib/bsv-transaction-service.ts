/**
 * Deprecated transaction façade.
 *
 * ## Status
 *
 * Nothing in GaiaLog broadcasts through this module. `lib/blockchain.ts`
 * (`blockchainService.writeToChain`) is the single write path: it acquires a
 * UTXO from the inventory, signs with `lib/broadcast/tx-builder.ts` and submits
 * through `lib/broadcast/broadcaster-client.ts`. This module is retained only
 * because `/api/bsv/stats` reads `getTransactionHistory()` and other operational
 * surfaces read `isReady()` / `getStats()` / `getTransactionHistory()`; those
 * remain backwards-compatible and answer from the wallet manager.
 *
 * ## What was removed, and why
 *
 * The previous implementation fabricated success. `createBRC100Transaction`
 * returned a txid built from `Date.now()` and `Math.random()`, and
 * `validateTransaction` invented a confirmations count and a block height after
 * sixty seconds. A caller could therefore record a reading as written on-chain
 * while no transaction existed — the exact class of bug that produced rows in
 * `tx_log` pointing at txids no node had ever seen.
 *
 * `broadcastTransaction` now throws. A silent placeholder would be worse than a
 * loud failure: the loud failure stops a caller from believing a payment
 * happened.
 */

import { bsvConfig } from './bsv-config'
import { walletManager } from './wallet-manager'

export interface BSVTransactionData {
  type: string
  timestamp: number
  location: string
  measurement: any
  source_hash: string
  family?: string
  providerId?: string
  datasetId?: string
  sourceLabel?: string
  queueLane?: 'throughput' | 'coverage'
  maxInFlight?: number
  coordinates?: { lat: number; lon: number }
  stationId?: string
}

export interface BSVTransactionResult {
  success: boolean
  txid?: string
  error?: string
  retryCount?: number
  walletIndex?: number
  fee?: number
  timestamp?: number
}

export interface TransactionStatus {
  txid: string
  status: 'pending' | 'confirmed' | 'failed'
  confirmations: number
  blockHeight?: number
  timestamp: number
  error?: string
}

/** Raised by every write-shaped method on this deprecated module. */
const DEPRECATION_MESSAGE =
  'bsvTransactionService.broadcastTransaction is deprecated; use blockchainService.writeToChain'

export class BSVTransactionService {
  private isInitialized = false
  /**
   * Statuses reported by this module. Nothing writes to it any more — the
   * durable record of a broadcast is `tx_log` and `arc_broadcast_status` — so
   * it is always empty. Kept so `getTransactionHistory()` keeps its shape for
   * `/api/bsv/stats`.
   */
  private transactionHistory: Map<string, TransactionStatus> = new Map()

  constructor() {
    this.initialize()
  }

  private initialize(): void {
    if (!walletManager.isReady()) {
      this.isInitialized = false
      return
    }
    this.isInitialized = true
  }

  /**
   * Backwards-compatible readiness probe.
   *
   * Delegates to the wallet manager, which is what actually decides whether a
   * write can be signed. Lazy-initialises so a process that constructs this
   * module before the wallet manager is ready does not stay permanently false.
   */
  public isReady(): boolean {
    if (!this.isInitialized && walletManager.isReady()) {
      this.isInitialized = true
    }
    return this.isInitialized && walletManager.isReady()
  }

  /**
   * Deprecated. Builds nothing and throws.
   *
   * A BRC-100-shaped OP_RETURN with no inputs and a zero-satoshi change output
   * is not a transaction, and returning a fabricated txid for it is how a
   * reading gets recorded as on-chain without one existing. Callers must use
   * `blockchainService.writeToChain`.
   */
  public async createBRC100Transaction(_data: BSVTransactionData): Promise<BSVTransactionResult> {
    return {
      success: false,
      error: DEPRECATION_MESSAGE,
    }
  }

  /** Deprecated. Always throws; see the module comment. */
  public async broadcastTransaction(_transaction: unknown): Promise<BSVTransactionResult> {
    throw new Error(DEPRECATION_MESSAGE)
  }

  /**
   * Deprecated. Returns only what this module actually recorded, which is
   * nothing, rather than simulating confirmations over elapsed time.
   */
  public async validateTransaction(txid: string): Promise<TransactionStatus | null> {
    return this.transactionHistory.get(txid) ?? null
  }

  public getTransactionHistory(limit: number = 50): TransactionStatus[] {
    return Array.from(this.transactionHistory.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
  }

  public getPendingTransactions(): TransactionStatus[] {
    return Array.from(this.transactionHistory.values())
      .filter(tx => tx.status === 'pending')
  }

  public getConfirmedTransactions(): TransactionStatus[] {
    return Array.from(this.transactionHistory.values())
      .filter(tx => tx.status === 'confirmed')
  }

  /**
   * Backwards-compatible statistics for `/api/bsv/stats`.
   *
   * `averageConfirmations` is 0 when nothing has been confirmed; the previous
   * form divided over an empty array and produced NaN, which serialised into
   * the API response as `null`.
   */
  public getTransactionStats(): {
    total: number
    pending: number
    confirmed: number
    failed: number
    averageConfirmations: number
  } {
    const transactions = Array.from(this.transactionHistory.values())
    const total = transactions.length
    const pending = transactions.filter(tx => tx.status === 'pending').length
    const confirmed = transactions.filter(tx => tx.status === 'confirmed').length
    const failed = transactions.filter(tx => tx.status === 'failed').length

    const confirmedTxs = transactions.filter(tx => tx.status === 'confirmed')
    const averageConfirmations = confirmedTxs.length > 0
      ? confirmedTxs.reduce((sum, tx) => sum + tx.confirmations, 0) / confirmedTxs.length
      : 0

    return {
      total,
      pending,
      confirmed,
      failed,
      averageConfirmations,
    }
  }

  /**
   * Deprecated. Throws: a retry here would have no transaction to retry.
   *
   * The previous implementation slept for two seconds and then reported success
   * 80% of the time based on `Math.random()`.
   */
  public async retryFailedTransaction(_txid: string): Promise<BSVTransactionResult> {
    throw new Error(DEPRECATION_MESSAGE)
  }

  public clearTransactionHistory(): void {
    this.transactionHistory.clear()
  }
}

// Export singleton instance
export const bsvTransactionService = new BSVTransactionService()

/** Configured fee rate, exposed for operational reporting. */
export function getDeprecatedServiceFeeRate(): number {
  return bsvConfig.transaction.feeRate
}
