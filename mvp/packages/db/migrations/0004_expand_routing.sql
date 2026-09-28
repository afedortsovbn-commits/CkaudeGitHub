-- Ф3: маршрутизация (ACD), статусы операторов, предложения (offer), правила маршрутизации текста,
-- приоритет по сегменту клиента. Только expand-изменения.
SET lock_timeout = '5s';

-- ---------- Очередь: стратегия, перелив, таймауты (M-RT-03/04/05/06) ----------
ALTER TABLE queue ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'least_recent'
  CHECK (strategy IN ('least_recent', 'least_load'));
ALTER TABLE queue ADD COLUMN IF NOT EXISTS overflow_queue_id uuid REFERENCES queue (id);
ALTER TABLE queue ADD COLUMN IF NOT EXISTS overflow_after_s integer CHECK (overflow_after_s IS NULL OR overflow_after_s > 0);
ALTER TABLE queue ADD COLUMN IF NOT EXISTS offer_timeout_s integer NOT NULL DEFAULT 20 CHECK (offer_timeout_s > 0);
ALTER TABLE queue ADD COLUMN IF NOT EXISTS wrap_up_s integer NOT NULL DEFAULT 15 CHECK (wrap_up_s >= 0);

-- ---------- Обращение: эффективный приоритет и момент постановки в очередь (для ACD) ----------
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS queued_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS offered_at timestamptz;
-- Признак «уже эскалировано по времени ожидания» — чтобы надбавка приоритета не начислялась повторно
-- на каждом тике router (M-RT-04). Сбрасывается при новой постановке в очередь (transfer).
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS escalated boolean NOT NULL DEFAULT false;
-- «Отложено / перезвонить» (M-CARD-05): дата и время, когда закрытое обращение снова встаёт в очередь.
-- Задача pg-boss, отложенная в Ф2 до появления таймеров — router проверяет наступление срока (sweepCallbacks).
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS callback_at timestamptz;
CREATE INDEX IF NOT EXISTS conversation_callback_idx ON conversation (callback_at) WHERE callback_at IS NOT NULL;
UPDATE conversation SET queued_at = created_at WHERE queued_at IS DISTINCT FROM created_at AND status = 'queued';
CREATE INDEX IF NOT EXISTS conversation_queued_idx ON conversation (queue_id, priority DESC, queued_at)
  WHERE status = 'queued';

-- ---------- Статус оператора (M-OP-04) ----------
CREATE TABLE IF NOT EXISTS agent_status (
  user_id          uuid PRIMARY KEY REFERENCES app_user (id),
  status           text        NOT NULL DEFAULT 'offline' CHECK (status IN ('ready', 'break', 'wrap_up', 'offline')),
  reason_id        uuid REFERENCES break_reason (id),
  last_assigned_at timestamptz,
  wrap_up_until    timestamptz,
  since            timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_status_log (
  id         uuid PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES app_user (id),
  status     text        NOT NULL,
  reason_id  uuid REFERENCES break_reason (id),
  started_at timestamptz NOT NULL,
  ended_at   timestamptz
);
CREATE INDEX IF NOT EXISTS agent_status_log_user_idx ON agent_status_log (user_id, started_at);

-- ---------- Предложения обращения оператору (offer): принятие/отказ/таймаут (M-RT-05) ----------
CREATE TABLE IF NOT EXISTS routing_offer (
  id              uuid PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES conversation (id),
  user_id         uuid        NOT NULL REFERENCES app_user (id),
  queue_id        uuid REFERENCES queue (id),
  offered_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  outcome         text CHECK (outcome IN ('accepted', 'declined', 'timeout', 'superseded')),
  decided_at      timestamptz
);
CREATE INDEX IF NOT EXISTS routing_offer_conversation_idx ON routing_offer (conversation_id);
CREATE INDEX IF NOT EXISTS routing_offer_pending_idx ON routing_offer (conversation_id, user_id) WHERE outcome IS NULL;

-- ---------- Правила маршрутизации текста: канал/ключевые слова/regex → очередь (M-RT-07, [УПР]) ----------
CREATE TABLE IF NOT EXISTS routing_rule (
  id             uuid PRIMARY KEY,
  name           text        NOT NULL,
  channel_kind   text CHECK (channel_kind IS NULL OR channel_kind IN ('webchat', 'app', 'telegram', 'email', 'review', 'api', 'voice')),
  match_type     text        NOT NULL CHECK (match_type IN ('keyword', 'regex')),
  pattern        text        NOT NULL,
  queue_id       uuid        NOT NULL REFERENCES queue (id),
  priority_boost integer     NOT NULL DEFAULT 0,
  is_urgent      boolean     NOT NULL DEFAULT false,
  sort_order     integer     NOT NULL DEFAULT 0,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS routing_rule_active_idx ON routing_rule (sort_order) WHERE is_active;

-- ---------- Приоритет по сегменту клиента внутри очереди (M-RT-08, [УПР]) ----------
CREATE TABLE IF NOT EXISTS segment_priority (
  id         uuid PRIMARY KEY,
  segment    text        NOT NULL UNIQUE,
  boost      integer     NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_setting (key, value) VALUES
  ('routing.escalation_boost', '1000')
ON CONFLICT (key) DO NOTHING;
