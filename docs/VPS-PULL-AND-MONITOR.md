# VPS Pull and Monitoring Guide

## Is Data Being Broadcast Correctly?

**Short answer:** The 6 families with overlay data (advanced_metrics, water_levels, air_quality, space_weather, volcanic_activity, seismic_activity) **are** being broadcast and indexed correctly. The 11 families with no overlay rows are either:

1. **Disabled by rollout gate** — `GAIALOG_ROLLOUT_GATE` controls which providers run. If set to `gate_a` or `gate_b`, many families (hydrology, biodiversity, etc.) are disabled.
2. **Workers returning empty** — APIs may be failing, rate-limited, or require keys that aren't set.
3. **Broadcast pipeline issues** — Queue backpressure, UTXO exhaustion, or overlay submit failures.

| Family              | Overlay Count | Rollout Gate | Likely Cause if Missing        |
|---------------------|---------------|--------------|--------------------------------|
| advanced_metrics    | 24,196        | gate_a       | —                              |
| water_levels        | 3,324         | gate_a       | —                              |
| air_quality         | 2,795         | gate_a       | —                              |
| space_weather       | 1,631         | gate_b       | —                              |
| volcanic_activity   | 568           | gate_b       | —                              |
| seismic_activity    | 319           | gate_a       | —                              |
| geomagnetism        | 0             | gate_b       | API error or config disabled   |
| upper_atmosphere   | 0             | gate_b       | API error or config disabled   |
| hydrology          | 0             | gate_c       | Needs gate_c or higher         |
| flood_risk         | 0             | gate_c       | Needs gate_c or higher         |
| biodiversity       | 0             | gate_c       | Needs gate_c or higher         |
| conservation_status| 0             | gate_d       | Needs gate_d                   |
| land_use_change     | 0             | gate_d       | Needs gate_d + GFW API key     |
| natural_events      | 0             | gate_c       | Needs gate_c or higher         |
| mining_activity     | 0             | gate_d       | Needs gate_d                   |
| transport_tracking  | 0             | gate_d       | Needs gate_d                   |
| planning_development| 0             | gate_d       | Needs gate_d                   |

---

## 1. Pull Recent Changes on VPS

```bash
# Navigate to your clone (use the real path — e.g. `pwd` on the VPS, often ~/gaialog)
# Do NOT use the literal string "/path/to/GaiaLog"; that is only a placeholder in docs.
cd ~/gaialog

# Pull latest from master
git pull origin master

# Install dependencies if package-lock.json / package.json changed (prefer reproducible installs)
npm ci
# or: npm install
# or: pnpm install

# Rebuild Next.js if the app changed
npm run build

# Restart processes (names must match `pm2 list` on your host)
pm2 restart gaialog-web
pm2 restart gaialog-workers
# If you run overlay lookup/submit on the same machine:
# pm2 restart gaialog-overlay

# If using systemd instead of PM2:
# sudo systemctl restart gaialog-web gaialog-workers

# If running workers directly (foreground):
# Stop the current process (Ctrl+C) and restart:
# npm run workers
```

### 1b. Update `.env` when the repo adds new variables

`git pull` **does not** change your VPS `.env`. Use the **automated merge** (appends only **missing** keys from `env.template`; it **never overwrites** existing secrets):

```bash
cd /opt/gaialog   # or ~/gaialog — use your real clone path
git pull origin master
npm run sync:env:dry-run        # optional: list keys that would be appended (use this on Windows)
npm run sync:env                # appends missing keys to the end of .env (never overwrites existing lines)

pm2 restart gaialog-web gaialog-workers gaialog-overlay --update-env
pm2 save
```

If `.env` does not exist yet, `npm run sync:env` copies `env.template` → `.env` once.

**Manual fallback:** compare variable names only with `comm` + `grep` (see older revisions of this doc) if you cannot run Node.

### 1c. GorillaPool `SEEN_IN_ORPHAN_MEMPOOL` vs TAAL 460 / WoC “Missing inputs”

If logs show `trying next broadcaster … BSV_ARC_ACCEPT_ORPHAN_MEMPOOL`, you have **`BSV_ARC_ACCEPT_ORPHAN_MEMPOOL=false`** in the environment (often from an old `.env` line or PM2 env). That **rejects** a valid GorillaPool 200 response and guarantees failure when fallbacks cannot see parent txs.

```bash
grep -n BSV_ARC_ACCEPT_ORPHAN_MEMPOOL /opt/gaialog/.env
# Remove the line, or comment it out, or set: BSV_ARC_ACCEPT_ORPHAN_MEMPOOL=true
pm2 restart gaialog-web gaialog-workers gaialog-overlay --update-env
```

Also check PM2 did not freeze an old value: `pm2 show gaialog-workers | grep -i orphan` (if your ecosystem injects it, fix the ecosystem file).

