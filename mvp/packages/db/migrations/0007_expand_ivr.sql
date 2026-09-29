-- Ф6: сценарии IVR (flow-engine) с версиями и привязкой к номерам, аудиобиблиотека, глобальные объявления,
-- интеграционные операции и их журнал, CSAT, голосовое сообщение / заказ перезвона. Только expand-изменения.
SET lock_timeout = '5s';

-- ---------- Сценарии (M-IVR-01/06/07): общий формат для IVR (voice) и ботов (text, Ф7) ----------
CREATE TABLE IF NOT EXISTS flow (
  id                   uuid PRIMARY KEY,
  name                 text        NOT NULL,
  kind                 text        NOT NULL CHECK (kind IN ('voice', 'text')),
  description          text,
  -- Номера (DID), звонки на которые обслуживает опубликованная версия (голосовой сценарий).
  dids                 text[]      NOT NULL DEFAULT '{}',
  -- Черновик — редактируется в конструкторе; идущие вызовы его не видят.
  draft                jsonb       NOT NULL,
  draft_updated_at     timestamptz NOT NULL DEFAULT now(),
  draft_updated_by     uuid REFERENCES app_user (id),
  published_version_id uuid,
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Опубликованные версии неизменяемы: вызов запоминает версию при входе и доигрывает её (M-IVR-06).
CREATE TABLE IF NOT EXISTS flow_version (
  id         uuid PRIMARY KEY,
  flow_id    uuid        NOT NULL REFERENCES flow (id),
  version    integer     NOT NULL,
  graph      jsonb       NOT NULL,
  comment    text,
  created_by uuid REFERENCES app_user (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);
ALTER TABLE flow ADD CONSTRAINT flow_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES flow_version (id) NOT VALID;
CREATE INDEX IF NOT EXISTS flow_dids_gin ON flow USING gin (dids);

-- ---------- Аудиобиблиотека (M-IVR-04): фразы и фрагменты чисел ----------
-- Файлы — WAV PCM 16 бит, моно, 8 кГц (приводятся в браузере при загрузке), хранятся в S3-хранилище;
-- Asterisk получает их по HTTP от call-control (res_http_media_cache).
CREATE TABLE IF NOT EXISTS audio_file (
  id           uuid PRIMARY KEY,
  name         text        NOT NULL,
  kind         text        NOT NULL DEFAULT 'prompt' CHECK (kind IN ('prompt', 'fragment')),
  -- Для фрагментов чисел: ключ ('0'…'19', '20', '100', '1f', 'thousand_few', …), см. flow-engine/numbers.
  fragment_key text,
  storage_key  text        NOT NULL,
  size_bytes   integer     NOT NULL,
  duration_ms  integer     NOT NULL,
  created_by   uuid REFERENCES app_user (id),
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS audio_file_fragment_uq ON audio_file (fragment_key)
  WHERE kind = 'fragment' AND is_active;

-- ---------- Глобальные объявления о сбоях с периодом действия (M-IVR-04) ----------
-- Включаются и выключаются менеджером (is_active) без правки сценария; звучат в узле «Объявления о сбоях».
CREATE TABLE IF NOT EXISTS announcement (
  id         uuid PRIMARY KEY,
  name       text        NOT NULL,
  audio_id   uuid        NOT NULL REFERENCES audio_file (id),
  starts_at  timestamptz,
  ends_at    timestamptz,
  -- Пусто — во всех сценариях.
  flow_ids   uuid[]      NOT NULL DEFAULT '{}',
  sort_order integer     NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Интеграционные операции (M-INT-03) и их журнал ----------
CREATE TABLE IF NOT EXISTS integration_op (
  id           uuid PRIMARY KEY,
  code         text        NOT NULL UNIQUE,
  name         text        NOT NULL,
  method       text        NOT NULL DEFAULT 'GET' CHECK (method IN ('GET', 'POST', 'PUT')),
  url          text        NOT NULL,
  headers      jsonb       NOT NULL DEFAULT '{}',
  -- {type: none|bearer|basic|header, username?, header?, secret?} — секрет зашифрован (SECRETS_KEY).
  auth         jsonb       NOT NULL DEFAULT '{"type":"none"}',
  body         text,
  inputs       jsonb       NOT NULL DEFAULT '[]',
  outputs      jsonb       NOT NULL DEFAULT '[]',
  timeout_ms   integer     NOT NULL DEFAULT 3000 CHECK (timeout_ms BETWEEN 100 AND 30000),
  fallback     jsonb       NOT NULL DEFAULT '{}',
  -- Панель внешних данных клиента в карточке (M-CARD-07): входной параметр, в который подставляется телефон.
  show_in_card boolean     NOT NULL DEFAULT false,
  card_input   text,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Журнал выполнения: без тела запроса и ответа (ПДн), только исход.
CREATE TABLE IF NOT EXISTS integration_log (
  id              uuid PRIMARY KEY,
  operation_id    uuid        NOT NULL REFERENCES integration_op (id),
  at              timestamptz NOT NULL DEFAULT now(),
  source          text        NOT NULL CHECK (source IN ('ivr', 'bot', 'card', 'test')),
  conversation_id uuid REFERENCES conversation (id),
  call_id         uuid REFERENCES call (id),
  user_id         uuid REFERENCES app_user (id),
  ok              boolean     NOT NULL,
  http_status     integer,
  duration_ms     integer     NOT NULL,
  error           text
);
CREATE INDEX IF NOT EXISTS integration_log_op_idx ON integration_log (operation_id, at DESC);

-- ---------- Вызов в IVR ----------
-- Новое состояние вызова 'ivr' — клиент в сценарии (до очереди, после разговора — CSAT, голосовое сообщение).
-- Расширение набора допустимых значений совместимо с предыдущей версией (она его не порождает).
ALTER TABLE call DROP CONSTRAINT IF EXISTS call_state_check;
ALTER TABLE call ADD CONSTRAINT call_state_check
  CHECK (state IN ('ivr', 'queued', 'dialing', 'talking', 'external', 'ended')) NOT VALID;
-- Версия сценария вызова и состояние шага (узел, переменные, подшаг) — сохраняются после каждого шага,
-- новый активный call-control продолжает с сохранённого шага (02-архитектура 6.3).
ALTER TABLE call ADD COLUMN IF NOT EXISTS flow_version_id uuid REFERENCES flow_version (id);
ALTER TABLE call ADD COLUMN IF NOT EXISTS ivr_state jsonb;
-- Дедлайн текущего шага (таймаут ввода, периодическое сообщение, максимальное ожидание) — данные, а не таймер
-- в памяти процесса: его проверяет тик активного call-control.
ALTER TABLE call ADD COLUMN IF NOT EXISTS ivr_wake_at timestamptz;
CREATE INDEX IF NOT EXISTS call_ivr_wake_idx ON call (node, ivr_wake_at) WHERE ivr_wake_at IS NOT NULL;

-- Запись разговора или голосовое сообщение клиента (M-TEL-08).
ALTER TABLE call_recording ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'call'
  CHECK (kind IN ('call', 'voicemail'));

-- Обращение-задача «перезвонить» из IVR (M-TEL-08): не закрывается как пропущенный звонок.
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS callback_requested boolean NOT NULL DEFAULT false;

-- ---------- Оценка обслуживания (M-TEL-09; чаты — Ф7) ----------
CREATE TABLE IF NOT EXISTS csat_rating (
  id              uuid PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES conversation (id),
  call_id         uuid REFERENCES call (id),
  channel_kind    text        NOT NULL,
  -- Оператор, который вёл разговор (для отчётов Ф10).
  agent_user_id   uuid REFERENCES app_user (id),
  score           smallint    NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS csat_rating_call_uq ON csat_rating (call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS csat_rating_conversation_idx ON csat_rating (conversation_id);
