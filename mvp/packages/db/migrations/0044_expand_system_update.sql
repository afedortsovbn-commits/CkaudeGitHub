-- Д-065 (15.10.2026): обновление системы из файла. Администратор загружает файл обновления в интерфейсе, видит
-- перечень изменений и остановки блоков, подтверждает; обновление выполняет служба updater (ops/updater) через
-- ops/release.sh — без остановки обработки обращений, если в файле не сказано иное. Только expand-изменения.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS system_update (
  id             uuid PRIMARY KEY,
  file_name      text        NOT NULL,
  size_bytes     bigint      NOT NULL,
  received_bytes bigint      NOT NULL DEFAULT 0,
  -- uploading → ready | invalid → queued → running → done | failed; cancelled — отменено до начала.
  status         text        NOT NULL DEFAULT 'uploading'
                 CHECK (status IN ('uploading', 'ready', 'invalid', 'queued', 'running', 'done', 'failed', 'cancelled')),
  -- Описание из файла: версия, изменения, затронутые блоки и простои, предупреждения, состав выпуска.
  manifest       jsonb,
  error          text,
  from_version   text,
  uploaded_by    uuid REFERENCES app_user (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_by   uuid REFERENCES app_user (id),
  confirmed_at   timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  -- Текущий шаг и журнал выполнения (пишет служба updater).
  step           text,
  log            text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS system_update_created_idx ON system_update (created_at DESC);
-- Одновременно выполняется не больше одного обновления.
CREATE UNIQUE INDEX IF NOT EXISTS system_update_one_active_uq ON system_update ((true))
  WHERE status IN ('queued', 'running');

-- Служба обновления отмечается раз в несколько секунд: интерфейс показывает, готова ли она.
CREATE TABLE IF NOT EXISTS system_updater (
  id       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  seen_at  timestamptz NOT NULL,
  info     jsonb       NOT NULL DEFAULT '{}'
);
