# Vercel Production Architecture Fix

> Superseded by `VERCEL_VPS_SPLIT_DEPLOYMENT.md` for the current production topology.
> This older note describes the original read-only Vercel split, but the canonical
> production guidance now assumes a dedicated VPS worker plus shared Postgres.

## The Problem (What Was Wrong)

### Original Incorrect Assumption
Earlier guidance incorrectly suggested Vercel could run the full system including workers and data collection. **This is impossible** - Vercel is serverless and can only run short-lived functions (max 60 seconds).

### What Was Happening
- **Vercel Production**: Calling `/api/data/collect` (tries to run workers → fails → shows stale data)
- **Local Machine**: Running workers → Writing to Supabase → Fresh data exists
- **Result**: Production showed old data, local showed fresh data ❌

## The Solution (Correct Architecture)

### Two-Tier Architecture

#### Tier 1: Local Machine (Data Ingestion)
**Role**: Runs persistent workers to collect and broadcast data

**Responsibilities**:
- ✅ Fetch fresh data from APIs (WAQI, USGS, NOAA, etc.)
- ✅ Broadcast transactions to BSV blockchain
- ✅ Write data to Supabase database
- ✅ Run `ANALYZE` every 30 seconds for stats updates

**Runs**: `npm run workers`

#### Tier 2: Vercel (Frontend/Dashboard)
**Role**: Serverless Next.js app serving the public website

**Responsibilities**:
- ✅ **READ ONLY** - No data collection or worker execution
- ✅ Serve dashboard UI
- ✅ Query Supabase database for latest data
- ✅ Display stats, charts, blockchain transactions

**URL**: `https://gaialog.world`

---

## What Was Changed

### 1. Hero Component (`components/hero.tsx`)
**Before**: Called `/api/data/collect` (tried to run workers on Vercel)
```typescript
// ❌ OLD - Tries to collect fresh data on Vercel
fetch('/api/data/collect', { method: 'POST' })
```

**After**: Only reads from database
```typescript
// ✅ NEW - Reads from database
fetch('/api/hero-stats')  // Reads air_quality_readings table
```

### 2. Live Alerts (`components/sections/live-dashboard.tsx`)
**Before**: Called `/api/data/collect`
```typescript
// ❌ OLD
fetch('/api/data/collect', { method: 'POST' })
```

**After**: Reads from multiple database endpoints
```typescript
// ✅ NEW - Parallel database reads
await Promise.all([
  fetch('/api/air-quality/latest'),
  fetch('/api/water-levels?limit=1'),
  fetch('/api/seismic?limit=1')
])
```

### 3. Air Quality Panel (`components/panels/air-quality-panel.tsx`)
**Before**: Called `/api/data/collect`

**After**: Reads from `/api/air-quality/latest`
```typescript
// ✅ NEW - Database-only endpoint
fetch('/api/air-quality/latest')
```

### 4. New API Endpoint (`app/api/air-quality/latest/route.ts`)
**Created**: New endpoint that reads latest air quality from database
```typescript
// Reads from air_quality_readings table (written by local workers)
SELECT * FROM air_quality_readings ORDER BY collected_at DESC LIMIT 1
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│ Local Machine (Your Computer)                          │
│                                                         │
│  ┌──────────────┐      ┌──────────────┐               │
│  │   Workers    │ ───> │  Data APIs   │               │
│  │  (Node.js)   │      │ WAQI, USGS,  │               │
│  └──────┬───────┘      │ NOAA, etc.   │               │
│         │              └──────────────┘               │
│         │ Collects Fresh Data                         │
│         ↓                                              │
│  ┌──────────────────────────────────┐                │
│  │  BSV Blockchain Broadcasting     │                │
│  └──────────────┬───────────────────┘                │
│                 │                                      │
└─────────────────┼──────────────────────────────────────┘
                  │ Writes to Database
                  ↓
         ┌────────────────────┐
         │   Supabase DB      │ ← Single Source of Truth
         │  (PostgreSQL)      │
         └────────┬───────────┘
                  │ Reads from Database
                  ↓
┌─────────────────────────────────────────────────────────┐
│ Vercel Production (gaialog.world)                      │
│                                                         │
│  ┌──────────────┐      ┌──────────────┐               │
│  │  Dashboard   │ ───> │  API Routes  │               │
│  │  (Next.js)   │      │  (Read Only) │               │
│  └──────────────┘      └──────────────┘               │
│                                                         │
│  Shows: Hero Stats, Live Alerts, Blockchain TX         │
└─────────────────────────────────────────────────────────┘
```

