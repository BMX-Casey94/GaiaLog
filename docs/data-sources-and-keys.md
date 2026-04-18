# Data Sources and Keys

GaiaLog ingests from multiple provider families and enables them progressively through rollout gates.

## Rollout gates

Provider rollout is controlled by:

```bash
GAIALOG_ROLLOUT_GATE=gate_a|gate_b|gate_c|gate_d
```

In code, the fallback is `gate_b` when unset. In `env.template`, the example is `gate_d` so the broadest configuration surface is visible.

## Core providers

These are the most immediately useful providers for a typical deployment:

- `WAQI`: air quality
- `NOAA CO-OPS`: water levels
- `NOAA NDBC`: marine and buoy observations
- `USGS Earthquakes`: seismic activity
- `WeatherAPI` and `OpenWeatherMap`: advanced metrics and weather enrichment
- `Sensor.Community`: citizen air quality network
- `EMSC`: seismic push and redundancy
- `GeoNet NZ`: seismic and volcanic data
- `NOAA Space Weather`: satellite and solar wind data
- `USGS Geomagnetism`: magnetic field observations
- `USGS Volcanoes`: volcanic alerts
- `IGRA2`: upper atmosphere profiles

## Specialist or later-gate providers

These generally need `gate_c` or `gate_d`, and some also need extra credentials:

- `Copernicus CAMS`
- `Global Forest Watch`
- `GBIF`
- `iNaturalist`
- `OBIS`
- `NASA EONET`
- `USFWS ECOS`
- `NatureServe`
- `USGS Water`
- `UK EA Flood`
- `OpenSky`
- `AISStream`
- `Movebank`
- `Planning Alerts AU`
- `UK planning data`

## API keys commonly required

### Recommended minimum set

```bash
WAQI_API_KEY=replace_me
WEATHERAPI_KEY=replace_me
OWM_API_KEY=replace_me
USGS_API_KEY=replace_me
```

### Additional keyed providers

```bash
COPERNICUS_CAMS_API_KEY=
GFW_API_KEY=
AISSTREAM_API_KEY=
MOVEBANK_USERNAME=
MOVEBANK_PASSWORD=
MOVEBANK_API_KEY=
PLANNING_ALERTS_AU_API_KEY=
OPENSKY_USERNAME=
OPENSKY_PASSWORD=
WHATSONCHAIN_API_KEY=
```

## Explorer and indexing keys

Explorer-related tooling may also need:

```bash
BSV_WALLET_1_ADDRESS=
BSV_WALLET_2_ADDRESS=
BSV_WALLET_3_ADDRESS=
```

Optional address-history sync can also use:

```bash
EXPLORER_SYNC_START_BLOCK=720000
EXPLORER_SYNC_BATCH_SIZE=20
```

## Source and attribution notes

- many US federal feeds are public domain
- some open datasets require attribution
- citizen-science datasets such as `Sensor.Community` and `openSenseMap` may carry ODbL-style obligations for derived databases
- always review provider terms before commercial or high-volume use

## Operational advice

- start with the providers you can actually support operationally
- do not enable high-gate providers without the required credentials and monitoring
- keep API keys only in local `.env` files or deployment platform secrets

## Planning and development sources

The `planning_development` family currently centres on an umbrella planning worker with these implemented sources:

- `uk_planning`: planning.data.gov.uk
- `scotland_planning`: Spatial Hub Scotland
- `nsw_planning`: Planning Alerts AU, using `PLANNING_ALERTS_AU_API_KEY`

These are mapped into the `planning_development` family and should be treated as slower-moving, specialist feeds rather than core ingest.

## Provider attribution and ToS

GaiaLog keeps provider attribution in the UI and operational documentation rather than embedding it into on-chain payloads.

General rules:

- display attribution where provider terms require it
- exclude bulky attribution text from on-chain payloads
- respect published quotas, cache headers, and courtesy limits
- use provider-specific budgets and cadence controls to reduce unnecessary load

This is especially relevant for sources such as `WAQI`, `WeatherAPI`, `OpenWeatherMap`, `NOAA`, and `USGS`.
