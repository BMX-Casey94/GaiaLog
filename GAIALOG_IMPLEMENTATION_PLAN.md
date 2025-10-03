# GaiaLog Implementation Plan

## 1) Provider Strategy and Coverage

- Objective: Maximize global coverage while respecting free-tier limits; combine permissive APIs for breadth with stricter APIs for quality anchoring.
- Providers by data type:
  - Air Quality: Primary breadth via WeatherAPI city queries; quality anchor via WAQI with strict daily cap. Optional redundancy: OpenWeatherMap AQ.
  - Water Levels / Tides: NOAA Tides & Currents (station list + per-station data).
  - Seismic: USGS FDSN (windowed queries return multiple events per call).
  - Environmental Metrics: WeatherAPI (UV). Optional: NASA with personal key (not DEMO) for soil moisture in future.
- Quotas & roles:
  - WAQI: ~1000 calls/month (~33/day). Use only for rotating sample of cities.
  - WeatherAPI: generous; use for breadth (multiple cities per run with throttling).
  - NOAA/USGS: unkeyed but respect courtesy limits (2-5 req/sec) and backoff.
- Additional Suggestion(s): Add OpenWeatherMap for redundancy where WeatherAPI errors or rate-limits.

### 1.a Geographic Coverage Expansion
- Add EU/Asia regional sources to reduce bias:
  - EEA/EEA Air Quality (Europe) where accessible.
  - Local government portals in Asia (e.g., Japan, India) if open.
- Cross-reference overlapping stations (WAQI vs WeatherAPI) to score quality.

## 2) Provider Registry (Budgets, Cadence, Areas)

- Deliverables:
  - `lib/provider-registry.ts` with entries: id, purpose, default cadence, per-day budget, per-sec throttle, paging strategy, lastProcessed cursor.
  - Central budget manager with counters (persist daily) and next-allowed timestamps.
- Example entries:
  - WAQI: cadence 6-8h per city sample, 33/day global budget, 1 req/sec throttle.
  - WeatherAPI: cadence 15-30m, 5 req/sec throttle, batches of 25-100 cities.
  - NOAA: cadence 60m per batch of 25 stations, 3 req/sec.
  - USGS: cadence 15m per windowed query, 1 req/sec.
- Additional Suggestion(s): Expose live budget status on `/api/providers/status` for observability.

## 3) Batch Collection with Throttling/Pagination

- Why: Higher data throughput with fewer handshakes; controlled request rates; easy quota enforcement; consistent batch writes to BSV queue.
- Tasks:
  - `lib/provider-fetch.ts`: fetch with retry/backoff (429/5xx), jitter, JSON parsing.
  - Extend `lib/data-collector.ts` with `collect*Batch()` for NOAA/USGS/WeatherAPI.
  - Courtesy delays inside loops and concurrency caps.
- Additional Suggestion(s): Use small promise pools (e.g., 3-5 concurrent) and per-provider delay to balance speed and courtesy.

## 4) Scheduling and Cadences (optimize by provider update frequency)

- Proposed intervals:
  - WAQI: every 1-2h per small rotating set; global cap ~33/day. Station updates often 10-60m; caching still applies.
  - WeatherAPI: every 15-30m (UV and current conditions update frequently).
  - NOAA: every 60m (tide/water levels typically 6-60m; batch and rotate stations).
  - USGS: every 15m (recent seismic events).
  - Environmental monitoring composite: 30m.
- Deduplication:
  - Persist last timestamp/id/hash per station/city/event; skip duplicates.
  - Use provider-native IDs when available (USGS `event.id`, NOAA `station.id + timestamp`, WAQI `city + time.iso`).
- Additional Suggestion(s): Maintain ETag/Last-Modified if provider supports to avoid unchanged payloads.

### 4.a Update Frequency Validation (Real-World)
- Collect `Last-Modified`, `ETag`, and timeseries timestamps; compute observed update intervals per provider/station.
- Adapt cadence per station dynamically: slow down when unchanged; speed up when active.
- Add a “change detector” score to decide when to poll sooner (e.g., flood/high AQI).

## 5) Idempotency, Caching, and Duplicate Prevention

