BEGIN;

-- ─── Seed new data-family counts ─────────────────────────────────────────────
-- Pre-populate the family counts table so the explorer hero stats include
-- the new families from day one.  The trigger will increment from zero.

INSERT INTO overlay_explorer_family_counts (data_family, reading_count, updated_at)
VALUES
  ('biodiversity', 0, now()),
  ('conservation_status', 0, now()),
  ('hydrology', 0, now()),
  ('flood_risk', 0, now()),
  ('land_use_change', 0, now()),
  ('natural_events', 0, now()),
  ('mining_activity', 0, now()),
  ('transport_tracking', 0, now()),
  ('planning_development', 0, now())
ON CONFLICT (data_family) DO NOTHING;

-- ─── Provider-level index on overlay_explorer_readings ───────────────────────
-- Enables efficient filtering by provider_id across new and existing families.

CREATE INDEX IF NOT EXISTS oer_provider_ts_idx
  ON overlay_explorer_readings(provider_id, reading_ts DESC)
  WHERE provider_id IS NOT NULL;

-- ─── Composite family+provider index for drilldown queries ───────────────────

CREATE INDEX IF NOT EXISTS oer_family_provider_idx
  ON overlay_explorer_readings(data_family, provider_id, reading_ts DESC);

COMMIT;
