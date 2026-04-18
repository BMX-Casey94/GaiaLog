# Operations and Runbooks

This document covers the current operational procedures for updating, monitoring, and recovering a GaiaLog deployment.

## Pull latest changes on the VPS

```bash
cd /opt/gaialog
git pull origin master
npm ci
npm run build
pm2 restart gaialog-web gaialog-workers gaialog-overlay --update-env
pm2 save
```

Use the real clone path on your host.

## Sync newly added environment variables

`git pull` does not update `.env`. Use:

```bash
cd /opt/gaialog
npm run sync:env:dry-run
npm run sync:env
pm2 restart gaialog-web gaialog-workers gaialog-overlay --update-env
```

`npm run sync:env` only appends missing keys. It does not overwrite existing secrets.

## Basic monitoring

```bash
pm2 status
pm2 logs gaialog-workers --lines 200
pm2 logs gaialog-overlay --lines 200
curl -s http://localhost:3000/api/workers/status
curl -s http://localhost:3000/api/throughput/status
```

## Database diagnostics

Lightweight read-only diagnostic helpers for verifying connectivity and row counts:

```bash
npm run db:health      # confirms the worker can reach Postgres
npm run db:counts      # prints row counts for the main reading tables
```

Use these when a worker reports DB errors, after a Supabase pooler restart, or as a quick sanity check after running migrations.

## Quick diagnostic checklist

1. confirm the rollout gate is what you expect
2. confirm the worker process is online
3. confirm overlay lookup and submit URLs are reachable
4. confirm `EXPLORER_READ_SOURCE` and `EXPLORER_WRITE_MODE` are aligned
5. confirm required provider keys exist for the enabled families

## Common operational issues

### Broadcast failures

If transactions stop broadcasting reliably:

- verify `BSV_ARC_API_KEY`
- verify the configured ARC endpoints
- verify the worker can still reach overlay and UTXO sources
- confirm the queue is progressing rather than repeatedly re-queueing failed items

### Overlay 404 or missing UTXOs

If UTXO lookups fail with `404`, verify:

- `gaialog-overlay` is running
- `BSV_OVERLAY_LOOKUP_URL` and `BSV_OVERLAY_SUBMIT_URL` match the actual service routes
- the overlay service is bound to the expected host and port

### Explorer writing to the wrong table

If you see writes targeting legacy explorer storage when the overlay-backed table is the real path, set:

```bash
EXPLORER_READ_SOURCE=overlay
EXPLORER_WRITE_MODE=overlay
```

### Stale environment in PM2

If `.env` is correct but runtime behaviour still looks old:

```bash
pm2 restart gaialog-web gaialog-workers gaialog-overlay --update-env
pm2 save
```

## Incident-only emergency DB-less mode

This mode exists only for incidents where the normal DB-backed path is unavailable or exhausted.

`scripts/emergency-utxo-manager.py` is the only non-Node component in the repository. It is a deliberately small, file-backed UTXO server intended to keep broadcasting alive when the database-backed inventory is unreachable. It is Python so it has no dependency on the same Node runtime, queue, or `pg` pool that may be the cause of the incident. Outside of incidents it should remain stopped.

Enable it only temporarily:

```bash
GAIALOG_NO_DB=true
GAIALOG_EMERGENCY_LEGACY_UTXO=true
BSV_SPEND_SOURCE_MODE=legacy
GAIALOG_QUEUE_GATE_SOURCE=legacy
BSV_UTXO_MAINTAINER_DISABLED=true
BSV_BYPASS_QUEUE=true
BSV_UTXO_PROVIDER=custom
BSV_UTXO_ENDPOINT_TEMPLATE=http://127.0.0.1:8787/utxos/{address}
GAIALOG_EMERGENCY_UTXO_MANAGER_URL=http://127.0.0.1:8787
GAIALOG_EMERGENCY_UTXO_MANAGER_SECRET=replace_me
```

Then start the emergency manager:

```bash
pm2 start "python3 scripts/emergency-utxo-manager.py" --name gaialog-utxo-manager
```

Important limits:

- incident use only
- reduced persistence and recovery guarantees
- keep the emergency manager on localhost and protected by a secret
- return to the normal DB-backed mode as soon as practical

## Return to normal operation

```bash
GAIALOG_NO_DB=false
GAIALOG_EMERGENCY_LEGACY_UTXO=false
BSV_SPEND_SOURCE_MODE=overlay
GAIALOG_QUEUE_GATE_SOURCE=overlay
BSV_UTXO_MAINTAINER_DISABLED=false
BSV_BYPASS_QUEUE=false
```

Then restart services and remove the emergency manager if it was started.
