-- Ф2: клиенты, каналы, обращения, сообщения, вложения, согласия на обработку ПДн.
SET lock_timeout = '5s';

-- ---------- Клиенты и их идентификаторы в каналах (M-CARD-01) ----------
CREATE TABLE IF NOT EXISTS contact (
  id             uuid PRIMARY KEY,
  display_name   text,
  phone          text,
  email          text,
  segment        text,
  note           text,
  merged_into_id uuid REFERENCES contact (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_identity (
  id         uuid PRIMARY KEY,
  contact_id uuid        NOT NULL REFERENCES contact (id),
  kind       text        NOT NULL CHECK (kind IN ('phone', 'email', 'telegram', 'webchat', 'app', 'other')),
  value      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS contact_identity_contact_idx ON contact_identity (contact_id);

-- ---------- Каналы (экземпляры): веб-чат, чат в приложении; далее Telegram, email (Ф4) ----------
CREATE TABLE IF NOT EXISTS channel (
  id         uuid PRIMARY KEY,
  kind       text        NOT NULL CHECK (kind IN ('webchat', 'app', 'telegram', 'email', 'review', 'api', 'voice')),
  name       text        NOT NULL,
  -- для webchat/app: public_key, allowed_origins[], consent_text, consent_version, max_file_mb, greeting
  config     jsonb       NOT NULL DEFAULT '{}',
  queue_id   uuid REFERENCES queue (id),
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_public_key_uq ON channel ((config ->> 'public_key')) WHERE config ? 'public_key';

-- ---------- Обращения (M-CH-01) ----------
CREATE TABLE IF NOT EXISTS conversation (
  id               uuid PRIMARY KEY,
  channel_id       uuid        NOT NULL REFERENCES channel (id),
  channel_kind     text        NOT NULL,
  contact_id       uuid        NOT NULL REFERENCES contact (id),
  status           text        NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('new', 'bot', 'queued', 'offered', 'active', 'hold', 'wrap_up', 'waiting_customer', 'waiting_2nd_line', 'closed')),
  queue_id         uuid REFERENCES queue (id),
  assignee_id      uuid REFERENCES app_user (id),
  topic_id         uuid REFERENCES topic (id),
  topic_path       uuid[]      NOT NULL DEFAULT '{}',
  enterprise_id    uuid REFERENCES enterprise (id),
  department_id    uuid REFERENCES department (id),
  object_id        uuid REFERENCES service_object (id),
  is_important     boolean     NOT NULL DEFAULT false,
  important_manual boolean     NOT NULL DEFAULT false,
  is_urgent        boolean     NOT NULL DEFAULT false,
  fields           jsonb       NOT NULL DEFAULT '{}',
  disposition_id   uuid REFERENCES disposition (id),
  seq              bigint      NOT NULL DEFAULT 0, -- номер последнего сообщения
  last_message_at  timestamptz,
  first_response_at timestamptz,
  assigned_at      timestamptz,
  closed_at        timestamptz,
  closed_by        uuid REFERENCES app_user (id),
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_open_idx ON conversation (status, queue_id, last_message_at) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS conversation_assignee_idx ON conversation (assignee_id) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS conversation_contact_idx ON conversation (contact_id, created_at);
CREATE INDEX IF NOT EXISTS conversation_topic_path_gin ON conversation USING gin (topic_path);

CREATE TABLE IF NOT EXISTS conversation_tag (
  conversation_id uuid NOT NULL REFERENCES conversation (id),
  tag_id          uuid NOT NULL REFERENCES tag (id),
  PRIMARY KEY (conversation_id, tag_id)
);

-- ---------- Сообщения ----------
-- external_id — идентификатор сообщения в канале (для веб-чата — clientMessageId): защита от дублей при
-- повторной доставке (02-архитектура 6.2 п.5). sent_at — время приёма системой, определяет порядок показа.
CREATE TABLE IF NOT EXISTS message (
  id              uuid PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES conversation (id),
  seq             bigint      NOT NULL,
  direction       text        NOT NULL CHECK (direction IN ('in', 'out', 'system', 'note')),
  author_user_id  uuid REFERENCES app_user (id),
  body            text        NOT NULL DEFAULT '',
  attachments     jsonb       NOT NULL DEFAULT '[]',
  channel_kind    text        NOT NULL,
  external_id     text,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS message_external_uq ON message (channel_kind, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_conversation_idx ON message (conversation_id, sent_at);

-- ---------- Вложения (файлы в S3-хранилище) ----------
CREATE TABLE IF NOT EXISTS attachment (
  id                 uuid PRIMARY KEY,
  conversation_id    uuid REFERENCES conversation (id),
  contact_id         uuid REFERENCES contact (id),
  uploaded_by_user   uuid REFERENCES app_user (id),
  filename           text        NOT NULL,
  content_type       text        NOT NULL,
  size_bytes         bigint      NOT NULL,
  storage_key        text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------- Согласия на обработку персональных данных (M-NFR-07) ----------
CREATE TABLE IF NOT EXISTS consent (
  id           uuid PRIMARY KEY,
  contact_id   uuid        NOT NULL REFERENCES contact (id),
  channel_id   uuid        NOT NULL REFERENCES channel (id),
  text_version text        NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS consent_contact_idx ON consent (contact_id);

INSERT INTO system_setting (key, value) VALUES ('operator.max_chats', '5') ON CONFLICT (key) DO NOTHING;
