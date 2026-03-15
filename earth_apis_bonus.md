# Additional Earth Data APIs — Blockchain TX Throughput Expansion

> Focus: publicly accessible, free or open-licensed sources **not** in the original report (i.e. excluding USGS Earthquake, NOAA ERDDAP, NASA Earthdata, OpenAQ, NASA FIRMS, NOAA SWPC). All entries below are suitable for public/commercial use unless explicitly flagged. US federal sources are public domain (17 U.S.C. § 105).

---

## Quick-Reference Table

| API | Domain | Stations / Coverage | Rate Limit | Blockchain Status |
|---|---|---|---|---|
| NOAA CO-OPS Tides & Currents | Coastal oceanography | ~3,000 US + global | No published limit | ✅ SAFE — public domain |
| USGS Geomagnetism | Earth's magnetic field | 14 US observatories | No published limit | ✅ SAFE — public domain |
| INTERMAGNET | Global geomagnetism | ~130 global observatories | No published limit | ✅ SAFE — open scientific use |
| GeoNet NZ (Tilde API) | Seismic, volcano, GNSS, coastal | ~700+ NZ sensors | No published limit | ✅ SAFE — CC BY 4.0 NZ |
| IRIS/EarthScope FDSN | Global seismic waveforms | 10,000+ stations | No published limit | ✅ SAFE — public domain / open |
| Sensor.Community | Crowd-sourced air quality | ~35,000+ global sensors | No published limit (bulk endpoints) | ✅ SAFE — ODbL |
| EMSC (European-Mediterranean Seismological Centre) | Seismicity | Global events | No published limit | ✅ SAFE — open |
| NOAA NDBC Buoys | Ocean & met buoys | ~1,000+ marine buoys | No published limit | ✅ SAFE — public domain |
| openSenseMap | Citizen IoT sensors (temp, humidity, UV, etc.) | ~10,000+ global | No published limit | ✅ SAFE — ODbL |
| Copernicus CAMS (Atmosphere) | Global air quality / atmospheric composition | Global gridded | No API rate limit (quotas apply) | ✅ SAFE — CC BY 4.0 |
| NASA POWER | Surface meteorology & solar energy | Global gridded (0.5° resolution) | 30 req/day per IP (bulk) | ✅ SAFE — public domain |
| USGS Volcanoes | US volcano observatory alerts | 170+ US volcanoes | No published limit | ✅ SAFE — public domain |
| NOAA Space Weather (DSCOVR/ACE) | Solar wind, magnetosphere | Real-time satellite feeds | No published limit | ✅ SAFE — public domain |
| IGRA v2 (Radiosonde) | Atmospheric vertical profiles | ~2,700 global upper-air stations | No published limit | ✅ SAFE — public domain |

---

## Detailed Entries

### 1. NOAA CO-OPS Tides & Currents
**What it is:** Real-time and predicted water levels, tidal currents, salinity, water temperature, wind, and barometric pressure at ~3,000 coastal stations across the US and globally affiliated stations.

**Endpoints:**
- Data API: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
- Metadata API: `https://api.tidesandcurrents.noaa.gov/mdapi/prod/`
- Derived Products API: `https://api.tidesandcurrents.noaa.gov/dpapi/prod/`

**Rate limits:** No key required. No published rate limit — contact `tide.predictions@noaa.gov` for bulk use.

**Data refresh:** 6-minute interval for real-time products. Predictions available years in advance.

**Blockchain status:** ✅ US federal public domain. No restrictions.

**TX throughput potential:** ~3,000 stations × multiple products (water level, currents, met) = high density per polling cycle.

---

### 2. USGS Geomagnetism API
**What it is:** Real-time and historical measurements of the Earth's magnetic field from USGS observatories across the US and territories (14 stations including Hawaii, Alaska, Puerto Rico).

**Endpoint:** `https://geomag.usgs.gov/ws/data/`

**Parameters:** Observatory code, starttime, endtime, type (variation/adjusted/quasi-definitive/definitive), elements (X, Y, Z, F, D, H, etc.)

**Rate limits:** No key required. No published rate limit.

**Data refresh:** 1-minute cadence real-time data available. 1-second data available for some stations.

**Blockchain status:** ✅ US federal public domain.

