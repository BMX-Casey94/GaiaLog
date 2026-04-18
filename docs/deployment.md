# Deployment

GaiaLog is designed for a split production topology:

- `Vercel` hosts the web app and read-side API routes
- a `VPS` hosts the worker, queue, signing, broadcast, and overlay services
- `Supabase / Postgres` is the shared system of record

## What runs where

### Vercel

Use `env.vercel.template` as the source of truth.

`Vercel` should remain read-only:

- UI and public API routes
- explorer reads
- optional read-side overlay lookups
- no background workers
- no wallet WIFs
- no ARC credentials
- no privileged overlay submit path

### VPS

Use `env.vps.template` as the source of truth.

The `VPS` owns the write path:

- `scripts/run-workers.ts`
- `scripts/run-overlay-server.ts`
- queue mutation
- UTXO maintenance
- signing and broadcast
- overlay admission and submit flows

## Required role flags

### Vercel

```bash
GAIALOG_WORKER_PROCESS=0
GAIALOG_SINGLE_WRITER_MODE=run-workers
GAIALOG_MUTATOR_ROLE=secondary
GAIALOG_NO_DB=false
BSV_ENABLE_UTXO_DB_LOCKS=true
BSV_UTXO_MAINTAINER_DISABLED=true
```

### VPS

```bash
GAIALOG_WORKER_PROCESS=1
GAIALOG_SINGLE_WRITER_MODE=run-workers
GAIALOG_MUTATOR_ROLE=primary
GAIALOG_NO_DB=false
BSV_ENABLE_UTXO_DB_LOCKS=true
BSV_UTXO_MAINTAINER_DISABLED=false
```

## Shared database rules

- keep `GAIALOG_NO_DB=false` in normal production
- use the shared Supabase pooler settings
- treat the database-backed state as authoritative across runtimes
- apply migrations before switching explorer or overlay behaviour
- merge any newly introduced keys from `env.vps.template` or `env.vercel.template` into the live runtime env before restart

## Overlay auth mode

There are two valid deployment patterns:

- `BSV_OVERLAY_AUTH_MODE=none`
  Use this when workers and overlay are co-hosted on the same private loopback host, such as `127.0.0.1` on the `VPS`.

- `BSV_OVERLAY_AUTH_MODE=brc104`
  Use this when you explicitly want mutual authentication between worker and overlay identities.

Do not document one mode as universally correct. The correct choice depends on the host topology.

## Explorer production mode

The current code defaults to overlay for explorer reads and writes when the flags are unset. Production should keep these explicit:

```bash
EXPLORER_READ_SOURCE=overlay
EXPLORER_WRITE_MODE=overlay
```

## Deploy commands

### Vercel

```bash
vercel --prod
```

### VPS

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

For a simpler foreground worker-only run:

```bash
npm run workers
```

After a pull, the quickest env refresh path is:

```bash
npm run sync:env:dry-run
npm run sync:env
pm2 restart gaialog-web gaialog-workers gaialog-overlay --update-env
```

## Verification

### Web runtime

Confirm that the web runtime is read-only:

```bash
curl https://your-app.example/api/workers/status
```

Expected characteristics:

- runtime role is `web`
- worker process is disabled
- no signing or queue mutation occurs in the web tier

### VPS runtime

Check PM2 state:

```bash
pm2 status
pm2 logs gaialog-workers
```

Expected characteristics:

- the worker process is online
- queue processing is active
- the UTXO maintainer is active
- overlay routes are reachable on the expected host and port

## Security rules

- never put wallet WIFs or ARC credentials into `Vercel`
- keep overlay submit credentials private
- bind private overlay services to loopback where possible
- keep all real secrets in deployment platform settings or server-side `.env` files only
- set `GAIALOG_INTERNAL_API_SECRET` in production if you want internal debug, test, warmup, or operational routes to remain usable while staying non-public
- only set `ADMIN_RESET_SECRET` if you intentionally use the admin reset route in a controlled operational workflow
