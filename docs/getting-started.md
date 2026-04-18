# Getting Started

This guide covers the recommended local development setup for GaiaLog.

## Prerequisites

- `Node.js 20+`
- `npm`
- a `Supabase` project
- `BSV` mainnet wallet WIFs
- provider API keys for any sources you want enabled locally

## 1. Install dependencies

```bash
git clone <your-repository-url>
cd GaiaLog
npm install
```

## 2. Create a local environment file

```bash
cp env.example .env
```

Use `env.example` as the minimal contributor starting point. You can optionally use `.env.local` for machine-specific overrides.

Use the other env files for deeper configuration:

- `env.template`: full merged configuration surface
- `env.vercel.template`: read-only web runtime
- `env.vps.template`: production worker and overlay runtime

## 3. Minimum required variables

The minimum local starter set is maintained in `env.example`.

For the standard local web plus overlay plus worker flow, that includes:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=replace_me
SUPABASE_SERVICE_ROLE_KEY=replace_me

PGHOST=aws-1-your-region.pooler.supabase.com
PGPORT=5432
PGUSER=postgres.your_project_ref
PGPASSWORD=replace_me
PGDATABASE=postgres

BSV_NETWORK=mainnet
BSV_WALLET_1_PRIVATE_KEY=replace_me
BSV_WALLET_2_PRIVATE_KEY=replace_me
BSV_WALLET_3_PRIVATE_KEY=replace_me

ADMIN_PASSWORD=replace_me
ADMIN_SECRET=replace_me_with_a_long_random_string

BSV_SPEND_SOURCE_MODE=overlay
GAIALOG_QUEUE_GATE_SOURCE=overlay
BSV_OVERLAY_AUTH_MODE=none
BSV_OVERLAY_PROVIDER_ID=donations-lookup
BSV_OVERLAY_LOOKUP_URL=http://127.0.0.1:3100/lookup
BSV_OVERLAY_SUBMIT_URL=http://127.0.0.1:3100/submit
GAIALOG_OVERLAY_SERVER_IDENTITY_WIF=replace_me
GAIALOG_OVERLAY_AUDIT_HMAC_SECRET=replace_me_with_a_long_random_string

EXPLORER_READ_SOURCE=overlay
EXPLORER_WRITE_MODE=overlay
```

Provider-specific API keys are intentionally not part of the minimum boot surface. Add them only for the keyed providers you actually want enabled.

## 4. Generate wallet WIFs

If you need new wallets:

```bash
node -e "const { PrivateKey } = require('@bsv/sdk'); console.log(PrivateKey.fromRandom().toWif())"
```

Run that command once per wallet and place the results in:

- `BSV_WALLET_1_PRIVATE_KEY`
- `BSV_WALLET_2_PRIVATE_KEY`
- `BSV_WALLET_3_PRIVATE_KEY`

If you are using the overlay-backed local path, generate one additional WIF for:

- `GAIALOG_OVERLAY_SERVER_IDENTITY_WIF`

## 5. Apply database migrations

```bash
npm run db:migrate
```

## 6. Start the local services

Run these in separate terminals:

```bash
npm run dev
```

```bash
npm run overlay
```

```bash
npm run workers
```

## 7. Useful local scripts

- `npm run db:migrate`
- `npm run overlay`
- `npm run workers`
- `npm run explorer:addresses`
- `npm run explorer:sync`
- `npm run sync:env:dry-run`
- `npm run sync:env`

## Local development notes

- `BSV_NETWORK` should remain `mainnet`.
- The code falls back to `gate_b` if `GAIALOG_ROLLOUT_GATE` is unset, but `env.template` intentionally ships `gate_d` to show the full configuration surface.
- `env.example` is the recommended local starting point. `env.template` is the broader operational reference.
- `explorer:sync` uses wallet-address history via `WhatsonChain`; the older websocket backfill path has been removed.
- Keep real WIFs, ARC credentials, and provider secrets out of version control.
