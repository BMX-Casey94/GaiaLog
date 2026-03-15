# Worker Auto-Initialization

This file now documents the current behaviour of the worker bootstrap system.

## Current model

Worker bootstrap is runtime-controlled.

- `lib/worker-bootstrap.ts` is still imported by `app/layout.tsx`
- `lib/runtime-control.ts` decides whether the current runtime is allowed to act as a worker
- `lib/worker-auto-init.ts` exits cleanly on read-only runtimes

That means:

- `Vercel` stays read-only by setting `GAIALOG_WORKER_PROCESS=0`
- the dedicated VPS worker stays write-enabled with `GAIALOG_WORKER_PROCESS=1`
- a combined Node runtime can still bootstrap workers if explicitly configured as a worker process

## Important change

This project no longer relies on Vercel cron jobs to keep workers alive.

- there is no Vercel worker cron in the current deployment model
- Vercel should not hold wallet private keys or ARC credentials
- the VPS process manager is responsible for long-lived worker execution

## Manual endpoints

The compatibility endpoints still exist:

- `/api/workers/status`
- `/api/workers/auto-start`
- `/api/warmup`
- `/api/bsv/init`

They are useful for diagnostics or internal Node deployments, but they are not the primary production control plane for the Vercel plus VPS split.

## Production guidance

Use these files as the current source of truth:

- `VERCEL_VPS_SPLIT_DEPLOYMENT.md`
- `DEPLOYMENT_QUICKSTART.md`
- `env.vercel.template`
- `env.vps.template`

## Historical note

Older versions of this document described a serverless worker model where Vercel would start and refresh workers automatically. That guidance is retired.
