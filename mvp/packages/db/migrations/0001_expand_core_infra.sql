-- Базовая инфраструктура: transactional outbox, журнал событий, фиче-флаги.
-- Правило: только expand-изменения (02-архитектура, 6.2 п.7).
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS outbox (
  id            uuid PRIMARY KEY,
  subject       text        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;

-- Неизменяемый журнал событий — основа отчётов (M-REP-01). Партиционирование — позже.
CREATE TABLE IF NOT EXISTS event (
  id           uuid PRIMARY KEY,
  type         text        NOT NULL,
  version      integer     NOT NULL,
  occurred_at  timestamptz NOT NULL,
  source       text        NOT NULL,
  trace_id     text,
  data         jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS event_type_time_idx ON event (type, occurred_at);

CREATE OR REPLACE FUNCTION event_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'журнал событий неизменяем (append-only)';
END;
$$;
CREATE OR REPLACE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON event
  FOR EACH ROW EXECUTE FUNCTION event_forbid_mutation();

CREATE TABLE IF NOT EXISTS feature_flag (
  key         text PRIMARY KEY,
  enabled     boolean     NOT NULL DEFAULT false,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
