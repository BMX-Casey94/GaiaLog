# GaiaLog API Keys Guide

This document lists where to obtain API keys for GaiaLog's key-required data providers. Keys are stored in your `.env` file and are never committed to version control.

With `GAIALOG_ROLLOUT_GATE=gate_d`, all implemented providers are enabled. Apply for keys from all providers below to maximise throughput and coverage.

---

## Core Weather & Air Quality (required for advanced metrics)

### WAQI (World Air Quality Index)
- **Signup:** https://aqicn.org/data-platform/token/
- **Env var:** `WAQI_API_KEY`
- **Notes:** Free. Agree to Terms of Service, provide email and name. Default quota: ~1,000 requests/min.

### WeatherAPI.com
- **Signup:** https://www.weatherapi.com/signup.aspx
- **Env var:** `WEATHERAPI_KEY`
- **Notes:** Free plan: 100,000 calls/month. No credit card required. Key visible after login at https://www.weatherapi.com/login.aspx

### OpenWeatherMap
- **Signup:** https://openweathermap.org/register
- **Env var:** `OWM_API_KEY`
- **Notes:** Free tier available. Verify email to receive key. Key visible under account → API keys.

### USGS (Seismic, Water, Geomagnetism, Volcanoes, MRDS)
- **Signup:** https://www.usgs.gov/developer-signup
- **Env var:** `USGS_API_KEY`
- **Notes:** Free. Used for earthquake, water, geomagnetism, volcano, and mineral resources APIs. Some endpoints work without a key but rate limits are stricter.

---

## Specialist Providers (gate_d — enabled when `GAIALOG_ROLLOUT_GATE=gate_d`)

### Copernicus CAMS (Atmosphere Monitoring)
- **Signup:** https://ads.atmosphere.copernicus.eu/
- **Env var:** `COPERNICUS_CAMS_API_KEY`
- **Notes:** Create account, then visit https://ads.atmosphere.copernicus.eu/how-to-api to obtain your API key (shown in black window). Accept Terms of Use per dataset.

### Global Forest Watch
- **Signup:** https://www.globalforestwatch.org/my-gfw (click "Sign up!" — use email/password, not social login)
- **Env var:** `GFW_API_KEY`
- **Notes:** Register → set password via Okta email → authenticate → create API key via GFW Data API. See: https://www.globalforestwatch.org/help/developers/guides/create-and-use-an-api-key/

### AISStream (Vessel Positions)
- **Signup:** https://aisstream.io/authenticate
- **Env var:** `AISSTREAM_API_KEY`
- **Notes:** Sign in with GitHub or supported auth. Create key at https://aisstream.io/apikeys

### Movebank (Animal Tracking)
- **Signup:** Create account at https://www.movebank.org/ and request API access
- **Env var:** `MOVEBANK_API_KEY`
- **Notes:** GaiaLog uses the **Movebank REST API** (`/movebank/service/public/json`) to fetch event data from studies. The [live data feeds](https://www.movebank.org/cms/movebank-content/live-data-feeds) are a separate feature (tag manufacturers pushing data into Movebank); we read via the API from studies that already have data. Token-based auth. Rate limit: 1 concurrent request per IP. Contact support@movebank.org for exemptions. See: https://github.com/movebank/movebank-api-doc

### Planning Alerts AU (NSW / Australia-wide)
- **Signup:** https://www.planningalerts.org.au/users/sign_up
- **Env var:** `PLANNING_ALERTS_AU_API_KEY`
- **Notes:** Free Community Plan for non-commercial use (100,000 applications/day). Covers NSW and Australia-wide. Create account → return to this page → create API key.

---

## Optional (higher rate limits or fallback)

### OpenSky Network
- **Signup:** https://opensky-network.org/
- **Env vars:** `OPENSKY_USERNAME`, `OPENSKY_PASSWORD`
- **Notes:** Anonymous access works but is rate-limited. Registered users get higher limits.

### WhatsOnChain (UTXO / balance reads)
- **Signup:** https://www.whatsonchain.com/developers
- **Env var:** `WHATSONCHAIN_API_KEY`
- **Notes:** Optional. Used for UTXO lookups when overlay spend source falls back to legacy, and for confirmation checks. Free tier available; paid plans for higher throughput.

---

## No Key Required

- **UK Planning Data** (`uk_planning`) — England planning applications from planning.data.gov.uk
- **Scotland Planning** (`scotland_planning`) — 34 Scottish authorities from Spatial Hub Scotland (geo.spatialhub.scot)
- **NOAA** (CO-OPS, NDBC, Space Weather), **EMSC**, **GeoNet**, **Sensor.Community**, **GBIF**, **iNaturalist**, **OBIS**, **NASA EONET**, **USFWS ECOS**, **NatureServe**, **Intermagnet**, **IRIS**, **openSenseMap**, **NASA POWER**, **IGRA2** — various free/open APIs

---

## Quick Reference

| Provider        | Env Variable              | Signup URL                                      |
|----------------|---------------------------|-------------------------------------------------|
| WAQI           | `WAQI_API_KEY`            | https://aqicn.org/data-platform/token/          |
| WeatherAPI     | `WEATHERAPI_KEY`          | https://www.weatherapi.com/signup.aspx          |
| OpenWeatherMap | `OWM_API_KEY`             | https://openweathermap.org/register             |
| USGS           | `USGS_API_KEY`            | https://www.usgs.gov/developer-signup           |
| Copernicus CAMS| `COPERNICUS_CAMS_API_KEY` | https://ads.atmosphere.copernicus.eu/           |
| Global Forest Watch | `GFW_API_KEY`        | https://www.globalforestwatch.org/my-gfw        |
| AISStream      | `AISSTREAM_API_KEY`       | https://aisstream.io/authenticate               |
| Movebank       | `MOVEBANK_API_KEY`        | https://www.movebank.org/ (then request API)    |
| Planning Alerts AU | `PLANNING_ALERTS_AU_API_KEY` | https://www.planningalerts.org.au/users/sign_up |
| OpenSky        | `OPENSKY_USERNAME`, `OPENSKY_PASSWORD` | https://opensky-network.org/           |
| WhatsOnChain   | `WHATSONCHAIN_API_KEY`    | https://www.whatsonchain.com/developers         |
