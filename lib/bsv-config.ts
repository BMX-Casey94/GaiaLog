export interface BSVConfig {
  network: 'mainnet' | 'testnet'
  wallets: {
    privateKeys: string[]
    minBalance: number
    alertThreshold: number
  }
  transaction: {
    feeRate: number
    maxRetries: number
    retryDelayMs: number
  }
  queue: {
    maxTxPerSecond: number
    processingIntervalMs: number
    batchSize: number
    batchIntervalMs: number
    maxQueueSize: number
  }
  api: {
    mainnet: string
    testnet: string
    gorillaPoolArc: string
    arcApiKey: string
  }
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error'
    enableTransactionLogging: boolean
  }
  health: {
    checkIntervalMs: number
  }
}

export const bsvConfig: BSVConfig = {
  network: (process.env.BSV_NETWORK as 'mainnet' | 'testnet') || 'testnet',
  wallets: {
    privateKeys: [
      // Prefer primary key if provided
      process.env.BSV_PRIVATE_KEY || '',
      process.env.BSV_WALLET_1_PRIVATE_KEY || '',
      process.env.BSV_WALLET_2_PRIVATE_KEY || '',
      process.env.BSV_WALLET_3_PRIVATE_KEY || '',
    ].filter(key => key.length > 0), // Filter out empty keys
    minBalance: parseInt(process.env.BSV_MIN_WALLET_BALANCE || '10000000'),
    alertThreshold: parseInt(process.env.BSV_ALERT_BALANCE_THRESHOLD || '5000000'),
  },
  transaction: {
    // Operator standard 0.1025 sat/byte (102.5 sat/kB) — 2.5% above ARC ~100 sat/kB floor.
    feeRate: parseFloat(process.env.BSV_TX_FEE_RATE || '0.1025'),
    maxRetries: parseInt(process.env.BSV_MAX_TX_RETRIES || '3'),
    retryDelayMs: parseInt(process.env.BSV_RETRY_DELAY_MS || '1000'),
  },
  queue: {
    maxTxPerSecond: parseInt(process.env.BSV_MAX_TX_PER_SECOND || '200'),
    processingIntervalMs: parseInt(process.env.BSV_QUEUE_PROCESSING_INTERVAL_MS || '25'),
    batchSize: parseInt(process.env.BSV_BATCH_SIZE || '200'),
    batchIntervalMs: parseInt(process.env.BSV_BATCH_INTERVAL_MS || '1000'),
    maxQueueSize: parseInt(process.env.BSV_MAX_QUEUE_SIZE || '100000'),
  },
  api: {
    mainnet: process.env.BSV_API_ENDPOINT || 'https://arc.taal.com',
    testnet: process.env.BSV_TESTNET_API_ENDPOINT || 'https://arc-test.taal.com',
    gorillaPoolArc: process.env.BSV_GORILLAPOOL_ARC_ENDPOINT || 'https://arc.gorillapool.io',
    arcApiKey: process.env.BSV_ARC_API_KEY || '',
  },
  logging: {
    level: (process.env.BSV_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
    enableTransactionLogging: process.env.BSV_ENABLE_TRANSACTION_LOGGING === 'true',
  },
  health: {
    checkIntervalMs: parseInt(process.env.BSV_HEALTH_CHECK_INTERVAL_MS || '30000'),
  },
}

export function validateBSVConfig(): { isValid: boolean; errors: string[] } {
  const errors: string[] = []
  
  if (bsvConfig.wallets.privateKeys.length === 0) {
    errors.push('No BSV wallet private keys configured')
  }
  
  if (bsvConfig.wallets.privateKeys.length < 3) {
    errors.push(`Only ${bsvConfig.wallets.privateKeys.length} wallet(s) configured, 3 recommended for round-robin distribution`)
  }
  
  if (bsvConfig.transaction.feeRate <= 0) {
    errors.push('Transaction fee rate must be greater than 0')
  }
  
  if (bsvConfig.queue.maxTxPerSecond <= 0) {
    errors.push('Max transactions per second must be greater than 0')
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  }
}

export function getCurrentApiEndpoint(): string {
  return bsvConfig.network === 'mainnet' ? bsvConfig.api.mainnet : bsvConfig.api.testnet
}
