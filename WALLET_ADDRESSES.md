# GaiaLog Wallet Addresses Reference

This document describes how BSV wallets are configured for GaiaLog transaction broadcasting.

**Network:** Mainnet

---

## Configuration

GaiaLog uses up to 3 BSV wallets in round-robin for transaction distribution. Set the following environment variables in your `.env` file:

```bash
BSV_PRIVATE_KEY_1=<your_WIF_key_1>
BSV_PRIVATE_KEY_2=<your_WIF_key_2>
BSV_PRIVATE_KEY_3=<your_WIF_key_3>
```

Generate new keys with:

```bash
node -e "const { PrivateKey } = require('@bsv/sdk'); console.log(PrivateKey.fromRandom().toWif())"
```

## Usage

The system uses round-robin distribution across configured wallets to:

- Distribute transaction load
- Avoid UTXO contention
- Maximise parallel throughput

## Viewing Current Addresses

To view the currently configured wallet addresses:

```bash
npx tsx scripts/list-wallet-addresses.ts
```

---

**Note:** Private keys are stored in environment variables (`.env`) and must never be committed to version control.
