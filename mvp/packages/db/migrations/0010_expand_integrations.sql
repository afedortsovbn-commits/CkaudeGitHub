-- Ф9: публичный API (ключи с правами), исходящие webhooks (подписки, доставки с повторами и журналом),
-- Bot Gateway (внешний бот канала), внешний канал по API-ключу. Только expand-изменения.
SET lock_timeout = '5s';

-- ---------- Ключи публичного API (M-INT-01) ----------
-- Хранится только SHA-256 ключа; сам ключ показывается один раз при выпуске. prefix — начало ключа для
-- опознания в списке. permissions — права ключа (см. contracts/public-api.ts), scope_rules — область видимости
-- (правила как у сотрудника; NULL — все обращения). channel_id — канал, от имени которого ключ принимает
-- сообщения сторонней системы (внешний канал, M-CH-09).
CREATE TABLE IF NOT EXISTS api_key (
  id           uuid PRIMARY KEY,
  name         text        NOT NULL,
  prefix       text        NOT NULL,
  key_hash     text        NOT NULL UNIQUE,
  permissions  text[]      NOT NULL DEFAULT '{}',
  scope_rules  jsonb,
  channel_id   uuid REFERENCES channel (id),
  expires_at   timestamptz,
  last_used_at timestamptz,
  created_by   uuid REFERENCES app_user (id),
  is_active    boolean     NOT NULL DEFAULT true,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- Подписки webhooks (M-INT-02) и внешние боты (Bot Gateway, M-AI-02) ----------
-- kind = events — события по списку типов (пусто — все), фильтр по каналам (пусто — все);
-- kind = bot — внешний бот: получает conversation.bot_turn по обращениям каналов, где он назначен
-- (channel.bot_webhook_id); не ответил за bot_timeout_s — диалог уходит оператору.
-- secret — ключ подписи HMAC-SHA256, зашифрован SECRETS_KEY. Состояние получателя: при сбое следующая попытка —
-- одной «пробной» доставкой в next_probe_at; успешная пробная доставка возвращает в работу всю очередь.
CREATE TABLE IF NOT EXISTS webhook_subscription (
  id                   uuid PRIMARY KEY,
  kind                 text        NOT NULL DEFAULT 'events' CHECK (kind IN ('events', 'bot')),
  name                 text        NOT NULL,
  url                  text        NOT NULL,
  secret               text        NOT NULL,
  event_types          text[]      NOT NULL DEFAULT '{}',
  channel_ids          uuid[]      NOT NULL DEFAULT '{}',
  headers              jsonb       NOT NULL DEFAULT '{}',
  timeout_ms           integer     NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 500 AND 30000),
  bot_timeout_s        integer     NOT NULL DEFAULT 30 CHECK (bot_timeout_s BETWEEN 5 AND 3600),
  failures             integer     NOT NULL DEFAULT 0,
  next_probe_at        timestamptz,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  last_error           text,
  created_by           uuid REFERENCES app_user (id),
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Доставка: одна строка на (подписка, событие) — повторная обработка события не создаёт дубля.
-- pending → sent | failed (исчерпан срок жизни доставки); test — ручная проверка из админки.
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id              uuid PRIMARY KEY,
  subscription_id uuid        NOT NULL REFERENCES webhook_subscription (id),
  event_id        uuid        NOT NULL,
  event_type      text        NOT NULL,
  conversation_id uuid,
  payload         jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  is_test         boolean     NOT NULL DEFAULT false,
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_status     integer,
  last_error      text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_delivery_pending_idx ON webhook_delivery (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_delivery_sub_idx ON webhook_delivery (subscription_id, created_at DESC);

-- ---------- Внешний бот канала (Bot Gateway): альтернатива сценарному боту (bot_flow_id имеет приоритет) ----------
ALTER TABLE channel ADD COLUMN IF NOT EXISTS bot_webhook_id uuid REFERENCES webhook_subscription (id);