**TX throughput potential:** Modest station count (14) but high-cadence data (1-min or 1-sec) makes it useful for filling gaps.

---

### 3. INTERMAGNET Global Geomagnetic Network
**What it is:** Global network of ~130 geomagnetic observatories providing near real-time 1-minute (and some 1-second) magnetic field measurements. Operated by the British Geological Survey Edinburgh GIN and partner institutions worldwide.

**Endpoints:**
- Web services: `https://imag-data.bgs.ac.uk/GIN_V1/GINServices`
- HAPI (Heliophysics API): `https://imag-data.bgs.ac.uk/GIN_V1/hapi`
- Capabilities: `https://imag-data.bgs.ac.uk/GIN_V1/GINServices?Request=capabilities`

**Rate limits:** No published limit. Near real-time data updated from May 2024 at 1-minute cadence per observatory.

**Blockchain status:** ✅ Open scientific data; attribution required. Free for commercial and research use.

**TX throughput potential:** ~130 global stations × 1-min data cadence. HAPI interface is well-suited for automated ingestion.

---

### 4. GeoNet NZ — Tilde API
**What it is:** New Zealand's geohazard monitoring network, providing real-time data across seismic, volcanic, coastal (tsunamis), GNSS, DART buoys, envirosensors, and gas emissions (scanDOAS). All data freely available.

**Endpoints:**
- REST API: `https://api.geonet.org.nz/`
- Tilde (time series): `https://tilde.geonet.org.nz/`
- Volcanic Alert Levels: `https://api.geonet.org.nz/volcano/val`
- FDSN seismic waveforms: `https://service.geonet.org.nz/`
- Near real-time seismic: `https://service-nrt.geonet.org.nz/`

**Rate limits:** No published rate limit. Raw data also mirrored on AWS Open Data (no rate limits).

**Blockchain status:** ✅ CC BY 4.0 New Zealand licence. Attribution required. Commercial use permitted.

**TX throughput potential:** 700+ sensors across multiple geophysical domains. Excellent diversity per call.

---

### 5. IRIS / EarthScope FDSN Seismic Web Services
**What it is:** The world's largest archive of seismic waveform data, operated by EarthScope Consortium (formerly IRIS). Provides access to waveforms, event data, and station metadata from 10,000+ global seismograph stations via FDSN-standard web services.

**Endpoints:**
- Dataselect (waveforms): `https://service.iris.edu/fdsnws/dataselect/1/`
- Event (earthquakes): `https://service.iris.edu/fdsnws/event/1/`
- Station (metadata): `https://service.iris.edu/fdsnws/station/1/`

**Rate limits:** No key required. No hard published limit — fair-use policy applies for bulk requests.

**Blockchain status:** ✅ Open data. IRIS data policy requires attribution but permits any use.

**TX throughput potential:** 10,000+ stations globally. Particularly valuable for real-time seismic stream ingestion.

---

### 6. Sensor.Community (formerly Luftdaten.info)
**What it is:** Citizen science network of ~35,000+ low-cost environmental sensors (PM2.5, PM10, temperature, humidity, pressure, noise) built and contributed by the public globally.

**Endpoints:**
- All sensors last 5 minutes: `https://data.sensor.community/static/v1/data.json`
- Dust sensors only: `https://data.sensor.community/static/v2/data.dust.min.json`
- Temperature sensors only: `https://data.sensor.community/static/v2/data.temp.min.json`
- 1-hour averages: `https://data.sensor.community/static/v2/data.1h.json`
- 24-hour averages: `https://data.sensor.community/static/v2/data.24h.json`
- Filter by area/country/type: `https://data.sensor.community/airrohr/v1/filter/{query}`

**Rate limits:** No published hard limit on bulk endpoints. Must send a User-Agent header identifying your application.

**Blockchain status:** ✅ ODbL (Open Database Licence). Share-alike applies if you distribute a derived database — functionally compatible with on-chain archiving if attribution is maintained. Non-commercial is not required.

**TX throughput potential:** 🔥 **Very high** — 35,000+ sensors with 5-minute refresh across PM, temperature, humidity, and pressure. Single JSON pull covers the entire global network.

---

### 7. EMSC — European-Mediterranean Seismological Centre
**What it is:** Real-time seismic event catalogue for European, Mediterranean, and global earthquakes. Provides near-real-time event data with rapid magnitude estimates, felt reports, and waveform archive.

