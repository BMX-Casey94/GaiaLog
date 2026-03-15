# GaiaLog Deployment Quick Start

This project now assumes a split production topology:

- `Vercel`: stateless frontend and read APIs
- `VPS`: dedicated single-writer worker and overlay host
- `Postgres / Supabase`: shared system of record

Use `VERCEL_VPS_SPLIT_DEPLOYMENT.md` as the canonical architecture reference.

## 1. Configure Vercel

Use `env.vercel.template` as the source of truth for Vercel environment variables.

Key points:

- Set `GAIALOG_WORKER_PROCESS=0`
- Set `GAIALOG_SINGLE_WRITER_MODE=run-workers`
- Keep `GAIALOG_NO_DB=false`
- Keep `BSV_ENABLE_UTXO_DB_LOCKS=true`
- Do not place wallet private keys or ARC credentials in Vercel

Vercel should contain read-side configuration only:

- Postgres / Supabase connection settings
- public-facing Supabase values
- admin UI secrets
- optional read-only overlay lookup settings when explorer migrates to overlay

## 2. Configure the VPS

Use `env.vps.template` as the source of truth for the VPS worker environment.

Key points:

- Set `GAIALOG_WORKER_PROCESS=1`
- Set `GAIALOG_SINGLE_WRITER_MODE=run-workers`
- Keep `GAIALOG_NO_DB=false`
- Keep `BSV_ENABLE_UTXO_DB_LOCKS=true`
- Keep all wallet WIFs, ARC credentials, provider API keys, and overlay submit credentials on the VPS only

The VPS is where you run:

- `scripts/run-workers.ts`
- queue mutation
- UTXO maintenance
- ARC broadcasting
- overlay lookup and submit endpoints

## 3. Deploy

### Vercel

Deploy the Next.js app normally:

```bash
vercel --prod
```

Or push to the connected Git remote and let Vercel build automatically.

### VPS

Run the long-lived services on the VPS:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

Or for a simpler non-PM2 run:

```bash
npm run workers
```

## 4. Verify

### Vercel

The public web runtime should be read-only. A status check should show a web role rather than an active writer:

```bash
curl https://your-app.vercel.app/api/workers/status
```

Expected characteristics:

- `runtimeControl.role` is `web`
- `runtimeControl.workerProcessEnabled` is `false`
- no worker bootstrap attempt is required for normal operation

### VPS

Check PM2 status and logs:

```bash
pm2 status
pm2 logs gaialog-workers
```

Expected characteristics:

- worker process is running
- queue processing is active
- UTXO maintainer is active
- spend-source status matches your rollout mode

## 5. Rollout Notes

- Keep `BSV_SPEND_SOURCE_MODE=shadow` on the VPS until parity is healthy
- Keep `BSV_SPEND_SOURCE_LEGACY_FALLBACK_ENABLED=true` during rollout
- Use `BSV_OVERLAY_CANARY_WALLET` when you begin canary promotion
- Keep `BSV_EXPECTED_TX_PER_DAY=2000000` until the admission-driven splitter replaces the legacy auto-sizing path

## 6. Do Not Do This On Vercel

- do not put `BSV_PRIVATE_KEY` or `BSV_WALLET_*_PRIVATE_KEY` in Vercel
- do not put `BSV_ARC_API_KEY` in Vercel
- do not run worker cron jobs from Vercel
- do not expose privileged overlay submit credentials publicly

## Additional Reading

- `VERCEL_VPS_SPLIT_DEPLOYMENT.md`
- `env.vercel.template`
- `env.vps.template`
- `env.template`