- Server cache: short TTL (e.g., WAQI 30-60m; NOAA 15-30m; WeatherAPI 10-15m; USGS 10-15m).
- Idempotency key: `provider:type:stationOrCityId:timestamp` (hashed).
- On-chain dedupe: Before enqueueing to BSV, check if idempotency key exists in local index; write once.
- Additional Suggestion(s): Write a compact on-chain schema with a manifest per batch to reduce fee overhead.

### 5.a Adaptive Caching
- If a provider shows frequent updates (e.g., every 5m), lower TTL.
- If provider/station is stable, raise TTL to reduce no-op fetches.
- Honor 304 Not Modified where supported.

## 6) Blockchain Writing and Identity

- Objective: High-throughput queue writes with clear provenance.
- Tasks:
  - Include `app="GaiaLog"` and `provider`, `version`, and `schema` tags in OP_RETURN envelope.
  - Continue round-robin across 3 wallets; log per-wallet stats.
  - Batch transactions (multiple readings per tx) where appropriate to reduce fees.
- Additional Suggestion(s): Define a public content schema and publish a README for third-party parsers.

### 6.a Granularity vs. Batching (BSV)
- With low fees, prefer per-reading writes where it improves simplicity and provenance; batch when reducing fee/overhead is beneficial.
- Include richer metadata (sensor details, collection time, confidence) given fee headroom.

## 7) Database for On-Chain Index and UX

- Schema (Postgres preferred):
  - `records(id, provider, type, station_id, city, ts, txid, source_hash, inserted_at)`
  - `batches(id, provider, type, window_start, window_end, txid, count)`
  - `provider_cursors(provider, cursor, updated_at)`
  - `dedupe_keys(key primary, first_seen_at, txid)`
- Uses:
  - Drive dashboard from DB plus on-chain references (TXID).
  - Power search/explore pages; validate dedupe.
- Additional Suggestion(s): Add materialized views for latest per station and per city.

### 7.a Retention and Partitioning
- Time-partition `records` by month; index on `(provider, station_id, ts)`.
- Retention tiers: hot (90 days fast storage), warm (12 months), cold/archive (beyond 12 months) with cheaper storage; always keep TXID pointers.
- Background compaction tasks for older partitions.

## 8) Observability and Compliance

- Metrics: per-provider calls, 2xx/4xx/5xx, 429s, retries, backoff time, batch sizes, queue depth, tx success/failure, sat/byte.
- Dashboards: provider budgets, next-run countdown, error logs.
- Alerts: budget exhaustion, repeated 429s/5xx, duplicate detection.
- Additional Suggestion(s): Persist X-RateLimit headers if available.

### 8.a Reliability Strategy (Free APIs)
- Health scoring per provider: latency, error rate, 429s, freshness.
- Circuit breakers: pause a failing provider and switch to redundancy (e.g., WeatherAPI -> OWM) until recovery.
- Endpoint change detection tests in CI; notify on schema/status shifts.

## 9) Multi-Account/Provider Strategy

- Approach:
  - Prefer multiple providers over multiple accounts of the same provider where terms are restrictive.
  - If using multiple accounts with the same provider, ensure TOS compliance and transparent disclosure.
- Additional Suggestion(s): Feature-flag account pools to scale up/down without code changes.

## 10) Execution Plan (Phased)

- Phase A (Foundation)
  - Build provider registry and fetch-with-retry utility.
  - Implement batch collectors and cursors for NOAA/USGS/WeatherAPI.
  - Add server cache and idempotency/dedupe layer.
  - Wire workers to batch collectors; set safe cadences.
  - Add OWM redundancy earlier for reliability.
  - Add provider health scoring and circuit breakers.
- Phase B (Scale and Data Model)
  - Introduce Postgres schema and write on-chain index plus TXID references.
  - Add identity tagging (`app: GaiaLog`) in OP_RETURN envelopes.
  - Observability dashboards and alerts.
  - Implement time partitioning and retention policies.
- Phase C (Coverage Expansion)
  - Add regional providers (EEA/Asia) for geographic balance.
  - Request non-profit allowances from WAQI/WeatherAPI.
  - Increase batch sizes and coverage pacing according to granted limits.

## 11) Current State Snapshot (after recent edits)

