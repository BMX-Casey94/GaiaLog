# Project History

This document is a compact historical summary of the major workstreams that shaped the current GaiaLog repository.

It exists so the repository can stay tidy without preserving dozens of separate phase and fix-note markdown files at the root.

## Major themes

### Architecture maturation

GaiaLog evolved from a simpler app-centric flow into a split runtime model:

- web UI and read APIs on `Vercel`
- queueing, signing, broadcast, and overlay services on a dedicated `VPS`
- shared persistence and indexing through `Supabase / Postgres`

### BSV integration hardening

The blockchain path evolved through several iterations around:

- wallet configuration and rotation
- queue throughput and batching
- broadcast fallbacks and retry logic
- UTXO maintenance and overlay-backed selection
- explorer indexing and verification

### Dashboard and explorer evolution

The UI and explorer matured from a more direct, mixed read/write model into a cleaner read-side architecture with dedicated index and status surfaces.

### Operational reliability

Later work focused on:

- runtime role separation
- PM2-based process management
- environment template discipline
- monitoring, diagnostics, and incident-only fallback paths

## Retired document categories

The repository previously contained many one-off documents for:

- phase completion notes
- fix summaries
- implementation plans
- status snapshots
- corrected settings references
- dashboard or broadcast incident write-ups

Those were useful during active build-out, but they are no longer the best public-facing documentation surface.

## Current source of truth

For current behaviour, use:

- `README.md`
- `docs/getting-started.md`
- `docs/deployment.md`
- `docs/bsv-and-blockchain.md`
- `docs/data-sources-and-keys.md`
- `docs/explorer-and-indexing.md`
- `docs/operations-and-runbooks.md`
- `docs/whats-on-chain-plugin.md`

Treat this file as historical context only.
