# Planning & Development Data Sources

This document describes the planning/development data providers integrated with GaiaLog. All planning data is collected by the **International Planning Worker** (umbrella worker) and mapped to the `planning_development` data family.

---

## Implemented Providers

| Country/Region | Provider ID | API / Data Source | Format | Env / Notes |
|----------------|-------------|-------------------|--------|-------------|
| **England** | `uk_planning` | planning.data.gov.uk | JSON | No key required |
| **Scotland** | `scotland_planning` | Spatial Hub Scotland (geo.spatialhub.scot) | WFS/GeoJSON | No key required; 34 authorities |
| **Australia (NSW)** | `nsw_planning` | Planning Alerts API (planningalerts.org.au) | JSON | `PLANNING_ALERTS_AU_API_KEY` required |

---

## API Endpoints

### England (UK Planning)
- **URL:** `https://www.planning.data.gov.uk/entity.json?dataset=planning-application`
- **Params:** `limit`, `offset`
- **Response:** `{ entities: [...] }` with `entity`, `reference`, `description`, `point`, `entry_date`, `decision_date`, `organisation-entity`

### Scotland
- **URL:** `https://geo.spatialhub.scot/geoserver/sh_plnapp/wfs`
- **Params:** `service=WFS`, `version=2.0.0`, `request=GetFeature`, `typeName=sh_plnapp:pub_plnapppnt`, `outputFormat=application/json`, `count`, `startIndex`
- **Response:** GeoJSON FeatureCollection with `features[].properties.reference`, `local_auth`, `geometry`
- **Source:** [Spatial Hub Scotland](https://data.spatialhub.scot/dataset/planning_applications_official-is)

### NSW (Planning Alerts AU)
- **URL:** `https://api.planningalerts.org.au/applications.json`
- **Params:** `key`, `lat`, `lng`, `radius`, `count`, `page`
- **Response:** `{ applications: [...] }` with `id`, `council_reference`, `description`, `lat`, `lng`, `date_received`, `authority`
- **Signup:** https://www.planningalerts.org.au/users/sign_up (free Community Plan for non-commercial)

---

## Planned Providers (Phase B–G)

| Country/Region | Provider | Source | Notes |
|----------------|----------|--------|-------|
| Canada (Vancouver) | `vancouver_permits` | Vancouver Open Data | Socrata |
| Canada (Edmonton) | `edmonton_permits` | Edmonton Open Data | Socrata |
| USA (Montgomery Co) | `montgomery_permits` | data.montgomerycountymd.gov | Socrata |
| USA (Sonoma Co) | `sonoma_permits` | data.sonomacounty.ca.gov | JSON |
| USA (San Francisco) | `sf_planning` | SF Open Data | JSON |
| Ireland | `ireland_planning` | data.gov.ie ESRI FeatureServer | GeoJSON |
| France | `france_planning` | data.gouv.fr SITADEL | CSV/JSON |
| Germany (Dortmund) | `dortmund_permits` | open-data.dortmund.de | JSON |
| Netherlands | `netherlands_permits` | Amsterdam Datapunt | JSON |
| Sweden | `sweden_planning` | Boverket Planbestämmelsekatalogen | JSON |
| Spain (Gipuzkoa) | `gipuzkoa_planning` | Datos.gob.es | JSON |
| Norway | `norway_planning` | data.norge.no | OGC API |
| Denmark | `denmark_planning` | Plandata.dk | WFS |
| Finland (Helsinki) | `helsinki_permits` | avoindata.fi | PXWEB |
| Poland | `poland_planning` | dane.gov.pl | JSON |
| Portugal | `portugal_planning` | dados.gov.pt | REST |
| Italy | `italy_planning` | dati.gov.it | CKAN |
| South Korea | `south_korea_planning` | data.go.kr (MOLIT) | JSON |
| Australia (Victoria) | `victoria_planning` | data.vic.gov.au | Esri REST |
| UAE (Dubai) | `dubai_permits` | Dubai Pulse | REST |
| Singapore | `singapore_ura` | URA Data Service | Registration required |
| Japan | `japan_planning` | MLIT Reinfolib | API key required |
| India (Surat) | `surat_planning` | data.gov.in | JSON |
| South Africa (eThekwini) | `ethekwini_permits` | EDGE Open Data | XLSX/API |
| China (Shenzhen) | `shenzhen_planning` | opendata.sz.gov.cn | JSON |
| Taiwan | `taiwan_planning` | data.gov.tw | CSV/API |
| Hong Kong | `hongkong_permits` | data.gov.hk | CSV/API |
| Thailand | `thailand_planning` | api.data.go.th | REST |
| Malaysia | `malaysia_planning` | api.data.gov.my | REST |
| Indonesia | `indonesia_planning` | data.go.id (IMB) | JSON |
| Philippines | `philippines_planning` | openstat.psa.gov.ph | PC-Axis |
| Turkey (Istanbul) | `istanbul_permits` | data.ibb.gov.tr | JSON |
| Bangladesh | `bangladesh_planning` | data.gov.bd / ECPS | JSON |
| Austria | `austria_planning` | data.statistik.gv.at | CSV |
| Belgium | `belgium_planning` | statbel.fgov.be | TXT/XLSX |
| Greece | `greece_planning` | ELSTAT | - |
| Romania | `romania_planning` | data.gov.ro | API |
| Czech Republic | `czech_planning` | csu.gov.cz | Time series |
| Peru | `peru_planning` | datosabiertos.gob.pe | DKAN |
| Saudi Arabia | `saudi_planning` | data.kapsarc.org | JSON |
| Morocco | `morocco_planning` | data.gov.ma | CKAN |

---

## Environment Variables

| Variable | Provider | Purpose |
|----------|----------|---------|
| `PLANNING_ALERTS_AU_API_KEY` | nsw_planning | Planning Alerts AU API key (free Community Plan) |
| `SCOTLAND_PLANNING_ENABLED` | scotland_planning | Override to `false` to disable |
| `SCOTLAND_PLANNING_WORKER_INTERVAL_MS` | scotland_planning | Poll interval (default 24h) |
| `NSW_PLANNING_ENABLED` | nsw_planning | Override to `true` when key is set |
| `UK_PLANNING_ENABLED` | uk_planning | Override to `false` to disable |

---

## Architecture

- **Worker:** `InternationalPlanningWorker` (workerId: `international-planning`)
- **Family:** `planning_development`
- **Collectors:** Each provider has a collector in `lib/data-collector.ts` and is registered in `PLANNING_COLLECTOR_MAP` in `lib/worker-threads.ts`
- **Registry:** Provider IDs and dataset configs in `lib/stream-registry.ts` and `lib/provider-registry.ts`
