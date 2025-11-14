# GaiaLog WOC Data Plugin (Standalone)

Self-contained WhatsOnChain “Data” plugin that decodes and renders GaiaLog OP_RETURN transactions with a dark, glass UI and type‑aware layout (Air, Water, Seismic, Advanced Metrics). Includes friendly error messaging for non‑GaiaLog protocols (MNEE/bsv‑20 ord-style, Rekord Kloud, Treechat).

## Quick start

```bash
cd woc-plugin/gaialog-plugin
npm install
npm run dev
# → http://localhost:8787/
```

Build and run:

```bash
npm run build
npm start
```

## Endpoints

GET `/` (simple mode) or `/data-decode/{network}/gaialog/{txid}/{vout}` (WoC-style)

- Query params:
  - `network` = `main` or `test` (default `main`)
  - One of:
    - `txid` + optional `vout`
    - `script_hex`

POST `/` (simple) or `/data-decode/gaialog` (WoC-style)

- Body (JSON):
  - `network` (optional)
  - `txid` and optional `vout` OR `script_hex`
  - Or `payload_json` to preview a GaiaLog JSON payload as an OP_RETURN
  - Optional `gzip: true`, `include_hash: true` (adds SHA‑256 push), used for preview

## WOC webhook setup

Point the WOC “Data” plugin webhook URL to the WoC-style GET endpoint:

```
https://your-domain.example/data-decode/{network}/gaialog/{txid}/{vout}
```

WOC will call you with `txid` (and/or `script_hex`) – the service handles both.

## Environment

- `WHATSONCHAIN_API_KEY` (optional) — adds the header `woc-api-key` when fetching tx JSON.
- `PORT` (optional) — default `8787`.

## Features

- OP_RETURN parser accepts:
  - `OP_FALSE OP_RETURN`, `OP_TRUE OP_RETURN`, and plain `OP_RETURN`
  - Standard GaiaLog envelope: `GaiaLog`, `v1`, `<JSON payload>`
  - Legacy single-push JSON with `app: "GaiaLog"`
- UI/UX:
  - Glass cards, dark gradient, particles
  - Collapsible “Raw Payload”
  - Logo + rotating glow
  - Footer with “View on WhatsOnChain”
  - Human-readable labels for metrics
- Data types:
  - Air Quality, Water Levels, Seismic Activity, Advanced Metrics
- Non-Gaia detection and two-line friendly messages for:
  - Rekord Kloud
  - MNEE (bsv‑20/ord)
  - Treechat

## Test URLs

After `npm run dev`:

- `http://localhost:8787/data-decode/main/gaialog/<TXID>/0`
- or `http://localhost:8787/?network=main&txid=<TXID>&vout=0`
- `curl -X POST http://localhost:8787/ -H "content-type: application/json" -d '{"payload_json":"{\"app\":\"GaiaLog\",\"data_type\":\"air_quality\",\"payload\":{\"air_quality_index\":65}}"}'`

## Notes for Review

- HTML returns 200 even for non‑Gaia transactions (with friendly message), to match WOC plugin expectations.
- Water Levels display uses `(meters)` units; NOAA data is in metres when `units=metric` is used.
- The service attempts to locate the GaiaLog logo from:
  - `woc-plugin/gaialog-plugin/assets/gaialog-logo.png`
  - `public/gaialog-logo.(png|svg)`
  - `woc-plugin/GaiaLog Logo.png` (fallback for this repo)

## Deploy

- Any Node 18+ hosting works (docker, VM, serverless with Node HTTP/Express compatibility).
- Add a reverse proxy (e.g., Nginx) and TLS certificate if exposing publicly.
- Set `WHATSONCHAIN_API_KEY` if you have one.

## Security & Performance

- Input size limits via Express JSON parser (1 MB default here).
- No dynamic external loading beyond WOC tx JSON and local assets.
- Simple in‑memory cache with TTL to reduce repeated loads.

## License

MIT © GaiaLog



