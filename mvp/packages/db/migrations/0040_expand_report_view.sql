-- Д-041 (14.10.2026): конструктор отчётов — сохранённые отчёты (поля в строках/столбцах/значениях, фильтры,
-- период, представление). Свои — у автора; общие видят все, у кого есть право «Отчёты». Только expand.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS report_view (
  id         uuid PRIMARY KEY,
  owner_id   uuid        NOT NULL REFERENCES app_user (id),
  name       text        NOT NULL,
  is_shared  boolean     NOT NULL DEFAULT false,
  config     jsonb       NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_view_owner_idx ON report_view (owner_id);