**Endpoints:**
- FDSN Event: `https://www.seismicportal.eu/fdsnws/event/1/`
- Real-time WebSocket feed: `wss://www.seismicportal.eu/standing_order/websocket`
- Last events JSON: `https://www.seismicportal.eu/fdsnws/event/1/query?limit=20&format=json`

**Rate limits:** No key required. No published rate limit. WebSocket is push-based — no polling needed.

**Blockchain status:** ✅ Open access. Free for any use with attribution.

**TX throughput potential:** Moderate station count but WebSocket push means near-zero polling overhead. Pairs well with USGS Earthquake for redundancy.

---

### 8. NOAA NDBC — National Data Buoy Center
**What it is:** Real-time and historical data from ~1,000+ ocean buoys and coastal stations measuring wave height, sea surface temperature, wind, barometric pressure, air temperature, and more. Critical for ocean state monitoring globally.

**Endpoints:**
- Real-time station data: `https://www.ndbc.noaa.gov/data/realtime2/{STATION_ID}.txt`
- Station list: `https://www.ndbc.noaa.gov/activestations.xml`
- API (OGC SOS): `https://sdf.ndbc.noaa.gov/sos/server.php`
- Latest observations (all stations): `https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt`

**Rate limits:** No key required. No published rate limit.

**Blockchain status:** ✅ US federal public domain.

**TX throughput potential:** ~1,000 buoys × multiple met/ocean parameters. `latest_obs.txt` gives a single-request snapshot of all active stations.

---

### 9. openSenseMap
**What it is:** Open citizen science IoT sensor platform (Germany-based, global reach) hosting ~10,000+ environmental sensor boxes measuring temperature, humidity, UV index, PM2.5, CO2, soil moisture, illuminance and more. Fully open source.

**Endpoints:**
- All senseBoxes: `https://api.opensensemap.org/boxes`
- Latest measurements: `https://api.opensensemap.org/boxes?full=true`
- Single box: `https://api.opensensemap.org/boxes/{senseBoxId}`
- Stats: `https://api.opensensemap.org/stats`
- Docs: `https://docs.opensensemap.org/`

**Rate limits:** No key required for read access. No published hard limit. Contact `support@opensensemap.org` for bulk use.

**Blockchain status:** ✅ ODbL. Same terms as Sensor.Community — share-alike on derived databases, attribution required.

**TX throughput potential:** 10,000+ diverse IoT sensors with heterogeneous measurements. Good for supplementing air quality and microclimate data.

---

### 10. Copernicus CAMS — Atmospheric Monitoring Service
**What it is:** EU's Copernicus Atmosphere Monitoring Service provides global gridded analysis and forecast data for air quality, greenhouse gases, aerosols, ozone, and UV. Data comes from the ECMWF model system.

**Endpoints:**
- CADS (data store): `https://ads.atmosphere.copernicus.eu/api`
- OGC WMS/WFS: available via CAMS viewer
- Registration: `https://ads.atmosphere.copernicus.eu/`

**Rate limits:** Free registration required. No per-call rate limit but large requests are queued. Near-real-time (NRT) atmospheric composition updated multiple times daily.

**Blockchain status:** ✅ CC BY 4.0. Attribution required. Any use including commercial permitted.

**TX throughput potential:** Global coverage but gridded (not station-based), so not suitable for per-station polling at scale. Best used as a complementary layer for atmospheric composition data where station networks are sparse.

---

### 11. NASA POWER — Prediction of Worldwide Energy Resources
**What it is:** NASA surface meteorology and solar energy data derived from satellite remote sensing and model reanalysis. Covers global 0.5° × 0.5° grid: solar irradiance, temperature, wind, humidity, precipitation, and more. Designed for renewable energy and agricultural applications.

**Endpoints:**
- Point query: `https://power.larc.nasa.gov/api/temporal/daily/point`
- Regional query: `https://power.larc.nasa.gov/api/temporal/daily/regional`
- Climatology: `https://power.larc.nasa.gov/api/climatology/point`
- Docs: `https://power.larc.nasa.gov/docs/`

**Rate limits:** 30 requests per IP per day for point queries; higher for the POWER Data Access Viewer. Contact `power-help@earthscience.msfc.nasa.gov` for higher throughput.

