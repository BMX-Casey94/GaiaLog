# GaiaLog Documentation

This directory contains the canonical, current documentation for the repository.

Use these files as the source of truth:

- `getting-started.md`: local setup, development workflow, and minimum environment
- `deployment.md`: production topology, environment split, and verification
- `bsv-and-blockchain.md`: wallets, broadcast path, overlay behaviour, and rollout notes
- `data-sources-and-keys.md`: provider coverage, rollout gates, and API key requirements
- `explorer-and-indexing.md`: explorer data path, overlay mode, and address-based sync
- `operations-and-runbooks.md`: VPS maintenance, monitoring, and incident-only procedures
- `whats-on-chain-plugin.md`: overview of the standalone WoC plugin package
- `project-history.md`: compact historical summary of the retired phase and fix notes

## Which env file to use

- `env.example`
  Use this as the minimal, contributor-friendly local starting point.

- `env.template`
  Use this as the broad merged reference and sync source for advanced or operational variables.

- `env.vercel.template`
  Use this for the read-only web runtime on `Vercel`.

- `env.vps.template`
  Use this for the dedicated worker and overlay host on the `VPS`.

## Reading order

1. Start with `getting-started.md`.
2. Read `deployment.md` before putting anything into production.
3. Read `bsv-and-blockchain.md` before changing wallets, overlay, or queue settings.
4. Read `operations-and-runbooks.md` before performing maintenance or incident response.
