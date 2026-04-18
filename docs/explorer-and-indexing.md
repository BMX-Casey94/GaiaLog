# Explorer and Indexing

GaiaLog includes an explorer for browsing on-chain environmental readings and the indexed metadata around them.

## Explorer runtime flags

Keep these explicit in production:

```bash
EXPLORER_READ_SOURCE=overlay
EXPLORER_WRITE_MODE=overlay
```

The code currently defaults to overlay if these values are absent.

## Explorer sync settings

Optional address-history sync uses these variables:

```bash
EXPLORER_SYNC_START_BLOCK=720000
EXPLORER_SYNC_BATCH_SIZE=20
```

## Wallet addresses for indexing

The explorer also needs the broadcast wallet addresses:

```bash
BSV_WALLET_1_ADDRESS=
BSV_WALLET_2_ADDRESS=
BSV_WALLET_3_ADDRESS=
```

Generate or confirm them with:

```bash
npm run explorer:addresses
```

## Useful scripts

- `npm run explorer:addresses`
- `npm run explorer:sync`

`explorer:sync` scans configured wallet address history via `WhatsonChain` and writes decoded GaiaLog readings through the configured explorer write path.

## Production guidance

- use the overlay explorer path after the relevant migration is applied
- avoid mixed legacy and overlay writes unless you are deliberately doing a short-lived shadow or migration exercise
- keep explorer write and read modes aligned unless you have a specific migration plan
- the active repository no longer depends on the retired websocket backfill path

## Common failure mode

If you see explorer writes targeting `explorer_readings` when that table is not present, your runtime flags are likely incorrect. Set:

```bash
EXPLORER_READ_SOURCE=overlay
EXPLORER_WRITE_MODE=overlay
```
