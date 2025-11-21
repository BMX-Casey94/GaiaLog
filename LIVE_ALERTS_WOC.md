# Live Alerts (WoC) – No‑DB, Vercel‑only

This feature fetches environmental data directly from WhatsOnChain (WoC) without any database. The Live Dashboard (4 cards) and all "latest" endpoints now use WoC exclusively, rotating across your 3 wallet addresses to distribute load.

## What's included

### API Routes (WoC-only, no database)

- `GET /api/air-quality/latest` – Latest air quality transaction from WoC
- `GET /api/water-levels/latest` – Latest water level transaction from WoC
- `GET /api/seismic/latest` – Latest seismic activity transaction from WoC
- `GET /api/advanced-metrics/latest` – Latest advanced metrics transaction from WoC
- `GET /api/live/woc/snapshot` – Network alerts and recent transactions snapshot

All endpoints:
- Rotate across all 3 configured wallet addresses (round-robin)
- Respect WoC rate limits (3 RPS = ~350ms minimum between requests per wallet)
- Decode OP_RETURN data from blockchain transactions
- Return 404 when no data exists (expected, not an error)

### Shared Utility

- `lib/woc-fetcher.ts` – Wallet rotation, rate limiting, and OP_RETURN decoding
  - `getAllWalletAddresses()` – Derives addresses from all configured WIFs
  - `getNextWalletAddress()` – Round-robin wallet selection
  - `findLatestByType()` – Searches all wallets for latest transaction of a type

### UI Components

- `components/sections/live-dashboard.tsx` – 4-card Live Alerts section
  - Polls WoC endpoints every 25 seconds (respects 3 RPS limit)
  - Handles 404s gracefully (no data yet is expected)
  - UK locale for times (`en-GB`)

## Environment

- `BSV_NETWORK`: `mainnet` or `testnet` (used to select `main`/`test` WoC endpoints)
- `BSV_WALLET_1_PRIVATE_KEY`, `BSV_WALLET_2_PRIVATE_KEY`, `BSV_WALLET_3_PRIVATE_KEY`: All 3 wallets are used for rotation
- `WHATSONCHAIN_API_KEY` (optional): Improves rate limits on WoC (recommended for production)

## Rate Limiting

- WoC allows **3 requests per second (RPS)**
- Each wallet address has its own rate limit tracker
- Minimum 350ms between requests per wallet (safety margin)
- Polling interval: **25 seconds** (well under the limit)
- Wallet rotation distributes load across all 3 addresses

## Vercel Constraints

- All API routes perform short, outbound requests to WoC and return immediately
- No long-lived connections or persistent state
- Client-side polling (25s interval) keeps data fresh
- Safe for Vercel serverless execution limits

## How It Works

1. **Wallet Rotation**: Each API call rotates to the next wallet address (round-robin)
2. **Rate Limiting**: Tracks last request time per wallet, enforces 350ms minimum
3. **Transaction Search**: Scans up to 25 recent transactions per wallet for matching `data_type`
4. **OP_RETURN Decoding**: Extracts and decodes GaiaLog v1 payloads (supports gzip)
5. **Fallback**: If one wallet fails, continues to next wallet automatically

## Files

- `lib/woc-fetcher.ts` – Shared WoC fetching utility with wallet rotation
- `app/api/air-quality/latest/route.ts` – Air quality endpoint (WoC-only)
- `app/api/water-levels/latest/route.ts` – Water levels endpoint (WoC-only)
- `app/api/seismic/latest/route.ts` – Seismic endpoint (WoC-only)
- `app/api/advanced-metrics/latest/route.ts` – Advanced metrics endpoint (WoC-only)
- `app/api/live/woc/snapshot/route.ts` – Network alerts snapshot
- `components/sections/live-dashboard.tsx` – 4-card Live Alerts UI (updated to use WoC endpoints)

## Notes

- **No database required** – All data comes from WoC on-demand
- **No provider API keys needed** – WoC-only approach
- **Works on localhost and Vercel** – Same code, same behaviour
- **404s are expected** – When no transactions exist yet, endpoints return 404 (handled gracefully in UI)
- **Broadcasting still uses ARC/Taal** – WoC is only for data fetching, not broadcasting


