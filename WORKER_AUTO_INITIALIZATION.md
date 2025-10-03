# Worker Auto-Initialization System

## Overview

GaiaLog now includes an automatic worker initialization system designed specifically for serverless deployments like Vercel. This system ensures that environmental data collection workers and blockchain transaction processing start automatically when the application is deployed, without requiring manual intervention.

## How It Works

### Automatic Startup Mechanisms

The system uses **three layers** of initialization to ensure workers start reliably:

#### 1. **Bootstrap on App Load** (Primary)
- Workers automatically initialize when the app first loads
- Implemented via `lib/worker-bootstrap.ts` imported in `app/layout.tsx`
- Runs with a 2-second delay to allow proper app initialization
- Safe to run in all environments (development, staging, production)

#### 2. **Vercel Cron Jobs** (Backup)
- Configured in `vercel.json` to ping `/api/workers/auto-start` every 10 minutes
- Ensures workers stay active and restart if they stop
- No configuration needed - works automatically on Vercel

#### 3. **Manual Endpoints** (Fallback)
- Multiple API routes available for manual initialization
- Can be called after deployment or during debugging

## API Endpoints

### 1. `/api/workers/auto-start` (GET or POST)
**Primary auto-start endpoint**
- Initializes all workers automatically
- Safe to call multiple times (idempotent)
- Returns current worker status
- Used by Vercel cron jobs

**Example:**
```bash
curl https://your-app.vercel.app/api/workers/auto-start
```

**Response:**
```json
{
  "success": true,
  "message": "Workers initialized and running",
  "status": {
    "initialized": true,
    "workersRunning": 4,
    "totalWorkers": 4,
    "queueSize": 0,
    "walletCount": 3,
    "hasPrivateKeys": true,
    "network": "testnet"
  },
  "timestamp": "2025-10-03T12:00:00.000Z"
}
```

### 2. `/api/workers/status` (GET)
**Check worker status**
- Returns detailed status of all workers
- Query param: `?autoStart=true` to auto-start if not initialized
- Useful for health checks and monitoring

**Example:**
```bash
curl https://your-app.vercel.app/api/workers/status?autoStart=true
```

### 3. `/api/warmup` (GET or POST)
**Warmup endpoint for post-deployment**
- Designed for deployment hooks
- Allows up to 60 seconds for initialization
- Returns detailed timing information

**Example:**
```bash
curl https://your-app.vercel.app/api/warmup
```

### 4. `/api/bsv/init` (POST)
**Original initialization endpoint (maintained for compatibility)**
- Still available for manual initialization
- Now uses the centralized auto-init module
- Same functionality as before

## Deployment to Vercel

### Step 1: Configure Environment Variables

In your Vercel project settings, add these environment variables:

**Required:**
```bash
# Database
DATABASE_URL=your_postgres_connection_string
SUPABASE_DB_URL=your_supabase_direct_url

# BSV Blockchain
BSV_PRIVATE_KEY=your_primary_wallet_private_key
BSV_WALLET_1_PRIVATE_KEY=your_wallet_1_private_key
BSV_WALLET_2_PRIVATE_KEY=your_wallet_2_private_key
BSV_WALLET_3_PRIVATE_KEY=your_wallet_3_private_key
BSV_ARC_API_KEY=your_arc_api_key
BSV_NETWORK=testnet  # or mainnet

# External APIs
WAQI_API_KEY=your_waqi_api_key
WEATHER_API_KEY=your_weather_api_key
```

**Optional:**
```bash
BSV_MAX_TX_PER_SECOND=50
BSV_QUEUE_PROCESSING_INTERVAL_MS=25
BSV_LOG_LEVEL=info
```

### Step 2: Deploy

Deploy normally to Vercel:

```bash
vercel --prod
```

Or push to your connected Git repository.

### Step 3: Verify Workers Started

After deployment completes, check the worker status:

```bash
curl https://your-app.vercel.app/api/workers/status
```

You should see:
```json
{
  "success": true,
  "status": {
    "initialized": true,
    "workersRunning": 4,
    "workersTotal": 4
  }
}
```

## What Gets Started Automatically

When the system initializes, it starts:

1. **Environmental Data Workers:**
   - `waqi-environmental` - Air quality data collection
   - `noaa-weather` - Weather and water level data
   - `usgs-seismic` - Earthquake monitoring
   - `advanced-metrics` - Advanced environmental calculations

2. **Blockchain Services:**
   - Wallet Manager - BSV wallet initialization
   - Transaction Queue - Blockchain transaction processing
   - UTXO Maintainer - Automatic UTXO splitting and management

3. **Provider Configuration:**
   - API rate limits
   - Data collection budgets
   - Cursor management for incremental fetching

## Monitoring

### Check Worker Status
```bash
curl https://your-app.vercel.app/api/workers/status
```