---

## Vercel Environment Variables Required

Set these in **Vercel Project Settings → Environment Variables**:

```bash
# Supabase Connection (USE POOLER - port 6543 for serverless!)
PGHOST=db.gldafkqsxusdvobvwvmp.supabase.co
PGPORT=6543
PGUSER=postgres.gldafkqsxusdvobvwvmp
PGPASSWORD=<your_password>
PGDATABASE=postgres

# Supabase HTTP Fallback
NEXT_PUBLIC_SUPABASE_URL=https://gldafkqsxusdvobvwvmp.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your_anon_key>
SUPABASE_SERVICE_ROLE_KEY=<your_service_role_key>

# BSV Network Info (for display only - no broadcasting on Vercel)
BSV_NETWORK=mainnet

# Admin Access
ADMIN_PASSWORD=<your_admin_password>
ADMIN_SECRET=<your_secret>
```

**⚠️ Important**: Use **port 6543** (connection pooler) not 5432 (direct connection) for Vercel!

---

## Local Machine Environment Variables

Your `.env.local` should point to **production Supabase**:

```bash
# Supabase Connection (can use direct port 5432 for local)
PGHOST=db.gldafkqsxusdvobvwvmp.supabase.co
PGPORT=5432
PGUSER=postgres
PGPASSWORD=<your_password>
PGDATABASE=postgres

# BSV Wallet Keys (MAINNET - keep secure!)
BSV_WALLET_1_PRIVATE_KEY=<mainnet_key_1>
BSV_WALLET_2_PRIVATE_KEY=<mainnet_key_2>
BSV_WALLET_3_PRIVATE_KEY=<mainnet_key_3>

# BSV Configuration
BSV_NETWORK=mainnet
BSV_ARC_API_KEY=<your_taal_arc_key>
BSV_BYPASS_QUEUE=true

# Data Provider API Keys
WAQI_API_KEY=<your_waqi_key>
# ... other provider keys
```

---

## How to Deploy & Run

### Step 1: Deploy to Vercel
```bash
git add .
git commit -m "Fixed: Vercel now reads from DB instead of running workers"
git push origin main
```

Vercel will auto-deploy. The site will be **read-only** but show fresh data from the database.

### Step 2: Run Workers Locally
```bash
npm run workers
```

**Expected logs**:
```
✅ Workers started
📊 Updated tx_log stats: 1,791,XXX transactions  (every 30s)
✅ Direct broadcast air_quality - e7194e93460a...
✅ USGS-Seismic: Processed 6 data points
```

### Step 3: Verify Production
Visit `https://gaialog.world` and check:
- ✅ Hero stats show fresh AQI
- ✅ Live Alerts display current data
- ✅ Blockchain Verification shows recent TX
- ✅ Total TX counter increments every 30s
- ✅ No "Non-worker context" errors in Vercel logs

---

## Future Production Setup (Recommended)

For 24/7 operation, deploy workers to a long-running service:

### Option 1: Railway (Recommended)
- Cost: ~£4/month
- Deploy time: 5 minutes
- Perfect for persistent Node.js workers

### Option 2: Render
- Free tier available (spins down after inactivity)
- Paid tier: £7/month

### Option 3: DigitalOcean/Linode VPS
- Cost: £5-10/month
- More control, requires Linux knowledge

---

## Summary

✅ **Fixed**: Vercel now correctly operates as a read-only frontend
✅ **Fixed**: Local workers write to production database
✅ **Fixed**: Data stays synchronized between local and production
✅ **Fixed**: All components show the same fresh data
✅ **Architecture**: Proper separation of concerns (workers vs frontend)

The system is now production-ready with the correct serverless architecture! 🚀

