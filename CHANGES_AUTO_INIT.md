# Auto-Init Change Notes

This file now captures the current outcome of the auto-init work rather than the retired Vercel worker model.

## What remains relevant

- `app/layout.tsx` still imports `lib/worker-bootstrap.ts`
- `lib/worker-bootstrap.ts` now honours `GAIALOG_WORKER_PROCESS`
- `lib/worker-auto-init.ts` now exits cleanly on read-only runtimes
- `lib/runtime-control.ts` is the runtime-role guard for web versus worker processes
- `ecosystem.config.cjs` defines explicit read-only web and single-writer worker roles on the VPS

## What changed operationally

- Vercel is no longer treated as a worker host
- Vercel cron-based worker refresh was removed
- wallet test-key fallback was removed from the worker auto-init path
- the dedicated VPS worker is the intended long-lived execution model

## Current source of truth

For the active deployment model, use:

- `VERCEL_VPS_SPLIT_DEPLOYMENT.md`
- `DEPLOYMENT_QUICKSTART.md`
- `env.vercel.template`
- `env.vps.template`
