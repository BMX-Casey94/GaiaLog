# Auto-Init Overview

This file is now a short historical note rather than the primary deployment guide.

The worker auto-init code still exists, but the production model has changed:

- `Vercel` is read-only
- the `VPS` owns all long-lived worker activity
- `lib/runtime-control.ts` prevents read-only runtimes from bootstrapping workers

If you are looking for current deployment instructions, use:

- `VERCEL_VPS_SPLIT_DEPLOYMENT.md`
- `DEPLOYMENT_QUICKSTART.md`

If you are looking for runtime behaviour details, use:

- `WORKER_AUTO_INITIALIZATION.md`

Historical context:

- worker bootstrap remains useful for explicitly worker-enabled Node runtimes
- the old Vercel cron-based worker pattern is retired
- wallet keys and ARC credentials now belong on the VPS only
