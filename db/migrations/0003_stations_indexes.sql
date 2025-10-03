-- Indexes to support provider/country queries for stations
CREATE INDEX IF NOT EXISTS idx_stations_provider_country ON stations (provider, country);
CREATE INDEX IF NOT EXISTS idx_stations_provider_code ON stations (provider, station_code);
CREATE INDEX IF NOT EXISTS idx_stations_country ON stations (country);