- Live routes: air-quality, water-levels, seismic, advanced-metrics.
- WeatherAPI: HTTPS; keys via env; no plaintext keys.
- Workers: simulate provider calls; need wiring to batch collectors.
- Deduplication/caching: not yet implemented; recommended next.

## 12) Next Steps (Actionable)

1. Implement `lib/provider-fetch.ts` and `lib/provider-registry.ts`.
2. Add batch methods to `lib/data-collector.ts` (NOAA/USGS/WeatherAPI) with throttling/pagination.
3. Add short-TTL server cache and idempotency key checks before enqueueing.
4. Update `lib/worker-threads.ts` to call batch collectors per registry cadence.
5. Introduce Postgres (or SQLite to start) with schemas above; add partitioning and retention jobs.
6. Add identity tags to OP_RETURN payloads (`app: GaiaLog`, `provider`, `schema_version`).
7. Expose `/api/providers/status` and `/api/metrics` for budget/queue observability.
8. Add OpenWeatherMap integration (redundancy moved to Phase A).
9. Draft outreach emails to WAQI/WeatherAPI for non-profit allowances.
10. Validate actual provider update frequencies; enable adaptive cadence per station.

## 13) Implementation Details

### 13.a Dynamic Polling Without ETag/Last-Modified
- Compute lightweight content hashes over salient fields (e.g., last reading timestamp/value, station id). Example: `hash = sha1(provider|stationId|ts|valueRounded)`.
- Maintain `lastHash` per station/city. If unchanged across N polls, progressively back off (e.g., 2x up to a max TTL).
- If changed, reset to minimum interval for that provider/station.

### 13.b Health Scoring and Circuit Breakers
- Metrics per provider (rolling 5-15 minute window):
  - successRate, medianLatencyMs, error429Rate, error5xxRate, freshnessLag (data timestamp vs now), budgetHeadroom (remaining/day).
- Health score = weighted composite. Defaults: successRate (40%), latency (20%), 429s (20%), 5xx (10%), freshness (10%).
- Breaker states: CLOSED -> HALF_OPEN -> OPEN.
  - Trip to OPEN when: (consecutiveFailures >= 5) OR (errorRate >= 40% and calls >= 20) OR (429s >= 3 in 1 minute).
  - Cooldown: 2 minutes; HALF_OPEN allows small test traffic (e.g., 1 req/30s). If healthy, return to CLOSED; else back to OPEN.
- Expose health state on `/api/providers/status`.

### 13.c USGS Significant-Event Triggers
- Subscribe to USGS real-time GeoJSON feeds or check `alert`/`mag` fields in windowed results.
- Trigger criteria (any): `mag >= 5.0`, `alert in {yellow, orange, red}`, or within radius of monitored major cities.
- On trigger: temporarily reduce polling interval (e.g., 1-5m) for 1 hour; then decay back to normal.

### 13.d Simple Cross-Validation Strategy
- Start simple with outlier detection:
  - For overlapping stations/cities, compute z-score vs rolling mean across providers; flag if |z| > 3.
  - Do not auto-correct; just annotate with `validation_flags` and store both values.
- Future: station mapping tables and calibration offsets when we have reliable correspondences.

### 13.e Failover Granularity
- Failover at the smallest scope possible:
  - If a single city fetch fails on WeatherAPI, retry with OWM for that city only.
  - If regional error spike (e.g., Europe endpoints), shift that region to OWM temporarily.
  - If provider-wide breaker OPENs, switch globally until HALF_OPEN recovers.
- Persist failover decisions with TTL so they auto-expire.

## 14) Troubleshooting Guide (Common Scenarios)

- Provider returns 200 but stale data:
  - Check `freshnessLag` metric and `Last-Modified`/`ETag` headers; enable adaptive backoff for that station.
  - Verify dedupe blocked writes; route provides latest cached value to UI.
- Mixed healthy/unhealthy regions:
  - Confirm health scoring by region; ensure regional failover engaged only where unhealthy.
  - Review breaker states and TTL expiry for reversion.
- Budget exhaustion during events:
  - Enforce priority: critical regions/cities first; pause low-signal stations.
  - Reduce intervals temporarily; enable alternate provider for breadth.
