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

### Explorer shows "Unconfirmed" for months-old TXs

The live confirmation worker chases a recent window plus a residual catch-up
(`BSV_CONFIRMATION_CATCHUP_DAYS`, default 400). Multi-month backlogs from
before the worker existed (or from prolonged WoC 429 outages) still need a
one-shot backfill. Safe while workers are running:

```bash
cd /opt/gaialog
npx tsx scripts/backfill-explorer-confirmations.ts
npx tsx scripts/backfill-explorer-confirmations.ts --apply --limit 2000
# re-run until remaining ≈ 0
npx tsx scripts/backfill-explorer-confirmations.ts --apply --limit 5000
```

Uses Bitails (not WhatsOnChain) so it does not steal the confirmation worker's
WoC quota. Idempotent — already-confirmed rows are skipped.

### Explorer 500: `timeout exceeded when trying to connect`

This is a **Postgres pool connect timeout**, not a BSV/explorer logic bug.
`gaialog-web` could not obtain a free client from `pg` within
`PG_CONNECT_TIMEOUT_MS` (default 15s). Under write recovery the workers hold
many connections; the web process then fails intermittent `/api/explorer/*`
reads with HTTP 500.

Mitigations:
- Prefer Supavisor **transaction** mode (port `6543`) for the web process
- Keep `PGPOOL_MAX` modest per process (default 10) — three PM2 apps × 10 can
  exhaust a small pooler plan
- Watch `pm2 logs gaialog-web` for the timeout string during spikes
- After heavy consolidation / funding-admit storms, give the pool a minute to
  drain before treating explorer 500s as a separate outage

### Explorer writing to the wrong table

If you see writes targeting legacy explorer storage when the overlay-backed table is the real path, set:

```bash
EXPLORER_READ_SOURCE=overlay
EXPLORER_WRITE_MODE=overlay
```

### `overlay_admitted_utxos` table bloat

Retention runs from two triggers — whichever fires first wins (a DB advisory
lock plus a persisted last-run marker in `provider_cursors` prevent double
runs):

- **In-process scheduler** (VPS/PM2): `scripts/run-workers.ts` starts
  `startRetentionScheduler()` from `lib/retention.ts`, which executes the pass
  once per UTC day at/after `RETENTION_HOUR_UTC` (default `3`). Opt-out via
  `RETENTION_SCHEDULER_DISABLED=true`.
- **`/api/maintenance/retention`** (Vercel Cron, 03:17 UTC) — only fires on
  Vercel deployments; it never runs on the VPS, which is why the in-process
  scheduler exists.

Each pass automatically:

1. Prunes old `overlay_explorer_readings` per family retention windows
   (capped by `RETENTION_MAX_DELETES_PER_FAMILY`, default `250000`).
2. Deletes confirmed `tx_log` rows older than `RETENTION_TX_LOG_DAYS`
   (default `30`), capped by `RETENTION_MAX_TX_LOG_DELETES_PER_RUN`
   (default `500000`) so a single pass always finishes before PM2's
   30-minute `cron_restart`.
3. Compacts spent UTXO rows by nulling out their `raw_tx` and `beef` blobs.
4. Physically deletes spent rows older than `RETENTION_UTXO_PRUNE_DAYS` (default `3`).
5. Deletes `overlay_submissions` audit rows older than `RETENTION_SUBMISSIONS_DAYS`
   (default `14`) — this table reached 15 GB in production before pruning existed.

The scheduler claims `last_run_ms` *before* the heavy work begins, so a
process kill mid-pass cannot re-fire on the next boot and thrash the DB.
If you need to stop retention urgently (e.g. during a CPU incident):

```bash
# In /opt/gaialog/.env:
RETENTION_SCHEDULER_DISABLED=true
pm2 restart gaialog-workers --update-env
```

Re-enable by removing that line (or setting it to `false`) after the capped
scheduler is deployed.

### VPS deploy install

Workers need `tsx` and `next build` needs `@tailwindcss/postcss` /
`tailwindcss` / `postcss` at install time. Those packages live in
`dependencies`, so `npm install --omit=dev` is safe. If a build fails with
`Cannot find module '@tailwindcss/postcss'`, run a full `npm install` once
and confirm `package.json` is current.

### Resume blockchain writes after funding

Overlay spends only from `overlay_admitted_utxos`. Sending BSV on-chain is
not enough by itself — confirmed funding must be admitted into inventory.

**Normal path (workers running):**

