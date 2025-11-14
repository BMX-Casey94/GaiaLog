# GaiaLog – WhatsOnChain Data Plugin Plan

This document outlines how we’ll build and ship a WhatsOnChain (WoC) Data plugin that decodes GaiaLog OP_RETURN outputs and renders a clean, branded, type‑aware view for users.

References:
- WoC Plugins docs: https://docs.whatsonchain.com/woc-plugins
- Example plugins repository: https://github.com/teranode-group/woc-plugins-example


## Objectives

- Detect and decode GaiaLog transactions on Whatsonchain’s OP_RETURN decode panel.
- Render a branded and readable panel that adapts to `data_type`: `air_quality`, `water`, `seismic`, `advanced_metrics`.
- Verify optional integrity features (payload SHA‑256 push) and handle optional compression (`encoding=gzip` push).
- Keep it fast, safe (sanitised), and mobile‑friendly.


## Identification (GaiaLog v1)

- Script begins with OP_FALSE OP_RETURN or OP_TRUE OP_RETURN: `00 6a …` or `51 6a …`
- Push 1 (UTF‑8): `GaiaLog` (hex `476169614c6f67`) – case‑sensitive
- Push 2 (UTF‑8): `v1` (hex `7631`) – case‑sensitive
- Push 3: payload as UTF‑8 JSON using standard pushdata (`4c`/`4d`/`4e` as needed)
- Optional pushes (in order, may appear after payload):
  1) A raw 32‑byte SHA‑256 of the exact payload bytes
  2) UTF‑8 string `encoding=gzip` if the payload is gzipped

Representative prefix (non‑normative):

```
(00|51) 6a 07 476169614c6f67 02 7631 …
```

Notes:
- Current default in our project is OP_FALSE OP_RETURN; OP_TRUE OP_RETURN (1 sat output) is enabled when the env flag is set.
- Identification must rely only on the first two pushes to remain robust to optional extras.


## Plugin Type and Placement

- Primary: Data plugin (WoC renders our webhook response within the OP_RETURN decode UI).
- Optional later: Transaction plugin to add a dedicated “GaiaLog” tab on TX pages (summary with deep link).


## Webhook Contract

WoC will call a webhook URL we provide (see “Publishing” below). We’ll support two invocation modes for flexibility (either can be used by WoC depending on configuration or future needs):

1) Path‑based (aligning with example repo patterns):
   - `GET https://<host>/data-decode/{network}/gaialog/{txid}/{voutIndex}`
   - Inputs: `network` ∈ {`main`, `test`}, `txid` (hex), `voutIndex` (0‑based index of OP_RETURN output)
   - Our service fetches TX from WoC API and extracts the OP_RETURN script hex

2) Direct payload mode:
   - `POST https://<host>/data-decode/gaialog`
   - Body JSON: `{ "script_hex": "<locking_script_hex>", "network": "main|test", "txid": "<optional>", "vout": <optional> }`
   - We decode the provided script directly

Response format:
- Content‑Type: `text/html; charset=utf-8`
- Body: Safe HTML (no external scripts); minimal inline CSS to achieve branding and layout

Time‑outs and size limits:
- Aim to respond within ~1s; hard cap 3s
- Cap HTML output size for very large payloads (offer a “View raw” foldout)


## Decoding and Validation

Parsing pipeline:
1) Parse the locking script hex and assert the prefix is 00/51 then 6a (OP_RETURN)
2) Read pushes (support direct length, PUSHDATA1 `4c`, PUSHDATA2 `4d`, PUSHDATA4 `4e`)
3) Validate Push 1 = `GaiaLog` (exact), Push 2 = `v1` (exact)
4) Extract payload bytes from Push 3
5) If present, extract optional 32‑byte hash push and `encoding=gzip` push (in that order)
6) If hash is present, compute SHA‑256 over the exact payload bytes (compressed form if gzip) and verify match
7) If `encoding=gzip`, gunzip the payload bytes
8) Parse JSON

Expected payload envelope (top‑level fields we emit today):
- `app: "GaiaLog"`
- `data_type: "air_quality" | "water" | "seismic" | "advanced_metrics"`
- `timestamp: number (ms since epoch)`
- `payload: object` – normalised reading fields (see below)
- Optional: `provider: string`
- Optional: `payload_sha256: string` (when included inside JSON)
- Optional: `db_source_hash: string`
- Optional: `location: string` and/or `location_ascii: string` (ASCII fallback for display)

Errors:
- Any decode/validate error should return a small, readable HTML explaining the issue and offering a “view raw hex” option for debugging.


## Rendering (Type‑Aware)

Common header:
- Title: “GaiaLog v1”
- Badges: data type, provider (if present), spendability (shows “1‑sat output” if OP_TRUE)
- Timestamp in ISO (and relative “time ago” if we decide to add), location (prefer `location_ascii` when present)
- Verification indicator if optional hash push matched

Styling:
- Brand colours: background `#1d003b`, text `#FFFFFF`; soft cards with `#ffffff22` backgrounds, rounded corners
- Mobile‑first layout; responsive grid on wide screens
- No external CSS/JS; inline styles only; accessible contrast and semantic markup