**Stale PM2 env:** If `.env` is correct but logs still show the old orphan message, PM2’s saved process env can still carry `BSV_ARC_ACCEPT_ORPHAN_MEMPOOL=false`. By default, `dotenv` does not override existing `process.env` keys — GaiaLog now loads `.env` with `override: true` in `run-workers.ts`, `run-overlay-server.ts`, and `next.config.mjs` after you `git pull`. Until then, either:

```bash
export BSV_ARC_ACCEPT_ORPHAN_MEMPOOL=true
pm2 restart gaialog-workers gaialog-web gaialog-overlay --update-env
pm2 save
```

or remove that variable from your PM2 ecosystem / `pm2 delete` + fresh `pm2 start` so it is not injected before Node starts.

### 1a. Trigger UTXO cache refresh (web) and split tooling

`GET`/`POST` `/api/blockchain/refresh-utxos` only clears/refetches UTXO state inside **that Next.js process**. **Worker** processes hold separate in-memory overlay caches — after chain moves or overlay DB updates, restart workers: `pm2 restart gaialog-workers`.

```bash
# Optional: refresh UTXO caches in the web app (localhost or your public URL + auth if required)
curl -sS -X POST "http://127.0.0.1:3000/api/blockchain/refresh-utxos"

# Dry-run a split (no broadcast); then remove --dry-run when satisfied
npm run split:utxos -- --wallet 0 --outputs 200 --amount 2000 --dry-run
# Live broadcast (ensure BSV_GORILLAPOOL_API_KEY / BSV_ARC_API_KEY / WoC key as appropriate)
# npm run split:utxos -- --wallet 0 --outputs 200 --amount 2000
```

**Production note:** Size treasury splits against expected throughput and per-wallet balance (many deployments target on the order of **~0.75 BSV** operational balance per hot wallet; adjust `--outputs` / `--amount` accordingly).

---

## 2. Monitor Logs for Missing Data Broadcasts

### Check rollout gate and enabled providers

```bash
# Inspect env (don't expose secrets)
grep GAIALOG_ROLLOUT_GATE .env
# Should be gate_d to enable all families
```

### PM2 (if workers run under PM2)

```bash
# Live tail of worker logs
pm2 logs gaialog-workers --lines 200

# Filter for errors
pm2 logs gaialog-workers --err --lines 100

# Filter for specific workers (Geomagnetism, Upper Atmosphere, etc.)
pm2 logs gaialog-workers 2>&1 | grep -E "Geomagnetism|UpperAtmosphere|GBIF|USGS-Water|NASA-EONET|OpenSky|International-Planning"

# Filter for broadcast/queue activity
pm2 logs gaialog-workers 2>&1 | grep -E "Direct broadcast|Queued|Error collecting|Error fetching"
```

### Direct process (if workers run via npm run workers)

```bash
# If output goes to a log file:
tail -f /path/to/gaialog-worker.log

# Or run in foreground with tee to file and screen:
npm run workers 2>&1 | tee -a worker-debug.log
```

### Grep patterns for missing families

| Family              | Worker Name / Log Pattern                    |
|---------------------|----------------------------------------------|
| geomagnetism        | `Geomagnetism-USGS` / `Error fetching geomagnetism` |
| upper_atmosphere   | `UpperAtmosphere-IGRA` / `Error fetching upper atmosphere` |
| hydrology           | `USGS-Water` / `UkEaFlood`                    |
| flood_risk          | `UkEaFlood`                                  |
| biodiversity        | `GBIF` / `INaturalist` / `Obis` / `Movebank` |
| natural_events      | `NASA-EONET`                                 |
| mining_activity     | `UsgsMrds`                                   |
| transport_tracking  | `OpenSky` / `AisStream`                       |
| planning_development| `International-Planning`                    |

### One-liner to watch for errors in missing families

```bash
pm2 logs gaialog-workers --lines 0 2>&1 | grep -iE "Error|❌|Geomagnetism|UpperAtmosphere|GBIF|USGS-Water|UkEaFlood|NASA-EONET|OpenSky|International-Planning|UsgsMrds|GfwWorker"
```

### Check worker status via API (if Next.js is running)

```bash
curl -s http://localhost:3000/api/workers/status | jq .
# or
curl -s http://localhost:3000/api/bsv/workers | jq .
```

### Check throughput/queue status

```bash
curl -s "http://localhost:3000/api/throughput/status" | jq '.providers[] | select(.enabled == true) | {id, family, enabled}'
```

---

## 3. Quick Diagnostic Checklist

1. **Rollout gate:** `GAIALOG_ROLLOUT_GATE=gate_d` in `.env` to enable all families.
2. **JungleBus / overlay indexer:** Ensure `explorer:sync` or `explorer:backfill` is running if overlay is populated from chain scan.
3. **API keys:** Some providers need keys (e.g. `GFW_API_KEY` for land_use_change, `MOVEBANK_*` for Movebank).
4. **Overlay write:** Confirm `EXPLORER_WRITE_MODE` and overlay submit URLs are correct so broadcasts are indexed.

