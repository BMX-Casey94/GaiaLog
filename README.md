# GaiaLog

GaiaLog collects public environmental readings from multiple global data sources, writes normalised payloads to the BSV blockchain, and exposes a searchable explorer over the indexed results.

This repository contains:

- a `Next.js` web app and API surface
- a dedicated worker pipeline for collection, queueing, signing, and broadcast
- an overlay-backed UTXO and explorer data path
- deployment templates for a split `Vercel` plus `VPS` production topology

## Architecture

```text
Data providers -> workers -> queue -> BSV broadcast
                         \-> overlay services -> explorer index
```

Production is designed as:

- `Vercel` for the web UI and read-side API routes
- a `VPS` for workers, queue mutation, overlay services, and signing
- `Supabase / Postgres` as the shared system of record

## Quick Start

### Prerequisites

- `Node.js 20+`
- a `Supabase` project
- `BSV` mainnet wallet WIFs
- provider API keys for the data families you want enabled

### Install

```bash
git clone <your-repository-url>
cd GaiaLog
npm install
```

### Configure environment

```bash
cp env.example .env
```

`env.example` is the accurate minimal local starter file. It covers the database, wallet, admin, and overlay settings needed for the default local development flow.

Run the migrations:

```bash
npm run db:migrate
```

Start the local services:

```bash
npm run dev
npm run overlay
npm run workers
```

## Documentation

Canonical project documentation now lives under `docs/`.

- `docs/README.md`: documentation index
- `docs/getting-started.md`: local setup and development
- `docs/deployment.md`: production topology, env split, and verification
- `docs/bsv-and-blockchain.md`: wallets, queueing, overlay, broadcast, and rollout
- `docs/data-sources-and-keys.md`: provider coverage, API keys, and rollout gates
- `docs/explorer-and-indexing.md`: explorer, overlay indexing, and wallet address sync
- `docs/operations-and-runbooks.md`: VPS updates, monitoring, and emergency procedures
- `docs/whats-on-chain-plugin.md`: overview of the standalone WoC plugin package
- `docs/project-history.md`: compact historical context for the retired phase and fix notes

## Community

- `CONTRIBUTING.md`: contributor workflow and expectations
- `SECURITY.md`: vulnerability reporting guidance
- `CODE_OF_CONDUCT.md`: participation standards

## Key Conventions

- `Mainnet` only
- keep all real secrets in environment variables or deployment platform settings
- do not place wallet WIFs or ARC credentials in `Vercel`
- start from `env.example` for local development, then use `env.template`, `env.vercel.template`, and `env.vps.template` for advanced and production configuration
- use `env.vercel.template` and `env.vps.template` for production, not the generic merged template alone

## Repository Layout

```text
app/                  Next.js app router, pages, and API routes
db/migrations/        SQL migrations
docs/                 Canonical project documentation
lib/                  Core runtime, blockchain, overlay, and explorer logic
scripts/              Operational and development scripts
woc-plugin/           Standalone WhatsOnChain plugin package
```

## Related Package

The WhatsOnChain data plugin lives in `woc-plugin/gaialog-plugin`. Its package-specific usage and webhook details are documented in `woc-plugin/gaialog-plugin/README.md`.

## Licence

This project is released under the [MIT Licence](LICENSE).
