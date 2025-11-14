# GaiaLog Wallet Addresses Reference

This document contains the configured BSV wallet addresses used by GaiaLog for transaction broadcasting.

**Last Updated:** 2025-01-27  
**Network:** Mainnet

---

## Configured Wallets

### Wallet 1
- **Environment Variable:** `BSV_WALLET_1_PRIVATE_KEY`
- **Address:** `13S6zUA88PtDNy9DKHZuh3QQmy4d4eN4Se`
- **Purpose:** Primary broadcasting wallet (round-robin)

### Wallet 2
- **Environment Variable:** `BSV_WALLET_2_PRIVATE_KEY`
- **Address:** `127HLeWpr66JU3SDmQJ9dmjBo6RgNsRU1w`
- **Purpose:** Secondary broadcasting wallet (round-robin)

### Wallet 3
- **Environment Variable:** `BSV_WALLET_3_PRIVATE_KEY`
- **Address:** `1Jm2t7cmarKskV65UsigAr7tveS5WhPdJS`
- **Purpose:** Tertiary broadcasting wallet (round-robin)

---

## Usage

The system uses round-robin distribution across these three wallets to:
- Distribute transaction load
- Avoid UTXO contention
- Maximise parallel throughput

## Viewing Current Addresses

To view the current configured wallet addresses, run:

```bash
npx tsx scripts/list-wallet-addresses.ts
```

---

**Note:** Private keys are stored in environment variables (`.env.local`) and are never committed to version control.




