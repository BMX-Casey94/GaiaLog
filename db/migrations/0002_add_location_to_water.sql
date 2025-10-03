-- Adds a human-readable location for water level readings
ALTER TABLE IF EXISTS water_level_readings
  ADD COLUMN IF NOT EXISTS location TEXT;

-- Optional index to speed up location searches
CREATE INDEX IF NOT EXISTS idx_water_location ON water_level_readings (location);