---

## Troubleshooting: Common Log Errors

### 1. `Explorer addReading error: Could not find the table 'public.explorer_readings' in the schema cache`

**Cause:** `EXPLORER_WRITE_MODE=dual` writes to both legacy (`explorer_readings`) and overlay (`overlay_explorer_readings`). The legacy table does not exist — the project uses `overlay_explorer_readings` only.

**Fix:** Set both to overlay in `.env`:

```bash
EXPLORER_READ_SOURCE=overlay
EXPLORER_WRITE_MODE=overlay
```

Then restart workers: `pm2 restart gaialog-workers`

---

### 2. `[UTXO Provider] Failed to fetch UTXOs for ...: 404 404 page not found`

**Cause:** The overlay service at `BSV_OVERLAY_LOOKUP_URL` (e.g. `http://127.0.0.1:3100/lookup`) is returning 404. The overlay server may not expose the expected lookup path, or the overlay process is not running.

**Fix:**
- Ensure `gaialog-overlay` is running: `pm2 list` → `gaialog-overlay` should be online
- Check overlay logs: `pm2 logs gaialog-overlay`
- Verify `BSV_OVERLAY_LOOKUP_URL` and `BSV_OVERLAY_SUBMIT_URL` in `.env` match the overlay server’s actual routes

---

### 3. `UTXO gate paused (items=..., okWallets=0/3, minConf=0/10)`

**Cause:** All 3 wallets report 0 confirmed UTXOs. Usually a consequence of (2) — overlay lookup failing, so the spend source cannot find UTXOs.

**Fix:** Resolve the overlay 404 first. If using legacy wallets instead of overlay, set `BSV_SPEND_SOURCE_MODE=legacy` (or configure overlay correctly).

---

### 4. `Error fetching upper atmosphere data: Error: HTTP 400`

**Cause:** The IGRA2 API is rejecting the request (bad parameters, rate limit, or API change).

**Fix:** Check `lib/data-collector.ts` `collectUpperAtmosphereData` — the NOAA IGRA2 endpoint may require different query params. This is an upstream API issue; the worker will retry on the next cycle.

---

### 5. `WoC backoff for 120s: confirmation HTTP 429`

**Cause:** WhatsOnChain is rate-limiting (429 Too Many Requests).

**Fix:** Wait for the backoff to expire. Consider reducing WoC confirmation polling frequency or using a different confirmation source if available.

---

### 6. `Geomagnetism-USGS: Processed 0 data points` / `UpperAtmosphere-IGRA: Processed 0 data points`

**Cause:** The USGS geomagnetism or IGRA2 API returned no data or errored. Workers run but get empty responses.

**Fix:** Check worker error logs for HTTP 4xx/5xx. These are upstream API issues; no code change needed unless the API contract has changed.

---

### 7. `Queue backpressure: holding noaa_space_weather_rtsw at 800/800 in-flight items`

**Cause:** Space weather (or another high-volume provider) has hit its `maxInFlight` limit. The queue is full and cannot accept more until some items are broadcast.

**Fix:** Resolve UTXO/overlay issues so broadcasts can complete. Once the queue drains, backpressure will ease.

---

### 8. Treasury UTXOs: overlay shows rows but writes stall (`No UTXOs` or queue paused)

**Cause:** Two different confirmation policies:

- **`BSV_MIN_SPEND_CONFIRMATIONS`** — spend path: `> 0` means only overlay rows with `confirmed=true` are listed for `writeToChain`. If your DB never sets `confirmed`, counts with `confirmedOnly=true` are zero even when `confirmedOnly=false` shows many rows.
- **`BSV_UTXO_MIN_CONFIRMATIONS`** — queue gate + UTXO maintainer inventory: unset defaults to **1** (conservative). Set **`BSV_UTXO_MIN_CONFIRMATIONS=0`** explicitly if you want the maintainer and pause gate to count **unconfirmed** overlay rows (align with `BSV_MIN_SPEND_CONFIRMATIONS=0`).

**Ops:** After deploy, set `GAIALOG_UTXO_HEALTH_SECRET` (≥8 characters) in `.env` and call:

```bash
curl -sS "https://your-host/api/blockchain/utxo-health" \
  -H "x-gaialog-utxo-health-secret: YOUR_SECRET"
```

Response includes per-wallet `totalSpendable` vs `confirmedSpendable` and active policy values. See `env.template` for `BSV_OVERLAY_EMPTY_DRIFT_RETRY`, `BSV_UTXO_MAINTAINER_INVENTORY_LOG_INTERVAL_MS`, and `BSV_UTXO_DRIFT_LOG_INTERVAL_MS`.
