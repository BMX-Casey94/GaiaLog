# Provider ToS and Attribution (GaiaLog)

Summary: GaiaLog displays provider attribution in the UI and excludes attribution from on-chain payloads. We obey published quotas, use conditional requests (ETag/Last-Modified), and cache appropriately to minimise provider load.

Notes per provider:

- WAQI (World Air Quality Index)
  - Attributions: Displayed in Admin UI panels where air quality data appears.
  - On-chain: Excludes attribution; payload includes source name only when needed by context.
  - Compliance: Rotating station batches, per-second/day budgets, ETag on bounds/feed endpoints, caching.
  - Docs: https://aqicn.org/json-api/doc

- WeatherAPI.com
  - Attribution: Link-back credit shown in UI where WeatherAPI-derived metrics are presented.
  - On-chain: Excludes attribution; payload uses provider timestamp fields for idempotency/freshness.
  - Compliance: Hourly cadence, 60m TTL caching, Last-Modified conditional requests.
  - Docs: https://www.weatherapi.com/docs/

- OpenWeatherMap (OWM)
  - Attribution: Displayed in UI where OWM-derived metrics are shown.
  - On-chain: Excludes attribution; payload includes source identifier only.
  - Compliance: One Call 3.0 current with 15m TTL cache, per-provider budgets.
  - Docs: https://openweathermap.org/api/one-call-3

- NOAA (CO-OPS / NDBC)
  - Attribution: Displayed in UI for water levels and wave data.
  - On-chain: Excludes attribution; payload includes station id/timestamps.
  - Compliance: 5 rps and ~10k/day budgets, ETag on stations list, hourly cadence, per-call budgets.
  - Docs: https://www.ncdc.noaa.gov/cdo-web/webservices/v2

- USGS
  - Attribution: Displayed in UI for seismic.
  - On-chain: Excludes attribution; payload carries event_id/location/time.
  - Compliance: 15m cadence with temporary 5m burst after significant events.
  - Docs: https://api.waterdata.usgs.gov/docs/ogcapi

This policy will be revisited if a provider’s ToS requires explicit on-chain attribution. As of now, UI-only attribution suffices and reduces payload size while keeping provenance intact via TXIDs.


