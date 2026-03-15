BEGIN;

CREATE TABLE IF NOT EXISTS overlay_admitted_utxos (
  topic text NOT NULL,
  txid text NOT NULL,
  vout integer NOT NULL,
  satoshis bigint NOT NULL CHECK (satoshis >= 0),
  output_script text NOT NULL,
  raw_tx text NOT NULL,
  beef jsonb,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  confirmed boolean NOT NULL DEFAULT false,
  removed boolean NOT NULL DEFAULT false,
  removed_at timestamptz,
  spending_txid text,
  PRIMARY KEY (topic, txid, vout)
);

CREATE INDEX IF NOT EXISTS overlay_admitted_utxos_topic_removed_idx
  ON overlay_admitted_utxos(topic, removed);

CREATE INDEX IF NOT EXISTS overlay_admitted_utxos_topic_removed_satoshis_idx
  ON overlay_admitted_utxos(topic, removed, satoshis);

CREATE INDEX IF NOT EXISTS overlay_admitted_utxos_topic_removed_admitted_idx
  ON overlay_admitted_utxos(topic, removed, admitted_at);

CREATE INDEX IF NOT EXISTS overlay_admitted_utxos_topic_removed_confirmed_idx
  ON overlay_admitted_utxos(topic, removed, confirmed);

CREATE INDEX IF NOT EXISTS overlay_admitted_utxos_outpoint_idx
  ON overlay_admitted_utxos(txid, vout);

CREATE TABLE IF NOT EXISTS overlay_topic_counts (
  topic text PRIMARY KEY,
  available_count bigint NOT NULL DEFAULT 0,
  confirmed_available_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS overlay_submissions (
  txid text NOT NULL,
  topic text NOT NULL,
  client_request_id text NOT NULL,
  raw_tx text NOT NULL,
  beef jsonb,
  prevouts jsonb,
  mapi_responses jsonb,
  steak jsonb NOT NULL DEFAULT '{}'::jsonb,
  ack_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  all_hosts_acknowledged boolean NOT NULL DEFAULT false,
  accepted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (txid, topic)
);

CREATE INDEX IF NOT EXISTS overlay_submissions_client_request_idx
  ON overlay_submissions(client_request_id);

CREATE OR REPLACE FUNCTION refresh_overlay_topic_counts(target_topic text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO overlay_topic_counts (
    topic,
    available_count,
    confirmed_available_count,
    updated_at
  )
  SELECT
    target_topic,
    COUNT(*) FILTER (WHERE removed = false),
    COUNT(*) FILTER (WHERE removed = false AND confirmed = true),
    now()
  FROM overlay_admitted_utxos
  WHERE topic = target_topic
  ON CONFLICT (topic) DO UPDATE
  SET
    available_count = EXCLUDED.available_count,
    confirmed_available_count = EXCLUDED.confirmed_available_count,
    updated_at = EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION overlay_topic_counts_apply()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_overlay_topic_counts(OLD.topic);
    RETURN OLD;
  END IF;

  PERFORM refresh_overlay_topic_counts(NEW.topic);

  IF TG_OP = 'UPDATE' AND NEW.topic <> OLD.topic THEN
    PERFORM refresh_overlay_topic_counts(OLD.topic);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_overlay_topic_counts_apply ON overlay_admitted_utxos;

CREATE TRIGGER trg_overlay_topic_counts_apply
AFTER INSERT OR UPDATE OR DELETE ON overlay_admitted_utxos
FOR EACH ROW
EXECUTE FUNCTION overlay_topic_counts_apply();

COMMIT;
