# BSV and Blockchain

This document summarises the parts of GaiaLog that affect wallets, transaction flow, queueing, UTXO policy, and broadcast behaviour.

## Network

GaiaLog is intended to run on `mainnet`.

Set:

```bash
BSV_NETWORK=mainnet
```

## Wallet configuration

The preferred wallet variables are:

```bash
BSV_WALLET_1_PRIVATE_KEY=replace_me
BSV_WALLET_2_PRIVATE_KEY=replace_me
BSV_WALLET_3_PRIVATE_KEY=replace_me
```

There is also legacy single-key support via `BSV_PRIVATE_KEY`, but the documented and preferred multi-wallet surface is `BSV_WALLET_*_PRIVATE_KEY`.

To inspect the derived wallet addresses:

```bash
npm run explorer:addresses
```

## Transaction flow

At a high level:

1. workers collect and normalise provider payloads
2. payloads are queued for write
3. the blockchain runtime selects a wallet and spendable UTXO set
4. transactions are signed and broadcast
5. overlay and explorer services index the results

## Queue and UTXO behaviour

The project uses:

- a queue for controlled write throughput
- wallet rotation to reduce contention
- a UTXO maintainer to keep hot wallet inventory healthy
- overlay-backed spend selection for the current production path

Important knobs include:

- `BSV_MAX_TX_PER_SECOND`
- `BSV_QUEUE_PROCESSING_INTERVAL_MS`
- `BSV_QUEUE_CONCURRENCY`
- `BSV_EXPECTED_TX_PER_DAY`
- `BSV_UTXO_MAINTAINER_INTERVAL_MS`
- `BSV_PREFER_CONFIRMED_UTXOS`

## Spend-source rollout

The main spend-source flags are:

```bash
BSV_SPEND_SOURCE_MODE=legacy
BSV_SPEND_SOURCE_SHADOW_READS=true
BSV_SPEND_SOURCE_LEGACY_FALLBACK_ENABLED=true
GAIALOG_QUEUE_GATE_SOURCE=legacy
```

or, in the more advanced production overlay setup:

```bash
BSV_SPEND_SOURCE_MODE=overlay
GAIALOG_QUEUE_GATE_SOURCE=overlay
```

Use `shadow` and legacy fallback while proving parity, then promote to overlay deliberately.

## Rollout gates

Provider availability is controlled by:

```bash
GAIALOG_ROLLOUT_GATE=gate_a|gate_b|gate_c|gate_d
```

Important nuance:

- if `GAIALOG_ROLLOUT_GATE` is unset, the code defaults to `gate_b`
- `env.template` intentionally includes `gate_d` so the full configuration surface is visible

## Broadcast endpoints

The main broadcast-related variables are:

```bash
BSV_API_ENDPOINT=https://arc.taal.com
BSV_GORILLAPOOL_ARC_ENDPOINT=https://arc.gorillapool.io
BSV_ARC_API_KEY=replace_me
```

Keep broadcast credentials on the `VPS` only.

## Overlay configuration

Typical same-host loopback configuration:

```bash
BSV_OVERLAY_LOOKUP_URL=http://127.0.0.1:3100/lookup
BSV_OVERLAY_SUBMIT_URL=http://127.0.0.1:3100/submit
BSV_OVERLAY_AUTH_MODE=none
```

If you move to explicit mutual-auth identities, use `brc104` instead and populate the client and server identity variables.

## Explorer write path

The explorer path should be kept explicit:

```bash
EXPLORER_READ_SOURCE=overlay
EXPLORER_WRITE_MODE=overlay
```

The code currently defaults to overlay if the values are absent, so the docs should not describe legacy as the active default.

## Incident-only mode

Emergency DB-less broadcasting exists only for incidents and should not be treated as the normal operating model. The operational procedure is covered in `operations-and-runbooks.md`.
