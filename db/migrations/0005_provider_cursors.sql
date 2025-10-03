-- Cursors to resume iteration across runs (provider + optional country + resource)
CREATE TABLE IF NOT EXISTS provider_cursors (
  provider   TEXT NOT NULL,
  country    TEXT,
  resource   TEXT NOT NULL,
  cursor     BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, country, resource)
);







