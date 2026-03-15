# GaiaLog Vercel + VPS Deployment

This is the recommended production split for GaiaLog.

- `Vercel`: stateless frontend and read APIs
- `VPS`: dedicated single-writer process for signing, broadcasting, queue mutation, UTXO maintenance, and overlay submission
- `Postgres / Supabase`: shared system of record for queue state, locks, explorer reads, and tx logs

## What Runs Where

### Vercel
- UI and public API routes
- Explorer/history reads
- Read-only overlay lookups once Phase 9 lands
- No wallet private keys
- No ARC credentials
- No background workers
- No privileged overlay submit path

### VPS
- `scripts/run-overlay-server.ts`
- `scripts/run-workers.ts`
- Queue processing
- UTXO maintainer
- ARC broadcasting
- Overlay submit / admission path
- Privileged spend-path lookups

## Required Runtime Flags

### Vercel
```bash
GAIALOG_WORKER_PROCESS=0
GAIALOG_SINGLE_WRITER_MODE=run-workers
GAIALOG_MUTATOR_ROLE=secondary
GAIALOG_NO_DB=false
BSV_ENABLE_UTXO_DB_LOCKS=true
BSV_UTXO_MAINTAINER_DISABLED=true
```

### VPS worker
```bash
GAIALOG_WORKER_PROCESS=1
GAIALOG_SINGLE_WRITER_MODE=run-workers
GAIALOG_MUTATOR_ROLE=primary
GAIALOG_NO_DB=false
BSV_ENABLE_UTXO_DB_LOCKS=true
BSV_UTXO_MAINTAINER_DISABLED=false
```

`ecosystem.config.cjs` now bakes in the process-role split for the VPS web, overlay, and worker processes.

## Spend-Source Rollout

Use the spend-source mode independently per runtime.

- `Vercel`: keep `BSV_SPEND_SOURCE_MODE=legacy` until explorer/history is moved to overlay
- `VPS`: use `shadow` until parity is healthy, then promote `W1`/`W2`/`W3` to `overlay` together
- Keep `BSV_SPEND_SOURCE_LEGACY_FALLBACK_ENABLED=true` during rollout
- Use `BSV_OVERLAY_FORCE_LEGACY_WALLETS` as the per-wallet kill switch if one wallet needs to fall back without rolling back the others
- Keep `GAIALOG_QUEUE_GATE_SOURCE=legacy` for the safer first cut, then flip it to `overlay` after parity and submit/admit SLOs are green

### Overlay identity

You are your own overlay provider in this topology.

- `BSV_OVERLAY_PROVIDER_ID` is the logical service name your worker queries
- `BSV_OVERLAY_LOOKUP_URL` and `BSV_OVERLAY_SUBMIT_URL` should point at the private loopback overlay service on the VPS, for example `http://127.0.0.1:3100/lookup`
- `BSV_OVERLAY_AUTH_MODE=brc104` enables dynamic BRC-104/Authrite-style mutual authentication for worker-to-overlay calls
- `BSV_OVERLAY_CLIENT_IDENTITY_WIF` is the worker/client identity key
- `GAIALOG_OVERLAY_SERVER_IDENTITY_WIF` is the overlay server identity key
- `BSV_OVERLAY_HEADERS_JSON`, `BSV_OVERLAY_LOOKUP_HEADERS_JSON`, and `BSV_OVERLAY_SUBMIT_HEADERS_JSON` now carry additional signed `x-bsv-*` headers, not static auth placeholders
- Start with `BSV_OVERLAY_TIMEOUT_MS=15000` and `BSV_OVERLAY_MAX_RETRIES=3`
- Prefer `BSV_OVERLAY_COUNT_FALLBACK_LIMIT=0` unless you intentionally accept bounded legacy-style count fallbacks
- Bind the overlay service to loopback and enforce `GAIALOG_OVERLAY_ALLOWED_IPS`, rate limits, and signed audit logging on the VPS

## Shared DB Rules

- Keep `GAIALOG_NO_DB=false` in production
- Keep `BSV_ENABLE_UTXO_DB_LOCKS=true`
- Use DB-backed locks as the authority across runtimes
- Continue using DB server time for lock expiry

Without a shared DB, the web tier and worker tier will drift.

## Temporary legacy compatibility

Until the admission-driven splitter lands, some write-path code still reads:

- `BSV_EXPECTED_TX_PER_DAY`
- `BSV_UTXO_SPLIT_OUTPUT_SATS`

For your current target, keep `BSV_EXPECTED_TX_PER_DAY` at a realistic figure such as `2000000` rather than the earlier lower defaults. Treat both as temporary compatibility knobs, not the long-term policy surface.

The templates also include forward-looking PR6 guardrails:

- `GAIALOG_UTXO_TARGET_BUFFER_MINUTES`
- `GAIALOG_UTXO_HYSTERESIS_PCT`
- `GAIALOG_SPLIT_PER_TX_CAP`
- `GAIALOG_SPLIT_P95_HEADROOM`

These are safe to pre-populate now, but current code does not consume them yet.

## Security Rules

- Store WIF keys and ARC credentials on the VPS only
- Keep Vercel free of signing or broadcast secrets
- Treat privileged overlay lookup and submit endpoints as infrastructure, not public APIs
- Protect privileged endpoints with authentication, rate limits, allow-lists, and audit logging
- Prefer one shared metrics backend so `clientRequestId` can be traced across Vercel, VPS, and overlay hosts

## Env Files

Starter files are included:

- `env.vercel.template`
- `env.vps.template`
- `env.template` for the generic merged configuration surface

Populate the real runtime secrets in your deployment platform rather than committing them to the repo.

## Operational Notes

- `lib/worker-bootstrap.ts` now honours `GAIALOG_WORKER_PROCESS`, so Vercel and any explicitly read-only web runtime will not bootstrap workers
- `lib/worker-auto-init.ts` now reports runtime control in status and refuses to inject test keys when real wallet keys are missing
- `app/layout.tsx` can keep importing `worker-bootstrap` safely because the runtime guard now no-ops on read-only runtimes
- `app/api/workers/status` and `app/api/workers/diagnostics` now expose wallet-scoped overlay fallback and gate information for the VPS worker
- The UTXO maintainer now submits successful split transactions into the overlay admission path and requires all-host acks in code for split availability

## Next Recommended Work

- Build the overlay-backed history provider for explorer migration
- Add multi-host overlay fan-out if you want acknowledgements from more than one VPS overlay host
