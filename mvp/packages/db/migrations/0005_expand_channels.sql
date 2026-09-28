-- Ф4: коннекторы каналов (Telegram, email): статус и журнал обмена канала, статус доставки исходящих,
-- канальные метаданные обращения (тема и цепочка писем). Только expand-изменения.
SET lock_timeout = '5s';

-- Состояние экземпляра канала, которое пишет коннектор-владелец (M-CH-07): connected / error / disabled.
ALTER TABLE channel ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE channel ADD COLUMN IF NOT EXISTS status_detail text;
ALTER TABLE channel ADD COLUMN IF NOT EXISTS status_at timestamptz;

-- Журнал обмена канала: входящие/исходящие/служебные записи коннектора (без содержимого сообщений — ПДн).
CREATE TABLE IF NOT EXISTS channel_log (
  id         uuid PRIMARY KEY,
  channel_id uuid        NOT NULL REFERENCES channel (id),
  at         timestamptz NOT NULL DEFAULT now(),
  direction  text        NOT NULL CHECK (direction IN ('in', 'out', 'system')),
  ok         boolean     NOT NULL DEFAULT true,
  summary    text        NOT NULL
);
CREATE INDEX IF NOT EXISTS channel_log_channel_idx ON channel_log (channel_id, at DESC);

-- Доставка исходящего сообщения во внешний канал: pending → sent | failed.
-- Для веб-чата и приложения не заполняется (доставка — через realtime и REST-догрузку).
ALTER TABLE message ADD COLUMN IF NOT EXISTS delivery_status text
  CHECK (delivery_status IS NULL OR delivery_status IN ('pending', 'sent', 'failed'));
ALTER TABLE message ADD COLUMN IF NOT EXISTS delivery_error text;

-- Канальные метаданные обращения: для email — тема и Message-ID последних писем (ответ в ту же цепочку).
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS channel_meta jsonb NOT NULL DEFAULT '{}';
