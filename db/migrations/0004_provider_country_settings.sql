-- Per-provider country settings (allow/deny lists and quotas)
CREATE TABLE IF NOT EXISTS provider_country_settings (
  provider   TEXT PRIMARY KEY,
  allow      TEXT[] DEFAULT NULL,
  deny       TEXT[] DEFAULT NULL,
  quotas     JSONB  DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);










