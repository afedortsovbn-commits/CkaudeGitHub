-- Ф13: отзывы с карт через Rocket Data (M-CH-10) и ежедневная синхронизация справочника объектов (M-ORG-06).
-- Только expand-изменения.
SET lock_timeout = '5s';

-- ---------- Отзывы ----------
-- Отзыв — обращение канала «Отзыв» (channel.kind = 'review', тип уже допустим с Ф2); сведения об отзыве
-- (площадка, оценка, автор, ссылка, точка Rocket Data) — в conversation.channel_meta.review. Индекс — для отчёта
-- по отзывам и поиска обращения по id отзыва.
CREATE INDEX IF NOT EXISTS conversation_review_idx ON conversation (channel_id, (channel_meta #>> '{review,id}'))
  WHERE channel_kind = 'review';
-- Сопоставление точки Rocket Data объекту справочника: service_object.external_ids ->> 'rocketdata'.
CREATE INDEX IF NOT EXISTS service_object_rocketdata_idx ON service_object ((external_ids ->> 'rocketdata'))
  WHERE external_ids ? 'rocketdata';

-- ---------- Синхронизация объектов (M-ORG-06, В-42) ----------
-- Настройки — system_setting `objects.sync` (токен выгрузки — зашифрован SECRETS_KEY). По умолчанию выключено:
-- до подключения источника справочник ведётся вручную и импортом CSV.
INSERT INTO system_setting (key, value) VALUES
  ('objects.sync', '{"enabled": false, "url": null, "format": "json", "token": null, "time": "03:00", "maxDeactivateShare": 0.3}')
ON CONFLICT (key) DO NOTHING;

-- Журнал запусков: кто/что запустило, итог, счётчики и перечень изменений (код объекта, действие, изменённые поля).
CREATE TABLE IF NOT EXISTS object_sync_run (
  id           uuid PRIMARY KEY,
  trigger      text        NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  dry_run      boolean     NOT NULL DEFAULT false,
  started_by   uuid REFERENCES app_user (id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  -- Локальная дата расписания (часовой пояс системы): плановый запуск — не больше одного успешного в день.
  local_date   date,
  total        integer     NOT NULL DEFAULT 0,
  added        integer     NOT NULL DEFAULT 0,
  updated      integer     NOT NULL DEFAULT 0,
  deactivated  integer     NOT NULL DEFAULT 0,
  reactivated  integer     NOT NULL DEFAULT 0,
  skipped      integer     NOT NULL DEFAULT 0,
  error        text,
  changes      jsonb       NOT NULL DEFAULT '[]',
  problems     jsonb       NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS object_sync_run_started_idx ON object_sync_run (started_at DESC);
-- Когда объект последний раз пришёл в выгрузке (для журнала и карточки объекта).
ALTER TABLE service_object ADD COLUMN IF NOT EXISTS synced_at timestamptz;
