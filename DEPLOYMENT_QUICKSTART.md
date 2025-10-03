# GaiaLog Deployment Quick Start Guide

## 🚀 Deploy to Vercel in 3 Steps

### Step 1: Set Environment Variables in Vercel

Go to your Vercel project → Settings → Environment Variables and add:

```bash
# Database (Required)
DATABASE_URL=your_postgres_connection_string
SUPABASE_DB_URL=your_supabase_direct_url

# BSV Blockchain (Required for blockchain features)
BSV_PRIVATE_KEY=your_primary_wallet_private_key
BSV_ARC_API_KEY=your_arc_api_key
BSV_NETWORK=testnet

# Optional: Additional wallets for load distribution
BSV_WALLET_1_PRIVATE_KEY=your_wallet_1_private_key
BSV_WALLET_2_PRIVATE_KEY=your_wallet_2_private_key
BSV_WALLET_3_PRIVATE_KEY=your_wallet_3_private_key

# External APIs (Required for data collection)
WAQI_API_KEY=your_waqi_api_key
WEATHER_API_KEY=your_weather_api_key
```

### Step 2: Deploy

```bash
vercel --prod
```

Or push to your connected Git repository (GitHub, GitLab, Bitbucket).

### Step 3: Verify Workers Are Running

After deployment completes (usually 2-3 minutes), check:

```bash
curl https://your-app-name.vercel.app/api/workers/status
```

Expected response:
```json
{
  "success": true,
  "status": {
    "initialized": true,
    "workersRunning": 4,
    "totalWorkers": 4
  }
}
```

## ✅ That's It!

Your workers will **automatically start** and begin:
- Collecting environmental data (air quality, weather, seismic, water levels)
- Processing blockchain transactions
- Maintaining UTXO pools

## 📊 What Happens Automatically

### On Deployment:
1. ✅ App builds and deploys to Vercel
2. ✅ First request triggers auto-initialization
3. ✅ All 4 environmental workers start
4. ✅ Blockchain transaction queue begins processing
5. ✅ UTXO maintainer starts splitting UTXOs
6. ✅ Vercel cron job pings every 10 minutes to keep workers active

### No Manual Steps Required!

Previously, you had to:
- ❌ Manually call `/api/bsv/init` after every deployment
- ❌ Remember to restart workers
- ❌ Set up external cron jobs

Now:
- ✅ Everything starts automatically
- ✅ Workers stay running via built-in cron
- ✅ Zero maintenance required

## 🔍 Monitoring

### Check Worker Status Anytime:
```bash
curl https://your-app-name.vercel.app/api/workers/status
```

### View Live Logs:
```bash
vercel logs --follow
```

### Admin Dashboard:
Navigate to `https://your-app-name.vercel.app/admin` (requires authentication)

## 🆘 Troubleshooting

### Workers Not Starting?

**Quick Fix:**
```bash
curl -X POST https://your-app-name.vercel.app/api/warmup
```

This manually triggers initialization.

**Check Logs:**
```bash
vercel logs
```

Look for:
- ✅ `Worker auto-initialization completed successfully`
- ❌ Error messages about missing environment variables

### Need Help?

1. Check `WORKER_AUTO_INITIALIZATION.md` for detailed documentation
2. Review Vercel logs: `vercel logs --follow`
3. Verify environment variables in Vercel dashboard

## 🔐 Security Notes

- Environment variables are encrypted by Vercel
- Never commit `.env` files to Git
- Use test wallets for development/staging
- Use production wallets only for production deployment

## 💰 Cost Estimate

**Vercel:**
- Free tier: Likely sufficient for testing
- Pro tier: Recommended for production (£16/month)

**External APIs:**
- Most have free tiers for moderate usage
- Monitor your usage in provider dashboards

## 🎯 Next Steps

After deployment:

1. ✅ Visit your app: `https://your-app-name.vercel.app`
2. ✅ Check workers: `https://your-app-name.vercel.app/api/workers/status`
3. ✅ View admin dashboard: `https://your-app-name.vercel.app/admin`
4. ✅ Monitor Vercel logs for any issues

## 📚 Additional Resources

- **Full Documentation:** `WORKER_AUTO_INITIALIZATION.md`
- **Environment Variables:** `env.template`
- **Vercel Dashboard:** https://vercel.com/dashboard
- **Architecture:** `BLOCKCHAIN_INTEGRATION.md`

---

**Questions?** Check the full documentation in `WORKER_AUTO_INITIALIZATION.md`

