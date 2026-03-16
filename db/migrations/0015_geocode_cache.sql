-- Persistent reverse-geocode cache.
-- Keyed by rounded lat/lon (2 decimal places ≈ 1.1 km grid).
-- Populated lazily by lib/reverse-geocoder.ts when a reading has
-- coordinates but no meaningful place name.

CREATE TABLE IF NOT EXISTS geocode_cache (
  rounded_lat   double precision NOT NULL,
  rounded_lon   double precision NOT NULL,
  display_name  text NOT NULL,
  city          text,
  region        text,
  country_code  text,
  country       text,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  expires_at    timestamptz NOT NULL DEFAULT NOW() + INTERVAL '90 days',
  PRIMARY KEY (rounded_lat, rounded_lon)
);

CREATE INDEX IF NOT EXISTS idx_geocode_cache_expires
  ON geocode_cache(expires_at);