1. Send a confirmed top-up to each wallet that needs runway (prefer one large
   UTXO per wallet, ≥ `BSV_FUNDING_ADMIT_MIN_SATS`, default 10 000 sats).
2. Wait for ≥1 confirmation.
3. Within ~5 minutes the funding-admit scheduler (`lib/wallet-funding-admit.ts`)
   discovers the UTXO via Bitails and inserts it as `reserve`/`confirmed`.
4. The UTXO maintainer splits it into pool outputs; logs show `UTXO-Split` and
   non-zero `submitted=` again.

No PM2 restart is required after funding. Opt out with
`BSV_FUNDING_ADMIT_DISABLED=true` if needed.

**How discovery finds funding behind a dust pile.** Bitails returns unspents in
pages, and a wallet holding tens of thousands of dust outputs can push a fresh
top-up well past any fixed scan depth — in August 2026 that silently left three
funded wallets STARVED because the scan stopped at 10 000 outputs. Each cycle
now:

1. Compares the address' confirmed chain balance with overlay live sats
   (gap below `BSV_FUNDING_ADMIT_MIN_SATS` → one balance request, done).
2. **History-first:** recent Bitails address history (newest first) for receives
   ≥ minSats, then resolves each TX's unspent outputs to this address. A fresh
   top-up is admitted in seconds without paging the dust pile.
3. Fallback: cursor-resumed unspent pagination
   (`BSV_FUNDING_ADMIT_PAGES_PER_CYCLE`, default 250 = 25 000 outputs), with
   mid-sweep resumes every `BSV_FUNDING_ADMIT_RESUME_INTERVAL_MS` (default 30 s)
   instead of waiting the full 5-minute idle interval.

A completed unspent sweep that admitted nothing will not re-run until the chain
balance moves or `BSV_FUNDING_ADMIT_SWEEP_BACKOFF_MS` (default 6 h) elapses.

Watch it with:

```bash
pm2 logs gaialog-workers --raw 2>/dev/null | grep "funding-admit"
```

**Full rebuild path (inventory wiped / phantoms):** still use the recovery
import with workers stopped:

```bash
pm2 stop gaialog-workers
# discover → /tmp/recovery/W{1,2,3}.utxos.json
npx tsx scripts/recovery-import-onchain-utxos.ts
npx tsx scripts/recovery-import-onchain-utxos.ts --apply
pm2 start gaialog-workers
```

### Write dry mode (wallet ran out of funds)

`lib/write-dry-mode.ts` stops the pipeline from attempting chain writes when no
wallet holds a spendable UTXO. Without it, every collector kept building
transactions that could not be funded, each failure was retried within seconds,
and the resulting churn produced ARC 460 storms and chains of unconfirmed change
that later became phantoms.

Detection deliberately ignores UTXO *counts* — a wallet can hold hundreds of
thousands of sub-fee dust rows and still fund nothing. The gate is:

```
dry  ⟺  largest spendable UTXO across all wallets < BSV_WRITE_DRY_MIN_INPUT_SATS
```

The floor defaults to `BSV_UTXO_SPLIT_OUTPUT_SATS` (the denomination the
maintainer mints for writes). Entering dry mode needs two consecutive checks so
it cannot flap mid-split; leaving is immediate on the first healthy check.

While dry:

- collectors still poll providers (so provider health stays visible) but skip
  the chain write **without** touching the dedupe store, so readings are simply
  re-collected once funding returns — no backlog, no dropped-then-blocked data
- the queue *holds* already-accepted items rather than draining them into
  failures
- the normal collection interval applies (not the 10s backpressure retry), so a
  long outage does not hammer upstream providers
- `funding-monitor` and `funding-admit` keep running, so a top-up is detected
  and admitted automatically

Log lines to watch:

```bash
pm2 logs gaialog-workers --raw 2>/dev/null | grep -E "write-dry-mode|writes paused|writes_suppressed"
```

`⏸️ [write-dry-mode] ENGAGED` means fund a wallet with a single confirmed UTXO;
`▶️ [write-dry-mode] CLEARED` confirms writes resumed and reports how many write
attempts were suppressed during the outage.

Env: `BSV_WRITE_DRY_MODE_DISABLED=true` (opt out),
`BSV_WRITE_DRY_CHECK_INTERVAL_MS` (default 30 000),
`BSV_WRITE_DRY_MIN_INPUT_SATS`, `BSV_WRITE_DRY_LOG_INTERVAL_MS` (default 10 min).

### Auto-consolidation (dust starvation guard)