### View Vercel Logs
```bash
vercel logs --follow
```

Look for these initialization messages:
```
🚀 Auto-initializing GaiaLog workers...
✅ Provider budgets initialized
💼 Initializing wallet manager...
✅ Wallet manager initialized
🚀 Starting worker threads...
✅ Worker threads started
🔧 Starting UTXO maintainer...
✅ UTXO maintainer started
🔄 Starting queue processing...
✅ Queue processing started
✅ Worker auto-initialization completed successfully
```

## Troubleshooting

### Workers Not Starting

**Problem:** Workers don't start automatically after deployment.

**Solution:**
1. Check Vercel logs for errors: `vercel logs`
2. Verify environment variables are set correctly
3. Manually trigger initialization:
   ```bash
   curl -X POST https://your-app.vercel.app/api/warmup
   ```

### Private Keys Missing

**Problem:** Error message about missing private keys.

**Solution:**
- The system will use test keys automatically in development
- For production, set `BSV_PRIVATE_KEY` and related wallet keys in Vercel environment variables
- **Never commit private keys to your repository**

### Workers Keep Stopping

**Problem:** Workers initialize but stop after a while.

**Solution:**
- This is normal in serverless environments due to cold starts
- The Vercel cron job (every 10 minutes) will restart them automatically
- Workers will also restart on the next request to any API endpoint

### High API Rate Limit Usage

**Problem:** External API rate limits being exceeded.

**Solution:**
- Adjust provider budgets in environment variables
- Workers collect data based on configured intervals
- Check `lib/provider-registry.ts` for budget settings

## Architecture Details

### Worker Lifecycle

```
Deployment
    ↓
App Initializes
    ↓
Bootstrap Module Loads (2s delay)
    ↓
Auto-Initialize Workers
    ↓
Workers Run Continuously
    ↓
[Optional] Cron Job Pings Every 10 Minutes
    ↓
Workers Continue Running
```

### Serverless Considerations

**Cold Starts:**
- Workers may stop during cold starts
- Bootstrap and cron jobs ensure they restart quickly
- First request after cold start may take longer

**Execution Limits:**
- Vercel functions have a maximum execution time
- Workers are designed to handle interruptions gracefully
- Queue is persisted to database, so no transactions are lost

**Memory:**
- Worker processes are lightweight
- Multiple workers share resources efficiently
- Monitor memory usage in Vercel dashboard

## Advanced Configuration

### Disable Auto-Initialization (if needed)

If you want to manually control worker startup:

1. Remove the import from `app/layout.tsx`:
```typescript
// Comment out or remove this line:
// import "@/lib/worker-bootstrap"
```

2. Remove or modify `vercel.json` cron configuration

3. Manually start workers after deployment:
```bash
curl -X POST https://your-app.vercel.app/api/bsv/init
```

### Custom Initialization Logic

You can use the `worker-auto-init` module in your own code:

```typescript
import { 
  autoInitializeWorkers, 
  getWorkerStatus, 
  areWorkersInitialized 
} from '@/lib/worker-auto-init'

// Check if initialized
if (!areWorkersInitialized()) {
  // Initialize manually
  await autoInitializeWorkers()
}

// Get current status
const status = getWorkerStatus()
console.log('Workers:', status)
```

## Comparison: Before vs After

### Before (Manual)
1. Deploy to Vercel
2. Wait for deployment to complete
3. Manually call `/api/bsv/init`
4. Workers start running
5. **Risk:** Forget to initialize, workers never start

### After (Automatic)
1. Deploy to Vercel
2. Workers **automatically** start on first request
3. Cron job ensures they stay running
4. **Benefit:** Zero manual intervention required

## Security Notes

- Environment variables are encrypted in Vercel
- Private keys are never logged or exposed
- Test keys are only used when production keys are missing
- All API endpoints are public but idempotent (safe to call multiple times)

## Cost Considerations

### Vercel
- Cron jobs count towards function invocations
- Workers run within normal serverless function limits
- Database connections are pooled efficiently

### External APIs
- Workers respect rate limits automatically
- Data collection is optimized to minimize API calls
- Monitor usage in your API provider dashboards

## Support

If you encounter issues:

1. Check Vercel logs: `vercel logs --follow`
2. Check worker status: `GET /api/workers/status`
3. Review environment variables in Vercel dashboard
4. Test locally: `npm run dev` and check console output

## Future Enhancements

Potential improvements for the auto-initialization system:

- [ ] Configurable worker intervals via environment variables
- [ ] Health check endpoint with auto-recovery
- [ ] Worker status dashboard in admin panel
- [ ] Email/Slack notifications for initialization failures
- [ ] Metrics collection and monitoring integration
- [ ] Graceful shutdown hooks for maintenance windows

---

**Last Updated:** October 3, 2025  
**Version:** 1.0.0

