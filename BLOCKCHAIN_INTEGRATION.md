# 🌍 GaiaLog Blockchain Integration

## Overview

GaiaLog integrates with the BSV (Bitcoin SV) blockchain to provide immutable, transparent environmental data logging. Every environmental measurement is cryptographically secured and stored on the blockchain with full public auditability.

## 🏗️ Architecture

### Core Components

1. **BSVWallet** (`lib/blockchain.ts`)
   - Manages BSV private key and address
   - Handles balance checking and UTXO management
   - Integrates with WhatsOnChain API

2. **BlockchainService** (`lib/blockchain.ts`)
   - Main service for blockchain operations
   - Handles transaction creation, signing, and broadcasting
   - Manages transaction logging and database storage

3. **DataCollector** (`lib/data-collector.ts`)
   - Collects environmental data from multiple APIs
   - Automatically writes data to blockchain
   - Supports air quality, water levels, seismic activity, and advanced metrics

4. **API Routes**
   - `/api/blockchain/write` - Write custom data to blockchain
   - `/api/blockchain/balance` - Check wallet balance
   - `/api/blockchain/transactions` - Get transaction history
   - `/api/data/collect` - Trigger environmental data collection

## 🔧 Setup

### 1. Environment Variables

Copy `env.template` to `.env.local` and configure:

```bash
# BSV Blockchain Configuration
BSV_PRIVATE_KEY=your_bsv_private_key_wif_format_here
WHATSONCHAIN_API_KEY=your_whatsonchain_api_key_here

# Environmental Data APIs
WAQI_API_KEY=your_waqi_api_key_here
OPENWEATHERMAP_API_KEY=your_openweathermap_api_key_here
USGS_API_KEY=your_usgs_api_key_here

# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Database Setup

Run the Supabase schema in your Supabase project:

```sql
-- Execute supabase-schema.sql in your Supabase SQL editor
```

### 4. BSV Wallet Setup

1. Create a BSV wallet (recommended: HandCash, MoneyButton, or ElectrumSV)
2. Export your private key in WIF format
3. Fund the wallet with at least 0.01 BSV for transaction fees
4. Add the private key to your `.env.local`

## 📊 Data Streams

### Supported Environmental Data Types

1. **Air Quality** (`air_quality`)
   - Source: WAQI API
   - Data: AQI, PM2.5, PM10, CO, NO2, O3
   - Location: London (configurable)

2. **Water Levels** (`water_levels`)
   - Source: UK Environment Agency API
   - Data: River levels, sea levels
   - Location: Thames (configurable)

3. **Seismic Activity** (`seismic_activity`)
   - Source: USGS Earthquake API
   - Data: Magnitude, depth, distance
   - Location: UK region

4. **Advanced Metrics** (`advanced_metrics`)
   - Source: OpenWeatherMap API
   - Data: Temperature, humidity, pressure, wind
   - Location: London (configurable)

## 🔗 API Usage

### Write Data to Blockchain

```typescript
// POST /api/blockchain/write
const response = await fetch('/api/blockchain/write', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    stream: 'custom_stream',
    payload: { key: 'value', timestamp: Date.now() }
  })
})

const result = await response.json()
// { success: true, txid: 'abc123...', stream: 'custom_stream', timestamp: 1234567890 }
```

### Check Wallet Balance

```typescript
// GET /api/blockchain/balance
const response = await fetch('/api/blockchain/balance')
const result = await response.json()
// { success: true, balance: 0.05, address: '1ABC...', warning: null }
```

### Get Transaction History

```typescript
// GET /api/blockchain/transactions?stream=air_quality&limit=10
const response = await fetch('/api/blockchain/transactions?stream=air_quality&limit=10')
const result = await response.json()
// { success: true, transactions: [...], count: 10 }
```

### Collect Environmental Data

```typescript
// POST /api/data/collect
const response = await fetch('/api/data/collect', { method: 'POST' })
const result = await response.json()
// { success: true, data: { airQuality: {...}, waterLevels: {...}, ... } }
```

## 🔒 Security Features

### Private Key Management
- Private keys stored securely in environment variables
- Never committed to version control
- WIF format for easy wallet integration

### Transaction Security
- All transactions signed with private key
- OP_RETURN data for immutable storage
- Change addresses for efficient UTXO management

### Database Security
- Row Level Security (RLS) enabled
- Public read access for transparency
- Authenticated write access for data integrity

## 📈 Monitoring & Maintenance

### Balance Monitoring
- Automatic balance checking before transactions
- Warning when balance < 0.01 BSV
- Transaction fee estimation (1000 satoshis per transaction)

### Transaction Logging
- Local transaction log for debugging
- Database storage for persistence
- Error tracking and reporting

### Data Verification
- Transaction verification via WhatsOnChain API
- Blockchain confirmation status tracking
- Public audit trail for all data

## 🚀 Deployment

### Production Considerations

1. **Environment Variables**
   - Use production Supabase project
   - Secure BSV private key storage
   - Configure production API keys

2. **Database**
   - Run schema in production Supabase
   - Configure RLS policies
   - Set up monitoring and alerts

3. **Monitoring**
   - Set up balance alerts
   - Monitor transaction success rates
   - Track API usage and costs

4. **Backup**
   - Regular wallet backup
   - Database backup strategy
   - Transaction log archiving

## 🔍 Troubleshooting

### Common Issues

1. **Insufficient Balance**
   ```
   Error: Insufficient balance for transaction
   Solution: Fund wallet with more BSV
   ```

2. **API Key Issues**
   ```
   Error: WAQI API error: 401 Unauthorized
   Solution: Check API key configuration
   ```

3. **Database Connection**
   ```
   Error: Failed to save to database
   Solution: Verify Supabase configuration
   ```

### Debug Commands

```bash
# Check wallet balance
curl http://localhost:3000/api/blockchain/balance

# View transaction history
curl http://localhost:3000/api/blockchain/transactions

# Test data collection
curl -X POST http://localhost:3000/api/data/collect
```

## 📚 Additional Resources

- [BSV Documentation](https://docs.bitcoinsv.io/)
- [WhatsOnChain API](https://docs.whatsonchain.com/)
- [WAQI API](https://aqicn.org/api/)
- [UK Environment Agency API](https://environment.data.gov.uk/flood-monitoring/doc/reference)
- [USGS Earthquake API](https://earthquake.usgs.gov/fdsnws/event/1/)
- [OpenWeatherMap API](https://openweathermap.org/api)

## 🤝 Contributing

When adding new data streams:

1. Add new stream type to `DataCollector`
2. Update database schema if needed
3. Add API route for the new stream
4. Update documentation and types
5. Test with blockchain integration

## 📄 License

This blockchain integration is part of the GaiaLog environmental monitoring platform.
