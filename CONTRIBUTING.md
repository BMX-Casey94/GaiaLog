# Contributing

Thanks for contributing to GaiaLog.

This project deals with live environmental ingest, blockchain writes, overlay-backed UTXO management, and production-grade operational paths. Please optimise for correctness, clarity, and safe incremental change.

## Before you start

1. Read `README.md`.
2. Read `docs/getting-started.md`.
3. Read `docs/deployment.md` and `docs/bsv-and-blockchain.md` before changing runtime, wallet, overlay, or broadcast behaviour.

## Local setup

```bash
npm install
cp env.example .env
npm run db:migrate
```

Then run the local services in separate terminals:

```bash
npm run dev
```

```bash
npm run overlay
```

```bash
npm run workers
```

## Project expectations

- `Mainnet` only.
- Do not commit secrets, WIFs, tokens, or production environment exports.
- Do not add mock, demo, or seed data unless it is explicitly discussed and justified.
- Prefer focused pull requests over large mixed changes.
- Update docs and env files whenever behaviour, setup, or operational expectations change.
- If you touch blockchain, overlay, explorer, or deployment code, verify the docs still match the implementation.

## Coding guidelines

- Keep changes production-minded and security-conscious.
- Prefer fixing root causes over adding workarounds.
- Preserve existing user data and operational safety.
- Avoid adding new dependencies unless they are genuinely needed.
- Keep comments short and useful.

## Verification

Before opening a pull request, run the relevant checks locally:

```bash
npm run lint
npm run verify:auto-init
npm run build
```

If your change affects docs, configuration, or runtime flags, also verify:

- `README.md`
- `env.example`
- `env.template`
- `env.vercel.template`
- `env.vps.template`
- files under `docs/`

## Pull request checklist

- explain the problem and the reason for the change
- describe any operational or deployment impact
- list the checks you ran
- mention any env, schema, or documentation changes
- call out any follow-up work still needed

## Security-sensitive changes

For changes touching auth, admin routes, wallet handling, overlay endpoints, or broadcast logic:

- be explicit about risks and mitigations
- avoid widening access accidentally
- keep privileged behaviour off public or read-only runtimes
- prefer least-privilege defaults
