import { PrivateKey, PublicKey } from '@bsv/sdk'
import { bsvConfig } from './bsv-config'

export interface WalletInfo {
  index: number
  address: string
  publicKey: string
  balance: number
  lastUsed: Date
  transactionCount: number
}

export interface WalletBalance {
  walletIndex: number
  balance: number
  lastUpdated: Date
  isLow: boolean
}

export interface WalletAlert {
  type: 'low_balance' | 'high_usage' | 'error'
  walletIndex: number
  message: string
  timestamp: Date
}

export class WalletManager {
  private wallets: PrivateKey[] = []
  private walletInfo: Map<number, WalletInfo> = new Map()
  private currentWalletIndex = 0
  private isInitialized = false
  private alerts: WalletAlert[] = []

  constructor() {
    this.initialize()
  }

  private initialize(): void {
    try {
      if (bsvConfig.wallets.privateKeys.length === 0) {
        throw new Error(
          'No wallet private keys configured. Set BSV_WALLET_1_PRIVATE_KEY (and optionally _2 and _3) in your .env file. ' +
          'Generate keys with: node -e "console.log(require(\'@bsv/sdk\').PrivateKey.fromRandom().toWif())"'
        )
      }

      this.wallets = bsvConfig.wallets.privateKeys.map((privateKey, index) => {
        try {
          const wallet = PrivateKey.fromWif(privateKey)
          const publicKey = wallet.toPublicKey()
          const address = publicKey.toAddress()

          this.walletInfo.set(index, {
            index,
            address: address.toString(),
            publicKey: publicKey.toString(),
            balance: 0,
            lastUsed: new Date(),
            transactionCount: 0
          })

          return wallet
        } catch (error) {
          console.error(`Failed to initialize wallet ${index + 1}:`, error)
          throw error
        }
      })

      this.isInitialized = true
      console.log(`✅ Wallet Manager initialized with ${this.wallets.length} wallet(s)`)
    } catch (error) {
      console.error('❌ Failed to initialize Wallet Manager:', error)
      this.isInitialized = false
    }
  }

  public isReady(): boolean {
    return this.isInitialized && this.wallets.length > 0
  }

  public forceInitialize(): void {
    this.initialize()
  }

  public getWalletCount(): number {
    return this.wallets.length
  }

  public getCurrentNetwork(): string {
    return bsvConfig.network
  }

  public getNextWallet(): { wallet: PrivateKey; index: number } {
    if (!this.isReady()) {
      throw new Error('Wallet Manager not initialized')
    }

    // Skip zero-balance wallets when selecting
    let attempts = 0
    while (attempts < this.wallets.length) {
      const idx = this.currentWalletIndex
      const info = this.walletInfo.get(idx)
      this.currentWalletIndex = (this.currentWalletIndex + 1) % this.wallets.length
      attempts++
      if (info && info.balance > 0) {
        const wallet = this.wallets[idx]
        const index = idx

        // Update wallet info
        const walletInfo = this.walletInfo.get(index)
        if (walletInfo) {
          walletInfo.lastUsed = new Date()
          walletInfo.transactionCount++
          this.walletInfo.set(index, walletInfo)
        }
        return { wallet, index }
      }
    }
    // Fallback: return current even if zero (to avoid hard fail)
    const fallback = this.wallets[this.currentWalletIndex]
    const fbIndex = this.currentWalletIndex
    this.currentWalletIndex = (this.currentWalletIndex + 1) % this.wallets.length
    return { wallet: fallback, index: fbIndex }
  }

  public async updateWalletBalance(walletIndex: number, balance: number): Promise<void> {
    if (walletIndex >= this.wallets.length) {
      throw new Error(`Wallet index ${walletIndex} out of range`)
    }

    const walletInfo = this.walletInfo.get(walletIndex)
    if (walletInfo) {
      walletInfo.balance = balance
      this.walletInfo.set(walletIndex, walletInfo)

      // Check for low balance alert (suppress if zero and not primary)
      if (walletIndex === 0 || balance > 0) {
        if (balance < bsvConfig.wallets.alertThreshold) {
          this.addAlert({
            type: 'low_balance',
            walletIndex,
            message: `Wallet ${walletIndex + 1} balance is low: ${balance} satoshis`,
            timestamp: new Date()
          })
        }
      }
    }
  }

