import { PrivateKey, P2PKH, Transaction, ARC } from '@bsv/sdk'
import { bsvConfig, getCurrentApiEndpoint } from './bsv-config'
import { walletManager } from './wallet-manager'
import { APP_NAME, SCHEMA_VERSION } from './constants'

export interface BSVTransactionData {
  type: string
  timestamp: number
  location: string
  measurement: any
  source_hash: string
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

export class BSVTransactionService {
  private isInitialized = false
  private transactionHistory: Map<string, TransactionStatus> = new Map()

  constructor() {
    this.initialize()
  }

  private initialize(): void {
    try {
      if (!walletManager.isReady()) {
        throw new Error('Wallet Manager not ready')
      }
      this.isInitialized = true
      console.log('BSV Transaction Service initialized')
    } catch (error) {
      console.error('Failed to initialize BSV Transaction Service:', error)
      this.isInitialized = false
    }
  }

  public isReady(): boolean {
    if (!this.isInitialized && walletManager.isReady()) {
      // Lazy-init once wallet manager is ready
      this.isInitialized = true
      try { console.log('BSV Transaction Service initialized') } catch {}
    }
    return this.isInitialized && walletManager.isReady()
  }

  public async createBRC100Transaction(data: BSVTransactionData): Promise<BSVTransactionResult> {
    if (!this.isReady()) {
      return {
        success: false,
        error: 'BSV Transaction Service not initialized'
      }
    }

    try {
      // Get next wallet for round-robin distribution
      const { wallet, index } = walletManager.getNextWallet()
      
      // Create BRC-100 compliant transaction
      const transaction = await this.buildBRC100Transaction(wallet, data)
      
      // Calculate transaction fee
      const fee = this.calculateTransactionFee(transaction)
      
      // For now, return success without broadcasting (we'll implement broadcasting later)
      const txid = this.generatePlaceholderTxid()
      
      // Store transaction status
      this.transactionHistory.set(txid, {
        txid,
        status: 'pending',
        confirmations: 0,
        timestamp: Date.now()
      })

      return {
        success: true,
        txid,
        walletIndex: index,
        fee,
        timestamp: Date.now()
      }

    } catch (error) {
      console.error('Failed to create BRC-100 transaction:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  private async buildBRC100Transaction(wallet: PrivateKey, data: BSVTransactionData): Promise<Transaction> {
    // Create BRC-100 protocol data according to the specification
    const provider = (data as any)?.measurement?.source || 'unknown'
    const protocolData = {
      protocol: "BRC-100",
      action: "mint",
      data: {
        app: APP_NAME,
        schema_version: SCHEMA_VERSION,
        provider,
        type: data.type,
        timestamp: data.timestamp,
        location: data.location,
        measurement: data.measurement
      }
    }
    
    // Convert protocol data to JSON string
    const protocolJson = JSON.stringify(protocolData)
    const protocolBuffer = Buffer.from(protocolJson, 'utf8')
    
    // Create OP_RETURN script using GaiaLog envelope tag ("GaiaLog", "v1")
    const { buildOpFalseOpReturnWithTag } = await import('./opreturn')
    const scriptHex = buildOpFalseOpReturnWithTag({
      tag: 'GaiaLog',
      version: 'v1',
      payload: protocolBuffer,
      extra: [],
      useTrueReturn: false,
    })
    const opReturnScript = Buffer.from(scriptHex, 'hex')
    
    // For now, create a placeholder transaction structure
    // In a real implementation, we would:
    // 1. Fetch UTXOs for the wallet
    // 2. Create proper inputs and outputs
    // 3. Use the official BSV SDK Transaction constructor
    
    const version = 1
    const inputs = [] // Would be populated with actual UTXOs
    const outputs = [
      {
        lockingScript: opReturnScript, // OP_RETURN output with BRC-100 data
        satoshis: 0 // OP_RETURN outputs have 0 satoshis
      },
      {
        lockingScript: new P2PKH().lock(wallet.toPublicKey().toHash()),
        satoshis: 0, // Placeholder - would be calculated based on UTXOs
        change: true
      }
    ]
    
    const transaction = new Transaction(version, inputs, outputs)
    
    // Note: In a real implementation, we would:
    // 1. Add proper UTXO inputs
    // 2. Calculate proper change amount
    // 3. Sign the transaction with the wallet's private key
    
    return transaction
  }

  private calculateTransactionFee(transaction: Transaction): number {
    // Calculate transaction size and fee
    // For now, return a placeholder fee
    const estimatedSize = 200 // bytes (placeholder)
    return estimatedSize * bsvConfig.transaction.feeRate
  }

  private generatePlaceholderTxid(): string {
    // Generate a placeholder transaction ID
    // In real implementation, this would be the actual transaction hash
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 15)
    return `${timestamp}_${random}`
  }

  public async broadcastTransaction(transaction: Transaction): Promise<BSVTransactionResult> {
    try {
      // Use the official BSV ARC (Advanced Relay Client) for broadcasting
      if (!bsvConfig.api.arcApiKey) {
        return {
          success: false,
          error: 'ARC API key not configured'
        }
      }
      
      const arc = new ARC(getCurrentApiEndpoint(), bsvConfig.api.arcApiKey)
      
      // Broadcast using the official BSV SDK
      const result = await transaction.broadcast(arc)
      
      if (result.success) {
        const txid = result.txid || this.generatePlaceholderTxid()
        
        this.transactionHistory.set(txid, {
          txid,
          status: 'pending',
          confirmations: 0,
          timestamp: Date.now()
        })
        
        return {
          success: true,
          txid,
          timestamp: Date.now()
        }
      } else {
        return {
          success: false,
          error: result.error || 'Transaction broadcast failed'
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Broadcasting failed'
      }
    }
  }

  public async validateTransaction(txid: string): Promise<TransactionStatus | null> {
    const status = this.transactionHistory.get(txid)
    if (!status) {
      return null
    }

    // Simulate transaction validation
    if (status.status === 'pending') {
      // Simulate confirmation over time
      const timeSinceCreation = Date.now() - status.timestamp
      if (timeSinceCreation > 60000) { // 1 minute
        status.status = 'confirmed'
        status.confirmations = 6
        status.blockHeight = Math.floor(Math.random() * 1000000) + 800000
        this.transactionHistory.set(txid, status)
      }
    }

    return status
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
      averageConfirmations
    }
  }

  public async retryFailedTransaction(txid: string): Promise<BSVTransactionResult> {
    const status = this.transactionHistory.get(txid)
    if (!status || status.status !== 'failed') {
      return {
        success: false,
        error: 'Transaction not found or not failed'
      }
    }

    // Simulate retry
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    const success = Math.random() > 0.2 // 80% success rate for retries
    
    if (success) {
      status.status = 'pending'
      status.confirmations = 0
      status.timestamp = Date.now()
      this.transactionHistory.set(txid, status)
      
      return {
        success: true,
        txid,
        timestamp: Date.now()
      }
    } else {
      return {
        success: false,
        error: 'Retry failed'
      }
    }
  }

  public clearTransactionHistory(): void {
    this.transactionHistory.clear()
  }
}

// Export singleton instance
export const bsvTransactionService = new BSVTransactionService()
