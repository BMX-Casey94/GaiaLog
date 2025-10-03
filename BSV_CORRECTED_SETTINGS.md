# BSV Blockchain Integration - Corrected Settings & API

## 🔧 **Updated Environment Configuration**

Based on the [official BSV documentation](https://docs.bsvblockchain.org/guides/sdks/ts/getting_started_node_cjs), here are the corrected settings for your `.env.local` file:

```bash
# BSV Blockchain Configuration
# Network: mainnet or testnet
BSV_NETWORK=testnet

# BSV Wallet Private Keys (3 wallets for round-robin distribution)
# IMPORTANT: Keep these secure and never commit to version control
BSV_WALLET_1_PRIVATE_KEY=your_private_key_1_here
BSV_WALLET_2_PRIVATE_KEY=your_private_key_2_here
BSV_WALLET_3_PRIVATE_KEY=your_private_key_3_here

# Wallet Balance Thresholds (in satoshis)
# For 1M transactions/day: Each wallet needs significant balance
BSV_MIN_WALLET_BALANCE=10000000  # 0.1 BSV minimum balance per wallet
BSV_ALERT_BALANCE_THRESHOLD=5000000  # 0.05 BSV alert threshold

# Transaction Configuration
# For high-volume processing (1M/day = ~11.6 tx/sec average)
BSV_TX_FEE_RATE=1  # satoshis per byte (testnet = free)
BSV_MAX_TX_RETRIES=3
BSV_RETRY_DELAY_MS=1000  # Base delay for exponential backoff

# Queue Processing Configuration
# Optimized for 1M transactions per day capacity
BSV_MAX_TX_PER_SECOND=50  # Peak capacity (was 15 - too low)
BSV_QUEUE_PROCESSING_INTERVAL_MS=50  # Faster processing (was 100)

# High-Volume Processing Settings
# For 1M transactions/day optimization
BSV_BATCH_SIZE=100  # Process transactions in batches
BSV_BATCH_INTERVAL_MS=2000  # Process batches every 2 seconds
BSV_MAX_QUEUE_SIZE=10000  # Maximum queued transactions
BSV_HEALTH_CHECK_INTERVAL_MS=30000  # Check wallet health every 30 seconds

# API Endpoints - CORRECTED for BSV (not BTC)
# TAAL ARC (Advanced Relay Client) - Official BSV API
BSV_API_ENDPOINT=https://api.taal.com/arc
BSV_TESTNET_API_ENDPOINT=https://api.taal.com/arc

# ARC API Key - Get from https://console.taal.com
# Required for broadcasting transactions
BSV_ARC_API_KEY=your_arc_api_key_here

# Logging Configuration
BSV_LOG_LEVEL=info  # debug, info, warn, error
BSV_ENABLE_TRANSACTION_LOGGING=true
```

## 🔍 **Key Corrections Made**

### 1. **API Endpoints Fixed:**
- ❌ **Old (Wrong)**: `https://api.bitindex.network` (BTC service)
- ✅ **New (Correct)**: `https://api.taal.com/arc` (BSV ARC service)

### 2. **BSV SDK API Updated:**
- **Import**: `const { PrivateKey, P2PKH, Transaction, ARC } = require('@bsv/sdk')`
- **Transaction Creation**: `new Transaction(version, inputs, outputs)`
- **Broadcasting**: `await tx.broadcast(new ARC(endpoint, apiKey))`

### 3. **High-Volume Processing Optimized:**
- **Transaction Rate**: `15 tx/sec` → `50 tx/sec` (peak capacity)
- **Processing Interval**: `100ms` → `50ms` (faster processing)
- **Batch Processing**: Added for efficiency
- **Queue Size**: Added `10,000` max queued transactions

## 📊 **Capacity Analysis for 1M Transactions/Day:**

- **Average Rate**: 11.6 transactions/second
- **Peak Rate**: 50 transactions/second (4x buffer)
- **Processing**: 50ms intervals (20 batches/second)
- **Batch Size**: 100 transactions per batch
- **Total Capacity**: 50 × 60 × 60 × 24 = **4.32M transactions/day** (4x headroom)

## 🔑 **ARC API Key Setup**

To get your ARC API key:

1. **Visit**: https://console.taal.com
2. **Sign up** for a free account
3. **Generate** an API key
4. **Add** the key to your `.env.local` file

## 📋 **Updated Code Structure**

### Import Statement:
```typescript
import { PrivateKey, P2PKH, Transaction, ARC } from '@bsv/sdk'
```

### Transaction Creation:
```typescript
const version = 1
const inputs = [] // UTXOs will be added here
const outputs = [
  {
    lockingScript: new P2PKH().lock(publicKey.toHash()),
    change: true
  }
]

const transaction = new Transaction(version, inputs, outputs)
await transaction.fee()
await transaction.sign()
```

### Broadcasting:
```typescript
const arc = new ARC('https://api.taal.com/arc', apiKey)
await transaction.broadcast(arc)
```

## ⚠️ **Important Notes**

### Testnet vs Mainnet:
- **Testnet**: No real fees, perfect for development
- **Mainnet**: Real BSV fees apply
- **ARC API**: Works for both testnet and mainnet

### Wallet Funding:
- **Testnet**: Use BSV testnet faucets
- **Mainnet**: Fund with real BSV
- **Minimum**: 0.1 BSV per wallet for 1M transactions/day

### Rate Limiting:
- **ARC API**: Has rate limits
- **Production**: Consider enterprise plans for high volume
- **Monitoring**: Track API usage and limits

## 🚀 **Next Steps**

1. **Update your `.env.local`** with the corrected settings
2. **Get an ARC API key** from https://console.taal.com
3. **Test the updated configuration**
4. **Proceed to Phase 3**: Worker Thread Architecture

## 📚 **References**

- [Official BSV SDK Documentation](https://docs.bsvblockchain.org/guides/sdks/ts/getting_started_node_cjs)
- [TAAL ARC Console](https://console.taal.com)
- [BSV Network Information](https://bitcoinsv.io/)

