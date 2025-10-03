-- GaiaLog per-stream schema (initial)
-- Safe to run multiple times with IF NOT EXISTS guards

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Stations / metadata
CREATE TABLE IF NOT EXISTS stations (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  station_code  TEXT NOT NULL,
  name          TEXT,
  city          TEXT,
  country       TEXT,
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  metadata      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, station_code)
);

-- Transaction log for on-chain writes
CREATE TABLE IF NOT EXISTS tx_log (
  txid          TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  collected_at  TIMESTAMPTZ NOT NULL,
  onchain_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|failed
  fee_sats      BIGINT,
  wallet_index  INT,
  retries       INT NOT NULL DEFAULT 0,
  error         TEXT
);

-- Air Quality readings
CREATE TABLE IF NOT EXISTS air_quality_readings (
  id              BIGSERIAL PRIMARY KEY,
  provider        TEXT NOT NULL,
  station_code    TEXT,
  city            TEXT,
  lat             DOUBLE PRECISION,
  lon             DOUBLE PRECISION,
  aqi             INT,
  pm25            DOUBLE PRECISION,
  pm10            DOUBLE PRECISION,
  co              DOUBLE PRECISION,
  no2             DOUBLE PRECISION,
  o3              DOUBLE PRECISION,
  so2             DOUBLE PRECISION,
  temperature_c   DOUBLE PRECISION,
  humidity_pct    DOUBLE PRECISION,
  pressure_mb     DOUBLE PRECISION,
  wind_kph        DOUBLE PRECISION,
  wind_deg        DOUBLE PRECISION,
  source          TEXT,
  source_hash     TEXT NOT NULL UNIQUE,
  collected_at    TIMESTAMPTZ NOT NULL,
  txid            TEXT REFERENCES tx_log(txid) ON DELETE SET NULL,
  onchain_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aqi_collected_at ON air_quality_readings (collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_aqi_station ON air_quality_readings (provider, station_code);

-- Water Level readings
CREATE TABLE IF NOT EXISTS water_level_readings (
  id                    BIGSERIAL PRIMARY KEY,
  provider              TEXT NOT NULL,
  station_code          TEXT,
  lat                   DOUBLE PRECISION,
  lon                   DOUBLE PRECISION,
  level_m               DOUBLE PRECISION,
  tide_height_m         DOUBLE PRECISION,
  wave_height_m         DOUBLE PRECISION,
  salinity_psu          DOUBLE PRECISION,
  dissolved_oxygen_mg_l DOUBLE PRECISION,
  turbidity_ntu         DOUBLE PRECISION,
  current_speed_ms      DOUBLE PRECISION,
  current_direction_deg DOUBLE PRECISION,
  wind_kph              DOUBLE PRECISION,
  wind_deg              DOUBLE PRECISION,
  source                TEXT,
  source_hash           TEXT NOT NULL UNIQUE,
  collected_at          TIMESTAMPTZ NOT NULL,
  txid                  TEXT REFERENCES tx_log(txid) ON DELETE SET NULL,
  onchain_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_water_collected_at ON water_level_readings (collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_water_station ON water_level_readings (provider, station_code);

-- Seismic readings
CREATE TABLE IF NOT EXISTS seismic_readings (
  id              BIGSERIAL PRIMARY KEY,
  provider        TEXT NOT NULL,
  event_id        TEXT,
  location        TEXT,
  magnitude       DOUBLE PRECISION,
  depth_km        DOUBLE PRECISION,
  lat             DOUBLE PRECISION,
  lon             DOUBLE PRECISION,
  source_hash     TEXT NOT NULL UNIQUE,
  collected_at    TIMESTAMPTZ NOT NULL,
  txid            TEXT REFERENCES tx_log(txid) ON DELETE SET NULL,
  onchain_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seismic_collected_at ON seismic_readings (collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_seismic_mag ON seismic_readings (magnitude DESC);

-- Advanced environmental metrics
CREATE TABLE IF NOT EXISTS advanced_metrics_readings (
  id                       BIGSERIAL PRIMARY KEY,
  provider                 TEXT NOT NULL,
  city                     TEXT,
  lat                      DOUBLE PRECISION,
  lon                      DOUBLE PRECISION,
  uv_index                 DOUBLE PRECISION,
  soil_moisture_pct        DOUBLE PRECISION,
  wildfire_risk            INT,
  environmental_score      INT,
  temperature_c            DOUBLE PRECISION,
  humidity_pct             DOUBLE PRECISION,
  pressure_mb              DOUBLE PRECISION,
  wind_kph                 DOUBLE PRECISION,
  wind_deg                 DOUBLE PRECISION,
  source_hash              TEXT NOT NULL UNIQUE,
  collected_at             TIMESTAMPTZ NOT NULL,
  txid                     TEXT REFERENCES tx_log(txid) ON DELETE SET NULL,
  onchain_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adv_collected_at ON advanced_metrics_readings (collected_at DESC);

-- Alerts (optional linkage to reading rows)
CREATE TABLE IF NOT EXISTS alerts (
  id           BIGSERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  value_num    DOUBLE PRECISION,
  location     TEXT,
  provider     TEXT,
  reading_ref  JSONB,
  txid         TEXT REFERENCES tx_log(txid) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);


