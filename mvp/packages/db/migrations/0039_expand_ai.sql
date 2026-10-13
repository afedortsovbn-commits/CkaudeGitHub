-- Д-030, Д-031 (13.10.2026): нейросеть — заполнение полей обращения с проверкой оператором и журнал исправлений
-- (для супервизора и дообучения модели). Пока модель не подключена, работает заглушка по правилам. Только expand.
SET lock_timeout = '5s';

-- Что предложила модель (или заглушка) для обращения: тема и поля карточки.
CREATE TABLE IF NOT EXISTS ai_fill (
  id              uuid PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES conversation (id),
  provider        text        NOT NULL,
  suggested       jsonb       NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES app_user (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Сверено при закрытии или передаче на 2-ю линию: расхождения записаны в ai_correction.
  checked_at      timestamptz
);
CREATE INDEX IF NOT EXISTS ai_fill_conv_idx ON ai_fill (conversation_id, created_at DESC);

-- Исправления оператора: поле, что предложила модель, что осталось; отметка просмотра супервизором.
CREATE TABLE IF NOT EXISTS ai_correction (
  id              uuid PRIMARY KEY,
  fill_id         uuid        NOT NULL REFERENCES ai_fill (id),
  conversation_id uuid        NOT NULL REFERENCES conversation (id),
  field           text        NOT NULL,
  label           text        NOT NULL DEFAULT '',
  suggested       text,
  final           text,
  user_id         uuid REFERENCES app_user (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid REFERENCES app_user (id),
  review_note     text
);
CREATE INDEX IF NOT EXISTS ai_correction_created_idx ON ai_correction (created_at DESC);