- Frequent 429s:
  - Verify per-sec throttle; increase backoff jitter; reduce concurrency.
- No data after deploy:
  - Check provider keys/ENV; inspect `/api/providers/status` and logs for breaker OPEN state.

## 15) Monitoring Dashboards (Operator View)

- Overview Panel:
  - Provider health (score, state), calls/min, error rates, 429s, latency, budget headroom.
  - Queue depth, tx/sec, success/failure, fee rate.
- Regional Panel:
  - Health by region; failover status; recent incidents and cooldown timers.
- Data Freshness:
  - Heatmap of freshnessLag per station/city; top stale items; adaptive TTLs.
- Events Panel (USGS):
  - Recent events, trigger activations, current polling interval.

## 16) Provider Onboarding Checklist

- Required fields:
  - Data types provided, endpoints, auth scheme, quotas, region scope, update cadence.
  - Primary ID fields (station id, event id), timestamps, units.
- Implementation steps:
  - Add entry in `provider-registry.ts` with budgets and cadence.
  - Implement fetcher with retry/backoff; map to internal schema.
  - Add validation/outlier rules; update dedupe key definition.
  - Add tests and a small canned dataset for CI.
  - Update dashboards to include provider metrics.
- Go-live:
  - Dry run in staging with capped budgets; verify health score and breaker transitions.
  - Monitor first 24h; adjust cadences/thresholds.

## 17) Implementation Order (Do First Things First)

1. Define storage interfaces (no DB dependency yet)
   - Interfaces: CacheStore, DedupeStore, CursorStore, BudgetStore
   - Provide in-memory adapter to start; DB adapter later
2. Provider fetch utility
   - `lib/provider-fetch.ts` with retry, backoff, jitter, JSON parsing, metrics hooks
3. Provider registry
   - `lib/provider-registry.ts` defining providers, cadences, budgets, throttles, and cursors
4. Health scoring and circuit breakers
   - Integrate into registry layer; expose health states via hooks
5. Batch collectors
   - Extend `lib/data-collector.ts` with `collect*Batch()` for NOAA/USGS/WeatherAPI using registry + fetch util
6. Adaptive polling primitives
   - Content hashing per station/city; last-hash tracking; TTL backoff logic
7. Wire workers to registry and batch collectors
   - Replace simulated workers; respect cadences and budgets; enqueue to BSV queue
8. Observability (minimum viable)
   - `/api/providers/status`, `/api/metrics` (budgets, error rates, health, freshness)
9. DB schema and adapter
   - Add Postgres schema and a DB adapter implementing the storage interfaces; migrate from in-memory
10. OP_RETURN identity tagging
   - Add `app: GaiaLog`, `provider`, `schema_version` tags to writes; verify on-chain
11. Redundancy provider (OWM)
   - Add OWM integration and failover paths; feature-flag rollout
12. Geographic expansion
   - Add EU/Asia sources; validate and monitor initial health/quality
13. Provider outreach and cadence tuning
   - Contact WAQI/WeatherAPI; adjust budgets and cadences by granted limits

## 18) Manual Prerequisites and Inputs

- ❌ PROVIDE ENV KEYS: `WEATHERAPI_KEY`, `WAQI_API_KEY`, (optional) `OWM_API_KEY`, (optional) `NASA_API_KEY`
- ❌ CONFIRM BSV ARC KEY/NETWORK FOR LAUNCH: `BSV_ARC_API_KEY`, `BSV_NETWORK` (testnet/mainnet)
- ❌ CHOOSE INITIAL CITY/STATION SEEDS: list of priority cities/regions to emphasize early
- ❌ DECIDE RETENTION POLICY: hot/warm/cold durations (e.g., 90d/12m/archive)
- ❌ APPROVE PROVIDER LIST FOR PHASE A: WeatherAPI, WAQI, NOAA, USGS, OWM (yes/no)
- ❌ APPROVE OP_RETURN TAG FORMAT: `app`, `provider`, `schema_version`, and optional metadata keys
- ❌ APPROVE HEALTH/BREAKER DEFAULTS: consecutiveFailures=5, errorRate>=40% over 20 calls, 429 burst >=3/min, cooldown=2m