  public getWalletInfo(walletIndex: number): WalletInfo | undefined {
    return this.walletInfo.get(walletIndex)
  }

  public getAllWalletInfo(): WalletInfo[] {
    return Array.from(this.walletInfo.values())
  }

  public getWalletBalances(): WalletBalance[] {
    return Array.from(this.walletInfo.values()).map(info => ({
      walletIndex: info.index,
      balance: info.balance,
      lastUpdated: info.lastUsed,
      isLow: info.balance < bsvConfig.wallets.alertThreshold
    }))
  }

  public getTotalBalance(): number {
    return Array.from(this.walletInfo.values()).reduce((total, info) => total + info.balance, 0)
  }

  public getWalletAddress(walletIndex: number): string | undefined {
    const walletInfo = this.walletInfo.get(walletIndex)
    return walletInfo?.address
  }

  public getAllWalletAddresses(): string[] {
    return Array.from(this.walletInfo.values()).map(info => info.address)
  }

  public getTransactionCount(walletIndex: number): number {
    const walletInfo = this.walletInfo.get(walletIndex)
    return walletInfo?.transactionCount || 0
  }

  public getTotalTransactionCount(): number {
    return Array.from(this.walletInfo.values()).reduce((total, info) => total + info.transactionCount, 0)
  }

  public getUsageStats(): {
    totalTransactions: number
    averageTransactionsPerWallet: number
    mostUsedWallet: number
    leastUsedWallet: number
  } {
    const wallets = Array.from(this.walletInfo.values())
    const totalTransactions = this.getTotalTransactionCount()
    const averageTransactionsPerWallet = totalTransactions / wallets.length

    const mostUsedWallet = wallets.reduce((max, wallet) => 
      wallet.transactionCount > max.transactionCount ? wallet : max
    ).index

    const leastUsedWallet = wallets.reduce((min, wallet) => 
      wallet.transactionCount < min.transactionCount ? wallet : min
    ).index

    return {
      totalTransactions,
      averageTransactionsPerWallet,
      mostUsedWallet,
      leastUsedWallet
    }
  }

  private addAlert(alert: WalletAlert): void {
    this.alerts.push(alert)
    
    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100)
    }

    console.warn(`Wallet Alert: ${alert.message}`)
  }

  public getAlerts(limit: number = 10): WalletAlert[] {
    return this.alerts.slice(-limit)
  }

  public clearAlerts(): void {
    this.alerts = []
  }

  public getLowBalanceWallets(): WalletInfo[] {
    return Array.from(this.walletInfo.values()).filter(
      wallet => wallet.balance < bsvConfig.wallets.alertThreshold
    )
  }

  public getHealthyWallets(): WalletInfo[] {
    return Array.from(this.walletInfo.values()).filter(
      wallet => wallet.balance >= bsvConfig.wallets.minBalance
    )
  }

  public canProcessTransaction(): boolean {
    const healthyWallets = this.getHealthyWallets()
    return healthyWallets.length > 0
  }

  public getRecommendedWallet(): number | null {
    const healthyWallets = this.getHealthyWallets()
    if (healthyWallets.length === 0) {
      return null
    }

    // Return the wallet with the highest balance
    const bestWallet = healthyWallets.reduce((best, wallet) => 
      wallet.balance > best.balance ? wallet : best
    )

    return bestWallet.index
  }
}

// Persist singleton on globalThis to survive Next.js dev-mode module
// re-evaluations that would otherwise create duplicate wallet managers.
const _wmg = globalThis as any
if (!_wmg.__GAIALOG_WALLET_MANAGER__) {
  _wmg.__GAIALOG_WALLET_MANAGER__ = new WalletManager()
}
export const walletManager: WalletManager = _wmg.__GAIALOG_WALLET_MANAGER__
