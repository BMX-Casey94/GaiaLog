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

/**
 * Default transaction fee rate in satoshis per byte (150 sat/kB).
 *
 * Matches `env.template`. The live broadcaster/ARC floor is 100 sat/kB
 * (0.1 sat/byte); 0.15 clears it with headroom for the small fee bumps ARC
 * applies internally, so a default deployment is never rejected as
 * under-paying.
 */
export const DEFAULT_TX_FEE_RATE = 0.15

const KNOWN_NETWORKS = ['mainnet'] as const
type KnownNetwork = (typeof KNOWN_NETWORKS)[number]

function parseFiniteNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(String(raw ?? '').trim())
  return Number.isFinite(parsed) ? parsed : fallback
}
/**
 * Resolve the BSV network, mainnet only.
 *
 * GaiaLog is a mainnet-only application. Testnet is not a supported runtime:
 * writing readings to testnet produces data that will never be anchored on the
 * chain the explorer reads, and a mistaken switch is silent. `BSV_NETWORK` may
 * therefore only be `mainnet`.
 *
 * Fail closed in production: an explicit non-mainnet value throws so no process
 * can start and no write can reach a chain the operator did not intend. In
 * development the value is logged and the resolved network stays mainnet.
 */
function resolveNetwork(): KnownNetwork {
  const raw = String(process.env.BSV_NETWORK ?? '').trim().toLowerCase()
  if (!raw) return 'mainnet'
  if (raw === 'mainnet') return 'mainnet'

  const policyMessage =
    `BSV_NETWORK="${process.env.BSV_NETWORK}" is not permitted: GaiaLog runs on mainnet only. ` +
    `Set BSV_NETWORK=mainnet (or unset it) before starting any process.`

  if (process.env.NODE_ENV === 'production') {
    // Fail closed rather than silently reading/writing the wrong chain.
    throw new Error(policyMessage)
  }

  console.error(`❌ ${policyMessage} Continuing on mainnet for this non-production process.`)
  return 'mainnet'
}

/**
 * Collect wallet private keys, de-duplicated.
 *
 * `BSV_PRIVATE_KEY` is a legacy alias for the first wallet. When both it and
 * `BSV_WALLET_1_PRIVATE_KEY` hold the same WIF, the naive array produced a
 * duplicate entry, which `WalletManager` turned into a phantom fourth wallet
 * with the same address as W1. Round-robin selection then handed the same
 * address out twice, so two "wallets" competed for one set of UTXOs.
 */
function resolvePrivateKeys(): string[] {
  const candidates = [
    process.env.BSV_PRIVATE_KEY,
    process.env.BSV_WALLET_1_PRIVATE_KEY,
    process.env.BSV_WALLET_2_PRIVATE_KEY,
    process.env.BSV_WALLET_3_PRIVATE_KEY,
  ]

  const seen = new Set<string>()
  const keys: string[] = []
  for (const candidate of candidates) {
    const trimmed = String(candidate ?? '').trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    keys.push(trimmed)
  }
  return keys
}

export const bsvConfig: BSVConfig = {
  network: resolveNetwork(),
  wallets: {
    privateKeys: resolvePrivateKeys(),
    minBalance: parseInt(process.env.BSV_MIN_WALLET_BALANCE || '10000000'),
    alertThreshold: parseInt(process.env.BSV_ALERT_BALANCE_THRESHOLD || '5000000'),
  },
  transaction: {
    // BSV_TX_FEE_RATE_SAT_PER_BYTE is the explicit name; BSV_TX_FEE_RATE is the
    // historical alias kept for existing .env files.
    feeRate: parseFiniteNumber(
      process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE
        || process.env.BSV_TX_FEE_RATE
        || String(DEFAULT_TX_FEE_RATE),
      DEFAULT_TX_FEE_RATE,
    ),
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

  if (bsvConfig.network !== 'mainnet') {
    errors.push(`BSV network must be mainnet (resolved: ${bsvConfig.network})`)
  }

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
