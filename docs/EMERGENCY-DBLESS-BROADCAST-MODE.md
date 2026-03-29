# Emergency DB-less Broadcast Mode

This runbook documents the temporary fallback for broadcasting when Postgres/Supabase is exhausted.

## What this changes

- `lib/blockchain.ts`
  - Adds `GAIALOG_EMERGENCY_LEGACY_UTXO` mode.
  - In emergency mode, `writeToChain()` bypasses DB inventory acquisition (`acquirePoolUtxo`) and DB inventory admission (`consumeAndAdmitChange`).
  - Uses legacy/custom spendable UTXO lookup and optional webhook sync to a local UTXO manager.
- `scripts/run-workers.ts`
  - Logs emergency mode state on startup.
- `scripts/emergency-utxo-manager.py`
  - Lightweight local UTXO manager service for temporary state tracking.
- `env.template`
  - Adds emergency env variable references.

## Important limitations

- This mode is incident-only and not for normal production.
- The Python manager does **not** discover wallet UTXOs from chain by itself.
  - You must seed UTXOs via `/admin/seed` or an external feeder.
- Retries/persistence are reduced if `BSV_BYPASS_QUEUE=true`.
- Keep this service bound to localhost and protected by a secret.

## Enable emergency mode (VPS)

Set these env values in `.env`:

```bash
GAIALOG_NO_DB=true
GAIALOG_EMERGENCY_LEGACY_UTXO=true

BSV_SPEND_SOURCE_MODE=legacy
GAIALOG_QUEUE_GATE_SOURCE=legacy
BSV_UTXO_MAINTAINER_DISABLED=true

BSV_MIN_SPEND_CONFIRMATIONS=0
BSV_UTXO_MIN_CONFIRMATIONS=0
BSV_BYPASS_QUEUE=true

BSV_UTXO_PROVIDER=custom
BSV_UTXO_ENDPOINT_TEMPLATE=http://127.0.0.1:8787/utxos/{address}
BSV_UTXO_HEADERS_JSON={"x-gaialog-utxo-manager-secret":"replace_me"}

GAIALOG_EMERGENCY_UTXO_MANAGER_URL=http://127.0.0.1:8787
GAIALOG_EMERGENCY_UTXO_MANAGER_SECRET=replace_me
GAIALOG_EMERGENCY_UTXO_MANAGER_TIMEOUT_MS=5000
```

Start local UTXO manager:

```bash
cd /opt/gaialog
pm2 start "python3 scripts/emergency-utxo-manager.py" --name gaialog-utxo-manager
pm2 logs gaialog-utxo-manager --lines 30
```

Seed wallet UTXOs (example payload):

```bash
curl -sS -X POST "http://127.0.0.1:8787/admin/seed" \
  -H "content-type: application/json" \
  -H "x-gaialog-utxo-manager-secret: replace_me" \
  --data '{
    "replace": true,
    "wallets": {
      "YOUR_WALLET_ADDRESS_1": [
        {"txid":"<txid>", "vout":0, "satoshis":10000, "confirmed":true, "script":"<hex>"}
      ],
      "YOUR_WALLET_ADDRESS_2": [],
      "YOUR_WALLET_ADDRESS_3": []
    }
  }'
```

Restart GaiaLog processes:

```bash
pm2 restart gaialog-overlay gaialog-workers --update-env
```

## Roll back to normal DB-backed mode

1. Set env back:

```bash
GAIALOG_NO_DB=false
GAIALOG_EMERGENCY_LEGACY_UTXO=false

BSV_SPEND_SOURCE_MODE=overlay
GAIALOG_QUEUE_GATE_SOURCE=overlay
BSV_UTXO_MAINTAINER_DISABLED=false
BSV_BYPASS_QUEUE=false
```

2. Disable custom emergency UTXO manager vars:

```bash
# Restore your normal provider settings for overlay/internal lookup.
# (Do not keep the emergency custom localhost UTXO endpoint enabled.)
```

3. Stop emergency manager:

```bash
pm2 delete gaialog-utxo-manager
```

4. Restart normal services:

```bash
pm2 restart gaialog-overlay gaialog-workers --update-env
```