`lib/utxo-auto-consolidate.ts` runs inside `gaialog-workers` and removes the
manual step below in the common case. Every 5 minutes it compares each wallet's
largest usable output against the split floor
(`2 × BSV_UTXO_SPLIT_OUTPUT_SATS` + split fee). A wallet below the trigger
(default 3 × floor) has its stranded dust swept into a single large `reserve`
output, which the maintainer splits again on its next cycle.

The selection window is the safety property worth remembering: only rows
**between** `BSV_AUTO_CONSOLIDATE_MIN_INPUT_SATS` (default 3 × the per-input
fee, so nothing uneconomic is swept) and `BSV_AUTO_CONSOLIDATE_MAX_INPUT_SATS`
(default the split floor − 1) are eligible. Auto-consolidation therefore can
never consume an output the splitter itself could have used. Inputs are locked
before signing, marked spent and re-admitted in one database transaction, and
an ARC missing-inputs (460) response archives the batch as phantom rather than
retrying dead inventory.

Confirmed rows only by default; set `BSV_AUTO_CONSOLIDATE_INCLUDE_UNCONFIRMED=true`
only when the dust pile is genuinely unconfirmed, since spending unconfirmed
ancestors risks ARC mempool-chain limits.

```bash
pm2 logs gaialog-workers --raw 2>/dev/null | grep "auto-consolidate"
```

`♻️ swept N dust input(s) into X sats reserve` is the success line. `no eligible
dust to sweep — wallet requires external funding` means the wallet is genuinely
empty, not fragmented: send BSV.

Env: `BSV_AUTO_CONSOLIDATE_DISABLED=true` (opt out),
`BSV_AUTO_CONSOLIDATE_INTERVAL_MS` (default 300 000),
`BSV_AUTO_CONSOLIDATE_TRIGGER_SATS`, `BSV_AUTO_CONSOLIDATE_BATCH_SIZE`
(default 500 inputs per TX), `BSV_AUTO_CONSOLIDATE_MAX_BATCHES` (default 4 per
wallet per cycle).

### Dust consolidation (manual)

For a full cleanup sweep — millions of rows, or dust that auto-consolidation
skips because it is unconfirmed — run the script by hand. When the pool has
degraded to sub-spendable UTXOs (~97 sats):

```bash
cd /opt/gaialog
npx tsx scripts/consolidate-wallet-utxos.ts --include-unconfirmed --batch-size 500 --skip-snapshot
npx tsx scripts/consolidate-wallet-utxos.ts --apply --include-unconfirmed --batch-size 500 --skip-snapshot
```

Production dust is typically `confirmed=false` and ~97 sats — without
`--include-unconfirmed` the lock query scans for confirmed rows that do not
exist and times out. `--batch-size 500` keeps each statement small;
`--skip-snapshot` avoids the pre-flight aggregate.

Without step 2 the table heap grows unbounded even after compaction, and the acquire query eventually falls back to a sequential scan and times out. If you suspect bloat, check:

```bash
psql "$DATABASE_URL" -c "
SELECT pg_size_pretty(pg_total_relation_size('overlay_admitted_utxos')) AS size,
       COUNT(*) FILTER (WHERE removed = false) AS live_rows,
       COUNT(*) FILTER (WHERE removed = true)  AS removed_rows
  FROM overlay_admitted_utxos;
"
```

A healthy table is < 500 MB with `removed_rows` only a few days' worth of activity. If `removed_rows` is in the millions, force a manual run with `curl -H 'x-gaialog-internal-secret: <secret>' https://<host>/api/maintenance/retention` and consider lowering `RETENTION_UTXO_PRUNE_DAYS`.

### Stale UTXO locks ("No inventory UTXOs available" with a non-empty pool)

A lock (`locked = true`) is only meant to be held for the seconds between
acquire and release/consume. If the process dies in that window — including
PM2's 30-minute `cron_restart` — the row stayed locked forever (observed in
production: a reserve UTXO locked since April starving the splitter, which
degraded the whole pool to sub-dust outputs). The maintainer now runs
`reapStaleLocks()` (lib/utxo-inventory.ts) every inventory-log interval
(default 5 min), releasing anything locked for more than 15 minutes. Check
suspects with:

```bash
psql "$DATABASE_URL" -c "
SELECT wallet_index, utxo_role, COUNT(*), MIN(locked_at)
  FROM overlay_admitted_utxos
 WHERE removed = false AND locked = true
 GROUP BY wallet_index, utxo_role;
"
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
