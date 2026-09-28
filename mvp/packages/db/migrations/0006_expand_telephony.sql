-- Ф5: телефония — вызовы голосового канала, журнал вызовов (CDR, M-TEL-05), записи разговоров (M-TEL-04).
-- Только expand-изменения.
SET lock_timeout = '5s';

-- Вызов: разговор клиента с КЦ через один узел Asterisk. Обращение голосового канала может иметь несколько
-- вызовов (например, исходящий перезвон из карточки). Идентификаторы каналов и моста ARI нужны call-control
-- для сверки после переключения активного экземпляра (02-архитектура 6.3).
CREATE TABLE IF NOT EXISTS call (
  id              uuid PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES conversation (id),
  direction       text        NOT NULL CHECK (direction IN ('in', 'out')),
  node            text        NOT NULL,
  -- queued — клиент ждёт оператора (музыка); dialing — звонит оператору; talking — разговор;
  -- external — переведён на внешний номер; ended — завершён.
  state           text        NOT NULL CHECK (state IN ('queued', 'dialing', 'talking', 'external', 'ended')),
  from_number     text,
  to_number       text,
  did             text,
  client_channel  text        NOT NULL,
  agent_channel   text,
  agent_user_id   uuid REFERENCES app_user (id),
  bridge_id       text,
  on_hold         boolean     NOT NULL DEFAULT false,
  started_at      timestamptz NOT NULL DEFAULT now(),
  connected_at    timestamptz,
  ended_at        timestamptz,
  end_reason      text,
  version         integer     NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_live_idx ON call (node, state) WHERE state <> 'ended';
CREATE INDEX IF NOT EXISTS call_agent_live_idx ON call (agent_user_id) WHERE state IN ('dialing', 'talking');
CREATE INDEX IF NOT EXISTS call_conversation_idx ON call (conversation_id);

-- Стадии вызова для журнала (CDR): ожидание, предложение оператору, ответ, удержание, переводы, прослушивание.
CREATE TABLE IF NOT EXISTS call_event (
  id      uuid PRIMARY KEY,
  call_id uuid        NOT NULL REFERENCES call (id),
  at      timestamptz NOT NULL DEFAULT now(),
  type    text        NOT NULL,
  user_id uuid REFERENCES app_user (id),
  data    jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS call_event_call_idx ON call_event (call_id, at);

-- Запись разговора: пишется на диск узла Asterisk, затем call-control выгружает её в S3-хранилище с повторами
-- (02-архитектура 8.1) и удаляет с узла.
CREATE TABLE IF NOT EXISTS call_recording (
  id              uuid PRIMARY KEY,
  call_id         uuid        NOT NULL REFERENCES call (id),
  conversation_id uuid        NOT NULL REFERENCES conversation (id),
  node            text        NOT NULL,
  name            text        NOT NULL,
  status          text        NOT NULL DEFAULT 'recording'
                    CHECK (status IN ('recording', 'pending_upload', 'uploaded', 'failed')),
  storage_key     text,
  size_bytes      bigint,
  duration_s      integer,
  attempts        integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  uploaded_at     timestamptz,
  UNIQUE (node, name)
);
CREATE INDEX IF NOT EXISTS call_recording_conversation_idx ON call_recording (conversation_id);
CREATE INDEX IF NOT EXISTS call_recording_pending_idx ON call_recording (node, status) WHERE status = 'pending_upload';

-- Срок хранения записей разговоров по умолчанию (В-11).
INSERT INTO system_setting (key, value) VALUES ('recording.retention_days', '180') ON CONFLICT (key) DO NOTHING;