**Blockchain status:** ✅ US federal public domain.

**TX throughput potential:** Moderate (rate limited). Best for historical data ingestion or supplementing live sensor streams with model-derived variables.

---

### 12. USGS Volcano Hazards Program API
**What it is:** Real-time alert levels, volcanic ash advisories, and monitoring data for 170+ US volcanoes. Separate from the earthquake FDSN API — covers eruption activity, deformation, gas emissions, and volcanic tremor.

**Endpoints:**
- Current alert levels: `https://volcanoes.usgs.gov/vhp/api/v1/activity`
- All volcanoes: `https://volcanoes.usgs.gov/vhp/api/v1/volcanoes`
- Activity feed (GeoJSON): `https://volcanoes.usgs.gov/vhp/api/v1/activity?format=geojson`

**Rate limits:** No key required. No published rate limit.

**Blockchain status:** ✅ US federal public domain.

**TX throughput potential:** 170+ volcanoes. Alert level changes are relatively infrequent but monitoring data (deformation, gas) is high-frequency at active sites.

---

### 13. NOAA Real-Time Solar Wind (DSCOVR / ACE)
**What it is:** Separate from NOAA SWPC's general space weather products — this is the raw 1-minute and 5-minute solar wind data feed from the DSCOVR satellite at the L1 Lagrange point: magnetic field vectors, plasma speed, density, and temperature.

**Endpoints:**
- 7-day DSCOVR data: `https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1-m.json`
- Solar wind plasma: `https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1-m.json`
- ACE backup: `https://services.swpc.noaa.gov/json/ace/ace_mag_1h.json`
- All products index: `https://services.swpc.noaa.gov/`

**Rate limits:** No key required. No published rate limit.

**Blockchain status:** ✅ US federal public domain.

**TX throughput potential:** 1-minute cadence. Limited variables (Bx, By, Bz, speed, density, temperature) but extremely high scientific value as a true real-time planetary sensor.

---

### 14. IGRA v2 — Integrated Global Radiosonde Archive
**What it is:** NOAA's archive of upper-atmosphere soundings (temperature, humidity, wind speed/direction at altitude) from ~2,700 radiosonde stations globally. Twice-daily launches (00Z and 12Z) from most stations.

**Endpoints:**
- Station data: `https://www.ncei.noaa.gov/access/services/data/v1?dataset=igra2`
- Station list: `https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/doc/igra2-station-list.txt`
- FTP bulk: `ftp://ftp.ncdc.noaa.gov/pub/data/igra/`

**Rate limits:** No key required. No published rate limit for individual station queries.

**Blockchain status:** ✅ US federal public domain.

**TX throughput potential:** ~2,700 stations × 2 launches/day. Valuable for vertical atmospheric profiles not captured by surface sensors — adds a unique data dimension.

---

## Strategic Stacking Recommendation

For maximum TX throughput using all safe, publicly accessible sources:

**Tier 1 — Very High Volume (bulk endpoints):**
- Sensor.Community `data.json` — 35,000+ sensors per 5-minute pull
- NOAA NDBC `latest_obs.txt` — single-request snapshot of ~1,000 buoys
- EMSC WebSocket — push-based, no polling overhead

**Tier 2 — High Volume (per-station polling):**
- IRIS/EarthScope FDSN — 10,000+ seismograph stations
- NOAA CO-OPS — ~3,000 coastal stations, multiple products per station
- GeoNet NZ Tilde — 700+ diverse sensors (seismic, volcanic, GNSS, coastal)

**Tier 3 — Specialist / High-Value Streams:**
- USGS Geomagnetism + INTERMAGNET — 14 + 130 observatories, 1-min cadence
- DSCOVR/ACE Solar Wind — 1-min planetary sensor, unique data type
- openSenseMap — 10,000+ citizen IoT sensors
- USGS Volcanoes — 170+ alert-level and monitoring feeds
- IGRA v2 Radiosondes — 2,700 upper-atmosphere stations

**Estimated total addressable TX volume (combined tiers, 15-min polling):**
~65,000–70,000 unique data points per cycle before reaching any rate limit — all public domain or ODbL, zero commercial restrictions.

---

*Last researched: March 2026. All endpoints and ToS should be verified before production use.*