Data sections (render only present/known fields; hide empty):
- Air quality (`data_type=air_quality`)
  - Highlight AQI prominently
  - Grid/table for: PM2.5, PM10, CO, NO2, O3
  - Optional colour band for AQI range
- Water (`data_type=water`)
  - Level, temperature, flow, pH, turbidity, salinity (units shown when known)
- Seismic (`data_type=seismic`)
  - Magnitude, depth (miles), coordinates, event time
- Advanced Metrics (`data_type=advanced_metrics`)
  - Category‑grouped metrics if available; otherwise a neat key‑value table

Footer:
- “Open in GaiaLog” link to our site, passing the `txid` (e.g. `https://gaialog.world/tx/{txid}`)


## Security and Safety

- Strictly escape/sanitise all strings from the payload before inserting into HTML
- Do not load external scripts, images, iframes, or fonts
- Cap maximum HTML output length; elide or fold overly large objects
- Avoid leaking internal errors; log them server‑side, return a generic message client‑side


## Performance and Caching

- Cache decoded HTML by `{network}:{txid}:{voutIndex}` for 15–60 minutes
- Use ETag or `Cache-Control: public, max-age=900` when appropriate
- Network calls to WoC API with short time‑outs and retry/backoff


## Testing

Cover the following cases:
- OP_FALSE OP_RETURN and OP_TRUE OP_RETURN
- Gzipped payloads (`encoding=gzip` push)
- Optional 32‑byte hash push present and matching
- Missing/incorrect hash push (should warn but still render if identification passed)
- Malformed JSON payload (graceful error panel)
- Non‑GaiaLog or wrong version (return a small “not GaiaLog v1” panel)

Use our representative TXIDs and at least one gzipped example. Confirm the rendered output matches design across desktop and mobile.


## Deployment

We have two viable approaches; both are acceptable to WoC:

1) Reuse our existing app (recommended):
   - Implement a Next.js route at `app/api/woc/plugins/gaialog-data` that supports both path‑style and direct payload mode
   - Deploy with our site so the webhook runs under `https://gaialog.world`

2) Standalone microservice (Node/Express or Fastify) hosted separately:
   - Mirror the example repo’s route shapes under `/data-decode/...`
   - Provide a stable HTTPS endpoint for WoC


## WoC Setup and Publishing

1) Navigate to Whatsonchain → Plugins → Manage Plugins → Lab tab (local, browser‑scoped) – see docs:
   - https://docs.whatsonchain.com/woc-plugins
2) Create a new “Data” plugin:
   - Name: “GaiaLog Decoder”
   - Webhook URL: `https://gaialog.world/data-decode/{network}/gaialog/{txid}/{voutIndex}` (or the POST endpoint variant)
   - Preview hash: use a known GaiaLog `txid` and the OP_RETURN vout index
   - Description, logo, brand colours (#1d003b background, #FFFFFF text)
3) Verify preview renders correctly (both mobile/desktop)
4) Publish per WoC’s instructions (burger menu → Publish), if we want it public to all users
5) Optional: add a Transaction plugin for a dedicated “GaiaLog” tab


## Implementation Sketch (for later)

Suggested internal structure if we build a standalone microservice under this `woc-plugin` directory:

```
woc-plugin/
  routes/
    data-decode/
      gaialog.ts        # GET /data-decode/{network}/gaialog/{txid}/{vout}
      gaialog-post.ts   # POST /data-decode/gaialog (script_hex)
  templates/
    components/
      header.html.ts
      badges.html.ts
      cards.html.ts
    views/
      air_quality.html.ts
      water.html.ts
      seismic.html.ts
      advanced_metrics.html.ts
      error.html.ts
  utils/
    parse-pushes.ts       # OP_RETURN push parsing (00/51, 6a, 4c/4d/4e)
    decode-gaialog.ts     # GaiaLog v1 validation, gzip handling, hash verify
    escape.ts             # HTML escaping utilities
    fetch-woc.ts          # Whatsonchain API helpers
    cache.ts              # simple in-memory or LRU cache
  README.md               # this plan
```

We can also reuse our existing `lib/opreturn-validator.ts` logic from the app to avoid duplication if we implement inside the same codebase (preferred).


## Acceptance Criteria

- Correctly identifies GaiaLog v1 (`GaiaLog`, `v1`) for both OP_FALSE and OP_TRUE OP_RETURN
- Decompresses gzipped payloads; verifies optional hash push when present
- Renders a branded, type‑aware view for Air, Water, Seismic, Advanced Metrics
- Handles malformed/unknown data gracefully; never breaks WoC panel
- Returns within ~1s under normal conditions; caches output; mobile‑friendly


## Next Steps

1) Implement decode/validate utilities (reuse existing code where possible)
2) Build minimal renderer for each `data_type`
3) Expose webhook routes and deploy to a stable HTTPS URL
4) Register Data plugin in WoC “Lab” and test with representative txids
5) Iterate on design polish (icons, colour scales for AQI, etc.) and publish



